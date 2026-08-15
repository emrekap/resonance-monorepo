"""The diligence artifact: results.json plus a one-page Markdown report.

The report renders whatever `verdict.py` decided. There is no path here that
lets a human choose a different headline, which is the point -- which is also
why `render_report` treats `payload["voided"]` and `payload["verdict"] ==
VOID` as two spellings of one fact rather than two independent switches: a
payload that sets only one (or, worse, neither -- an omitted `verdict` key)
must not let the header and the body disagree about whether this run is void.

`results.json` is handed to whoever is doing diligence, so it must parse as
JSON *everywhere* -- not just in Python. Plain `json.dumps` emits bare
`NaN`/`Infinity` tokens, which `json.loads` accepts (a CPython leniency) but
`jq`, JavaScript `JSON.parse`, and most other parsers reject outright. NaN is
not a corner case here, either: B0's rung legitimately produces
`mean_over_creators({}) == nan` (see `metrics.py`), and every field of a VOID
run's uplift is NaN throughout -- so the artifact is unparseable exactly when
the run is most worth reading closely. `_json_safe` walks the payload and
turns every non-finite float into JSON `null` (which reads as "not measured",
exactly what it means) and every numpy scalar into the native type it already
prints as, so a payload-assembly bug surfaces as a loud `TypeError` instead of
a plausible-looking quoted string in the artifact.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from eval.verdict import VOID

RESULTS_FILE = "results.json"
REPORT_FILE = "report.md"


def _json_safe(value):
    """Recursively convert `value` into something `json.dumps` serializes everywhere.

    Two conversions, done together because both come from the same source --
    numpy-derived values flowing into a payload meant for `json.dumps`:

    1. Non-finite floats (NaN, +-inf) become JSON `null`. `allow_nan=False`
       would be the obvious alternative, but it *raises* on a legitimate VOID
       or cold-start run instead of letting it produce its artifact -- exactly
       the run this harness most needs to be able to report on.
    2. numpy scalars become native Python types. `np.float64` is a `float`
       subclass so it already survives a plain `json.dumps`; `np.int64` and
       `np.bool_` are NOT `int`/`bool` subclasses, so they need converting by
       hand or they silently become the wrong JSON type (see
       `test_write_results_round_trips_numpy_scalars_as_real_json_types`).

    Anything left over that still isn't one of dict/list/tuple/ndarray/numpy
    scalar/str/int/bool/float/None is a bug in whoever assembled the payload
    (Task 11) -- this raises `TypeError` rather than stringifying it, so that
    bug is loud instead of a plausible-looking string in the artifact.
    """
    if isinstance(value, dict):
        return {key: _json_safe(v) for key, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, np.ndarray):
        # `.tolist()` on a 0-d array returns a bare scalar, not a length-1
        # list -- iterating that scalar (the previous `for v in value.tolist()`
        # form) raised "'float' object is not iterable". Recursing on the
        # `.tolist()` result directly, instead of comprehending over it,
        # handles 0-d/1-d/n-d uniformly: a scalar falls into the float/int/
        # bool branches below, a (nested) list falls into the list branch
        # above.
        return _json_safe(value.tolist())
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        value = float(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (bool, int, str)) or value is None:
        return value
    raise TypeError(
        f"payload value of type {type(value).__name__} is not JSON-serializable: {value!r}"
    )


def _fmt(value, spec: str = ".3f") -> str:
    """Format a number, or "n/a" when it is missing or not finite.

    NaN is a legitimate payload value, not an error (see module docstring and
    `stats.Interval.includes_zero`'s NaN-bound handling) -- so this never
    raises on one. Rendering the literal `nan` would read as a crash; `n/a`
    reads as what it actually is: not measured. Also accepts numpy scalars
    (`float()` converts them) so callers don't need to convert first.
    """
    try:
        value = float(value)
    except (TypeError, ValueError):
        return "n/a"
    if not math.isfinite(value):
        return "n/a"
    return format(value, spec)


def _rung_table(rungs: dict) -> list[str]:
    lines = [
        "| Rung | within-creator rho | 95% CI |",
        "| ---- | ------------------ | ------ |",
    ]
    for name, values in rungs.items():
        lines.append(
            f"| {name} | {_fmt(values['rho'])} | "
            f"[{_fmt(values['lo'])}, {_fmt(values['hi'])}] |"
        )
    return lines


def render_report(payload: dict) -> str:
    # `voided` and `verdict == VOID` are two representations of one fact, and
    # a payload assembled under a bug (or one that simply omits `verdict`)
    # can set only one of them. Computing a single `voided` bool up front --
    # rather than gating the header on `payload["verdict"]` and the
    # early-return below on `payload["voided"]` separately -- means the two
    # can never disagree: whichever key says VOID wins, and the header can
    # never promise a headline the body doesn't render (or vice versa). This
    # does not raise on disagreement: a malformed payload still gets an
    # artifact, just one that reads VOID.
    voided = bool(payload.get("voided")) or payload.get("verdict", VOID) == VOID
    band = VOID if voided else payload["verdict"]
    # A snapshot may declare what analysis it IS. The corpus backtest is a
    # secondary exploratory analysis against a different label from the
    # pre-registered one (corpus spec §1a) — and the declaration rides on the
    # snapshot's manifest rather than a command-line flag on purpose, so there
    # is no invocation that produces a prereg-titled report from corpus data.
    analysis = payload.get("analysis") or {}
    title = analysis.get("title", "Validation result")
    lines: list[str] = [
        f"# {title} — {band}",
        "",
    ]
    if analysis.get("note"):
        lines += [analysis["note"], ""]
    # Name the regime the band came from. The pre-registration reports both
    # splits (§7 "Splits, both reported") but its §8 results table has a single
    # unqualified "Verdict" row -- it never says which regime that verdict is.
    # The choice is therefore the pipeline's (`cli.HEADLINE_REGIME`), and an
    # unnamed band would let a Regime-1 GREEN read as a joint result while
    # Regime 2 is RED. Each regime's own band goes on the same line so the two
    # cannot be conflated. Suppressed on a voided run, which has no headline to
    # attribute and must name no regime at all (see the void branch below).
    headline_regime = payload.get("verdict_regime")
    if not voided and headline_regime:
        per_regime = " · ".join(
            f"`{name}` {regime.get('verdict', '?')}"
            for name, regime in payload.get("regimes", {}).items()
        )
        lines += [
            f"Headline band from `{headline_regime}` — the production case "
            f"(new post, known creator). Per regime: {per_regime}. The band above "
            "is that regime's alone, not a joint result.",
            "",
        ]
    lines += [
        f"Snapshot: `{payload['snapshot'].get('producer', 'unknown')}` · "
        f"{payload['snapshot'].get('rows', '?')} posts · "
        f"{payload['snapshot'].get('creators', '?')} creators · seed {payload.get('seed')}",
        "",
        "## Negative controls",
        "",
    ]
    for control in payload.get("controls", []):
        mark = "PASS" if control["passed"] else "FAIL"
        lines.append(f"- **{control['name']}** — {mark}. {control['detail']}")

    if voided:
        # Stop here, unconditionally -- even if `regimes` was already computed
        # (a pipeline can build a regime's numbers and only THEN have a
        # control fail). Rendering them below would leak a headline number
        # into a report titled VOID, the exact thing this branch exists to
        # prevent. See test_voided_report_with_regimes_hides_the_uplift_and_
        # regime_section for the case with non-empty `regimes`.
        lines += [
            "",
            "## VOID",
            "",
            "A negative control failed, so the primary result was not computed. "
            "Per the pre-registration the run is void until the cause is found.",
            "",
        ]
        return "\n".join(lines) + "\n"

    for name, regime in payload.get("regimes", {}).items():
        lines += [
            "",
            f"## {name}",
            "",
            *_rung_table(regime["rungs"]),
            "",
            # `baseline_rung` is None when neither B1 nor B2 was measurable
            # (see `cli._select_baseline`) -- render that as "n/a", the same
            # way `_fmt` renders an unmeasured number, rather than the literal
            # "None", which reads like a rung name.
            f"**Baseline to beat:** {regime['baseline_rung'] or 'n/a'} (max of B1, B2)",
            "",
            f"**Uplift B3 − baseline:** {_fmt(regime['uplift']['point'])} "
            f"[{_fmt(regime['uplift']['lo'])}, {_fmt(regime['uplift']['hi'])}], "
            f"p = {_fmt(regime['p_value'], '.4g')}",
            "",
            f"**Pairwise accuracy (secondary):** {_fmt(regime['pairwise_accuracy'])} · "
            f"**Top-1:** {_fmt(regime['top1'])}",
            "",
            f"**Verdict:** {regime['explanation']}",
        ]

    return "\n".join(lines) + "\n"


def write_results(out_dir: Path, payload: dict) -> None:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Compute BOTH outputs before writing either. `out_dir` can be a re-used
    # directory from a previous run: writing results.json first and only then
    # rendering the Markdown means a failure partway through `render_report`
    # leaves a FRESH results.json beside a STALE report.md -- a mismatched
    # pair, not a clearly-stale one. Building both strings first means a
    # failure in either leaves the previous run's pair untouched instead.
    report_text = render_report(payload)
    results_text = json.dumps(_json_safe(payload), indent=2) + "\n"
    (out_dir / RESULTS_FILE).write_text(results_text)
    (out_dir / REPORT_FILE).write_text(report_text)
