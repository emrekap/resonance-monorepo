"""The pipeline, in the order the pre-registration requires.

    load -> split -> assemble features
         -> CONTROLS  -- fail --> VOID, stop, emit nothing further
         -> fit/predict ladder -> metrics -> stats -> verdict -> report

Controls sit BEFORE the ladder because prereg §7 requires them to run before the
primary result is read ("Negative controls, run before reading the primary
result"). Ordering them later would mean computing the number first and deciding
afterwards whether we were allowed to look at it.

Two things the pre-registration leaves open are decided HERE, in code, before
any data exists — which is the only moment at which deciding them is honest:

* **The headline regime.** Prereg §7 says "Splits, both reported" and its §8
  results table has a single unqualified "Verdict (Green / Yellow / Red)" row.
  It never says which regime that verdict comes from. This module commits to
  Regime 1 (new post, known creator) because that is the production case — and
  the report NAMES the regime the band came from, so a Regime-1 Green can never
  be read as a joint result while Regime 2 is Red.
* **The baseline under NaN.** Prereg §5 fixes the baseline as `max(B1, B2)`. A
  rung's rho is NaN when it could not be measured at all, and `max` over a NaN
  is decided by argument ORDER rather than by value (every NaN comparison is
  False, so `max` keeps the first element). The naive
  `max(BASELINE_RUNGS, key=...)` would therefore name an unmeasurable rung "the
  baseline to beat", print that claim in the report, and compute the uplift
  against the absent rung — inflating it exactly when the evidence is weakest.
  `_select_baseline` picks among FINITE rhos only.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np

from eval.controls import run_controls
from eval.extract import (
    FALLBACK_N_DAYS_FOR_PHASE_1,
    PRIMARY_OUTCOME,
    SECONDARY_OUTCOME,
    read_corpus,
    write_corpus_snapshot,
)
from eval.ladder import BASELINE_RUNGS, RUNGS, fit_predict
from eval.metrics import (
    mean_over_creators,
    per_creator_pairwise_accuracy,
    per_creator_spearman,
    per_creator_top1,
)
from eval.normalize import WithinCreatorNormalizer
from eval.report import REPORT_FILE, write_results
from eval.snapshot import Snapshot, load_snapshot
from eval.splits import (
    Split,
    assert_no_creator_overlap,
    assert_time_order,
    regime1_temporal,
    regime2_grouped,
)
from eval.stats import Interval, bootstrap_over_creators, paired_uplift, paired_wilcoxon
from eval.synth import CONTAMINATED_WORLD, NULL_WORLD, SIGNAL_WORLD, write_world
from eval.verdict import VOID, explain, verdict
from eval.zeroshot import zero_shot

#: The two regimes of prereg §7, named. `_evaluate_regime` keys the
#: creator-overlap leakage rule on the split's name — the rule cannot be derived
#: from the data, because Regime 1 legitimately has the same creators on both
#: sides — so these constants exist to give that string one definition, and
#: `test_split_names_match_the_pipelines_constants` pins `splits.py` against
#: them so a drifted name fails a test rather than silently skipping a guard.
REGIME1 = "regime1_temporal"
REGIME2 = "regime2_grouped"

#: The regime whose band becomes the run's headline verdict. Regime 1 is the
#: production case ("score my next post"). The pre-registration does not choose
#: for us (see the module docstring), so the report names this regime beside the
#: band rather than presenting it as a joint result.
HEADLINE_REGIME = REGIME1

WORLDS = {
    "signal": SIGNAL_WORLD,
    "null": NULL_WORLD,
    "contaminated": CONTAMINATED_WORLD,
}

#: GREEN, YELLOW and RED are all legitimate outcomes of a VALID experiment — RED
#: most of all, since prereg §6 commits to an action for it. VOID is different:
#: it means the experiment itself was invalid, so it must not report success to
#: a CI job or a shell script that only reads the exit status.
EXIT_OK = 0
EXIT_VOID = 2


def maturation_from_args(n_days: int, phase: int) -> dict:
    """The maturation block that travels in the manifest.

    `N` comes from `apps/poller` (which computes it and prints it in the weekly
    readiness report), not from a second implementation here — a `N` that could
    be derived two ways is exactly the drift the one-parameter rule exists to
    prevent. The consistency check below is the one thing worth asserting: a
    phase-1 run uses the fallback BY DEFINITION, so a manifest claiming phase 1
    with some other value is a computed number mislabelled as an assumed one.
    """
    if phase not in (1, 2):
        raise ValueError(f"phase must be 1 or 2, got {phase}")
    if phase == 1 and n_days != FALLBACK_N_DAYS_FOR_PHASE_1:
        raise ValueError(
            f"phase 1 uses the fallback N={FALLBACK_N_DAYS_FOR_PHASE_1}, not {n_days} — "
            "if this N was computed, it is phase 2"
        )
    return {"n_days": n_days, "phase": phase}


def _select_baseline(rungs: dict[str, dict[str, float]]) -> str | None:
    """The stronger of B1/B2, chosen among rungs that were actually measurable.

    Returns None when neither rho is finite: there is then no baseline to beat,
    so no uplift exists. The caller carries that through as a NaN uplift, which
    `verdict()` maps to RED by its own unmeasurable rule — deliberately not a
    new band, and deliberately not zero.
    """
    finite = [rung for rung in BASELINE_RUNGS if math.isfinite(rungs[rung]["rho"])]
    if not finite:
        return None
    return max(finite, key=lambda rung: rungs[rung]["rho"])


def _evaluate_regime(snap: Snapshot, split: Split, *, seed: int) -> dict:
    # An unrecognised split name is a hard error, not a shrug. The
    # creator-overlap rule below is selected by name, so a name that drifted
    # (a renamed regime, a hand-built split) would silently stop that assertion
    # running and nothing would fail — the decorative-guard failure this
    # harness exists to prevent.
    if split.name not in (REGIME1, REGIME2):
        raise ValueError(
            f"unknown split name {split.name!r}: expected {REGIME1!r} or {REGIME2!r} "
            "(the creator-overlap leakage rule is keyed on it)"
        )

    # The leakage rules, enforced rather than trusted. `test_end_to_end.py`
    # corrupts a split for each of these three and proves it fires FROM HERE —
    # the assertion functions' own unit tests cannot see whether the pipeline
    # still calls them.
    assert_time_order(snap.posts, split)
    if split.name == REGIME2:
        assert_no_creator_overlap(snap.posts, split)

    normalizer = WithinCreatorNormalizer().fit(snap.posts, split.train)
    normalizer.assert_fit_disjoint_from(split.test)
    y_train = normalizer.transform(snap.posts, split.train)

    y_true = snap.posts["label"].to_numpy()[split.test]

    per_creator: dict[str, dict[str, float]] = {}
    predictions: dict[str, np.ndarray] = {}
    rungs: dict[str, dict[str, float]] = {}
    for rung in RUNGS:
        predictions[rung] = fit_predict(rung, snap, split, y_train)
        rho_by_creator = per_creator_spearman(
            snap.posts, split.test, y_true, predictions[rung]
        )
        per_creator[rung] = rho_by_creator
        interval = bootstrap_over_creators(rho_by_creator, seed=seed)
        rungs[rung] = {"rho": interval.point, "lo": interval.lo, "hi": interval.hi}

    # The baseline to beat is max(B1, B2) among the rungs that were measurable.
    baseline_rung = _select_baseline(rungs)
    if baseline_rung is None:
        # Nothing to beat, so there is no uplift — NaN, which reads as "not
        # measured" in both artifacts and lands on RED in `verdict()`.
        uplift = Interval(point=float("nan"), lo=float("nan"), hi=float("nan"))
        p_value = float("nan")
    else:
        uplift_by_creator = paired_uplift(per_creator["B3"], per_creator[baseline_rung])
        uplift = bootstrap_over_creators(uplift_by_creator, seed=seed)
        p_value = paired_wilcoxon(per_creator["B3"], per_creator[baseline_rung])

    return {
        "rungs": rungs,
        "baseline_rung": baseline_rung,
        # Explicit floats, not the `Interval` dataclass: `report._json_safe`
        # raises on anything it does not recognise, and this is the payload it
        # would raise on.
        "uplift": {"point": uplift.point, "lo": uplift.lo, "hi": uplift.hi},
        "p_value": p_value,
        "pairwise_accuracy": mean_over_creators(
            per_creator_pairwise_accuracy(
                snap.posts, split.test, y_true, predictions["B3"]
            )
        ),
        "top1": mean_over_creators(
            per_creator_top1(snap.posts, split.test, y_true, predictions["B3"])
        ),
        "verdict": verdict(uplift, p_value),
        "explanation": explain(uplift, p_value),
    }


def run(snapshot_dir: Path, out_dir: Path, *, seed: int = 0) -> dict:
    snap = load_snapshot(Path(snapshot_dir))

    # Controls run on Regime 1, which is the regime with a per-creator history
    # to shuffle within.
    gate_split = regime1_temporal(snap.posts)
    controls = run_controls(snap, gate_split, seed=seed)

    payload: dict = {
        "snapshot": snap.manifest,
        "seed": seed,
        "voided": False,
        # Copied from the snapshot, never from an argument — see report.py.
        "analysis": snap.manifest.get("analysis"),
        # Computed on every run and reported whether or not the ladder is. It
        # depends on nothing the controls gate, because nothing is fitted.
        "zero_shot": zero_shot(snap, seed=seed),
        "controls": [
            {
                "name": c.name,
                "passed": c.passed,
                "detail": c.detail,
                "value": c.value,
            }
            for c in controls
        ],
        "regimes": {},
        "verdict": VOID,
        # Which regime the headline band came from. None while there is no
        # headline — a voided run has no band to attribute.
        "verdict_regime": None,
    }

    if not all(c.passed for c in controls):
        payload["voided"] = True
        write_results(Path(out_dir), payload)
        return payload

    regimes = {
        REGIME1: gate_split,
        REGIME2: regime2_grouped(snap.posts, seed=seed),
    }
    for name, split in regimes.items():
        payload["regimes"][name] = _evaluate_regime(snap, split, seed=seed)

    # Regime 1 is the production-mirroring regime, so its band is the headline.
    # ATTRIBUTION FIRST, THEN THE BAND: `verdict_regime` is set, and the band is
    # then read back THROUGH it. Written the other way round -- band from
    # `HEADLINE_REGIME`, attribution assigned separately -- the two are two
    # independent statements about one fact, and a typo in either makes the
    # report attribute a band to a regime it did not come from. That is the
    # exact mis-attribution the headline-naming line exists to prevent,
    # surviving one level up in the code that feeds it. Derived, it cannot
    # happen: there is one lookup, and the label names the key it used.
    payload["verdict_regime"] = HEADLINE_REGIME
    payload["verdict"] = payload["regimes"][payload["verdict_regime"]]["verdict"]
    write_results(Path(out_dir), payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval")
    sub = parser.add_subparsers(dest="command", required=True)

    run_cmd = sub.add_parser("run", help="evaluate a snapshot")
    run_cmd.add_argument("--snapshot", required=True, type=Path)
    run_cmd.add_argument("--out", required=True, type=Path)
    run_cmd.add_argument("--seed", type=int, default=0)

    synth_cmd = sub.add_parser("synth", help="write a synthetic snapshot")
    synth_cmd.add_argument("--world", choices=sorted(WORLDS), default="signal")
    synth_cmd.add_argument("--out", required=True, type=Path)

    extract_cmd = sub.add_parser("extract", help="write a snapshot from the corpus schema")
    extract_cmd.add_argument("--dsn", required=True, help="APP_SERVICE_DATABASE_URL")
    extract_cmd.add_argument("--out", required=True, type=Path)
    extract_cmd.add_argument(
        "--outcome", choices=[PRIMARY_OUTCOME, SECONDARY_OUTCOME], default=PRIMARY_OUTCOME
    )
    extract_cmd.add_argument(
        "--n-days", type=int, required=True, help="the maturation parameter, from the readiness report"
    )
    extract_cmd.add_argument("--phase", type=int, required=True, choices=[1, 2])

    args = parser.parse_args(argv)

    if args.command == "synth":
        write_world(WORLDS[args.world], args.out)
        print(f"wrote {args.world} snapshot to {args.out}")
        return EXIT_OK

    if args.command == "extract":
        from datetime import datetime, timezone

        rows = read_corpus(args.dsn)
        built = write_corpus_snapshot(
            rows,
            args.out,
            outcome=args.outcome,
            maturation=maturation_from_args(args.n_days, args.phase),
            now=datetime.now(timezone.utc),
        )
        print(
            f"wrote {len(built.posts)} posts / {built.posts['creator_id'].nunique()} creators "
            f"to {args.out} — outcome {args.outcome}, exclusions {built.extra['exclusions']}"
        )
        return EXIT_OK

    payload = run(args.snapshot, args.out, seed=args.seed)
    print(f"{payload['verdict']} — see {args.out / REPORT_FILE}")
    # Fail closed, and read BOTH spellings of "void" the way `render_report`
    # does: a payload that carries only one of them is a bug, and the bug must
    # not be the one that turns an invalid run into exit 0.
    if payload["voided"] or payload["verdict"] == VOID:
        return EXIT_VOID
    return EXIT_OK
