"""The four worlds, end to end.

The design spec's testing table names four: **Signal** (must return GREEN),
**Null** (must return RED), **Contaminated** (features encode the label — must
VOID the run) and **Leaky** (a deliberately corrupted split — must fire the
matching assertion).

Three of those are properties of the DATA, so `synth.py` builds them. The fourth
is a property of the SPLIT, not the data — so there is deliberately no
`LEAKY_WORLD`, and forcing one into `synth.py` would put it in the wrong place.
The leaky world lives here instead, as splits corrupted by hand.

By hand, and not through `regime1_temporal` / `regime2_grouped`, because those
functions correctly refuse to emit a corrupt split — routing a corruption
through them would test nothing. (Same precedent as `test_controls.py`'s
train/test-overlap fixture.)

And fed to the PIPELINE rather than to the assertion functions directly, which
is the entire point of those three tests: `test_splits.py` and
`test_normalize.py` already prove each assertion fires when it is called.
Nothing proved that `_evaluate_regime` still calls them. Delete all three calls
and — before this file existed — every test in this repo still passed. Each
leaky test therefore pins the MESSAGE of the assertion it targets, and each
corrupt split is built so that only its own assertion can fire, so deleting one
call cannot be masked by another one raising.
"""

import hashlib
import json
import math
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from eval.cli import (
    EXIT_OK,
    EXIT_VOID,
    HEADLINE_REGIME,
    REGIME1,
    REGIME2,
    _evaluate_regime,
    _select_baseline,
    main,
    run,
)
from eval.report import render_report
from eval.snapshot import Snapshot, load_snapshot
from eval.splits import LeakageError, Split, regime1_temporal, regime2_grouped
from eval.synth import CONTAMINATED_WORLD, NULL_WORLD, SIGNAL_WORLD, generate, write_world
from eval.verdict import GREEN, RED, VOID

#: The `research/` package root, so the subprocess reproducibility test can run
#: `python -m eval` with the same working directory a human would.
ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def signal_snapshot(tmp_path_factory):
    path = tmp_path_factory.mktemp("signal")
    write_world(SIGNAL_WORLD, path)
    return path


@pytest.fixture(scope="module")
def null_snapshot(tmp_path_factory):
    path = tmp_path_factory.mktemp("null")
    write_world(NULL_WORLD, path)
    return path


@pytest.fixture(scope="module")
def contaminated_snapshot(tmp_path_factory):
    path = tmp_path_factory.mktemp("contaminated")
    write_world(CONTAMINATED_WORLD, path)
    return path


@pytest.fixture(scope="module")
def signal() -> Snapshot:
    posts, text, neuro = generate(SIGNAL_WORLD)
    return Snapshot(posts=posts, text=text, neuro=neuro, manifest={})


#: A world whose two regimes land on DIFFERENT bands (Regime 1 RED, Regime 2
#: YELLOW), found by sweeping `neuro_effect`. It is a test fixture rather than a
#: fourth `synth` world for the same reason the Leaky splits are: `synth.py`'s
#: three worlds each state a claim about the harness's ANSWER, and this one
#: states a claim about attribution instead.
#:
#: Every other end-to-end fixture agrees across regimes, which is precisely why
#: this one is needed: on an agreeing world, binding the headline to the wrong
#: regime is indistinguishable from binding it to the right one.
DISAGREEING_WORLD = replace(SIGNAL_WORLD, name="disagreeing", neuro_effect=0.40, seed=11)


@pytest.fixture(scope="module")
def disagreeing_snapshot(tmp_path_factory):
    path = tmp_path_factory.mktemp("disagreeing")
    write_world(DISAGREEING_WORLD, path)
    return path


# --- from the brief, Step 1 ------------------------------------------------


def test_signal_world_returns_green(signal_snapshot, tmp_path):
    payload = run(signal_snapshot, tmp_path, seed=0)
    assert payload["verdict"] == GREEN
    assert not payload["voided"]


def test_null_world_returns_red(null_snapshot, tmp_path):
    payload = run(null_snapshot, tmp_path, seed=0)
    assert payload["verdict"] == RED


def test_contaminated_world_voids_the_run(contaminated_snapshot, tmp_path):
    payload = run(contaminated_snapshot, tmp_path, seed=0)
    assert payload["verdict"] == VOID
    assert payload["voided"]
    # The gate is upstream: no primary result is computed at all.
    assert payload["regimes"] == {}


def test_contaminated_world_is_voided_by_the_feature_label_leak_control(
    contaminated_snapshot, tmp_path
):
    # WHICH control fires matters, and it is NOT the one the pre-registration's
    # prose implies. `label_shuffle` PASSES on this world by construction —
    # permuting the label destroys the feature<->label association just as much
    # as it destroys the model's ability to exploit it, so the shuffled run
    # lands at chance whether or not that association was a leak (measured in
    # `test_label_shuffle_passes_even_on_a_contaminated_world`; here it scores
    # -0.080). The control that actually catches this world is
    # `feature_label_leak`, which reads max |rho(feature, label)| over train
    # rows before any model is fit: 0.273 on the clean world, 1.000 here.
    #
    # `brain_average` fails too, and legitimately so rather than by accident:
    # the label was copied into a neuro COLUMN, so it is one of the 32 values
    # the naive across-dimension mean averages, and it dominates them (scale
    # 0-100 against N(0,1)) — the average scores 0.850 where the clean world
    # scores 0.040. Asserting each control by name, not just "something
    # failed", is what keeps these three distinct stories from rotting into one.
    payload = run(contaminated_snapshot, tmp_path, seed=0)
    by_name = {c["name"]: c for c in payload["controls"]}
    assert by_name["feature_label_leak"]["passed"] is False
    assert by_name["feature_label_leak"]["value"] == pytest.approx(1.0)
    assert by_name["brain_average"]["passed"] is False
    assert by_name["label_shuffle"]["passed"] is True


def test_the_null_worlds_controls_all_pass(null_snapshot, tmp_path):
    # The precondition `test_null_world_returns_red` depends on and cannot
    # state for itself: RED is a verdict of a VALID experiment, so if a control
    # fires the run VOIDs and that test stops exercising the RED path entirely
    # while still looking like it does. This is not hypothetical — the null
    # world's original seed (12) tripped `brain_average` at |rho| = 0.130, and
    # the statistic trips the 0.10 ceiling on 24% of zero-signal seeds. See the
    # NULL_WORLD comment in `synth.py`.
    payload = run(null_snapshot, tmp_path, seed=0)
    failed = [c["name"] for c in payload["controls"] if not c["passed"]]
    assert failed == [], f"null world is not a valid experiment: {failed} fired"


def test_run_writes_both_artifacts(signal_snapshot, tmp_path):
    run(signal_snapshot, tmp_path, seed=0)
    assert (tmp_path / "results.json").exists()
    assert (tmp_path / "report.md").exists()


def test_run_reports_both_regimes(signal_snapshot, tmp_path):
    payload = run(signal_snapshot, tmp_path, seed=0)
    assert set(payload["regimes"]) == {REGIME1, REGIME2}


def test_run_is_reproducible_from_the_same_seed(signal_snapshot, tmp_path):
    a = run(signal_snapshot, tmp_path / "a", seed=0)
    b = run(signal_snapshot, tmp_path / "b", seed=0)
    assert json.dumps(a, default=str, sort_keys=True) == json.dumps(
        b, default=str, sort_keys=True
    )


def test_run_writes_a_strictly_parseable_results_json(signal_snapshot, tmp_path):
    # `run` is the payload assembler, and `report._json_safe` RAISES on any
    # value it cannot serialize (a `stats.Interval` dataclass being the live
    # trap) rather than stringifying it. That guard only helps if something
    # actually round-trips a real payload through a strict parse.
    run(signal_snapshot, tmp_path, seed=0)
    loaded = json.loads((tmp_path / "results.json").read_text())
    assert loaded["verdict"] == GREEN
    assert loaded["snapshot"]["producer"] == "synthetic"


def test_baseline_is_the_stronger_of_b1_and_b2(signal_snapshot, tmp_path):
    payload = run(signal_snapshot, tmp_path, seed=0)
    for regime in payload["regimes"].values():
        rungs = regime["rungs"]
        # Both baselines are measurable on the signal world, which is the
        # precondition under which "the stronger of the two" and "the stronger
        # of the FINITE two" are the same rule. The NaN cases where they differ
        # are pinned directly on `_select_baseline` below.
        assert math.isfinite(rungs["B1"]["rho"]) and math.isfinite(rungs["B2"]["rho"])
        stronger = "B1" if rungs["B1"]["rho"] >= rungs["B2"]["rho"] else "B2"
        assert regime["baseline_rung"] == stronger


# --- Defect 2: the baseline must be chosen among FINITE rhos only ----------
#
# `max(BASELINE_RUNGS, key=lambda r: rungs[r]["rho"])` is decided by argument
# ORDER when a rho is NaN, because every NaN comparison is False and `max`
# keeps the first element. Measured before the fix: B1=nan/B2=0.3 named B1 as
# "the baseline to beat". That is not cosmetic — the report then prints a false
# claim, and the uplift is computed against the absent rung, INFLATING it. NaN
# here failed in the direction that flatters the result.


def _rungs(b1: float, b2: float) -> dict[str, dict[str, float]]:
    return {"B1": {"rho": b1}, "B2": {"rho": b2}}


def test_select_baseline_picks_the_stronger_when_both_are_finite():
    assert _select_baseline(_rungs(0.30, 0.10)) == "B1"
    assert _select_baseline(_rungs(0.10, 0.30)) == "B2"


def test_select_baseline_ignores_a_nan_first_rung():
    # The measured failure: `max` kept B1 purely because it came first.
    assert _select_baseline(_rungs(float("nan"), 0.30)) == "B2"


def test_select_baseline_ignores_a_nan_second_rung():
    assert _select_baseline(_rungs(0.30, float("nan"))) == "B1"


def test_select_baseline_returns_none_when_neither_rung_is_measurable():
    # No baseline exists, so there is nothing to beat. Not a fabricated pick,
    # and deliberately not a different verdict band either: the uplift becomes
    # NaN and `verdict()` maps that to RED by its own unmeasurable rule.
    assert _select_baseline(_rungs(float("nan"), float("nan"))) is None


def _tiny_snapshot() -> Snapshot:
    """Three creators, two posts each — every creator has ONE test post.

    `per_creator_spearman` needs two test posts to compute a rank correlation,
    so every creator is excluded from every rung and each rho is NaN. That is
    the shape in which the baseline selection has no finite candidate at all.
    """
    posts = pd.DataFrame(
        {
            "post_id": [f"p{i}" for i in range(6)],
            "creator_id": ["a", "a", "b", "b", "c", "c"],
            "published_at": pd.to_datetime(["2026-01-01"] * 6),
            "label": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
            "view_count": [10_000] * 6,
            "format": "SHORT_FORM",
            "duration_sec": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
            "hashtag_count": [1, 2, 3, 4, 5, 6],
            "published_hour": [12] * 6,
            "published_dow": [1] * 6,
            "follower_count": [1_000.0] * 6,
        }
    )
    neuro = np.random.default_rng(0).normal(size=(6, 4)).astype(np.float32)
    text = np.random.default_rng(1).normal(size=(6, 2)).astype(np.float32)
    return Snapshot(posts=posts, text=text, neuro=neuro, manifest={})


def test_a_regime_with_no_measurable_baseline_is_red_rather_than_a_crash():
    snap = _tiny_snapshot()
    split = Split(name=REGIME1, train=np.array([0, 2, 4]), test=np.array([1, 3, 5]))

    regime = _evaluate_regime(snap, split, seed=0)

    assert regime["baseline_rung"] is None
    assert math.isnan(regime["uplift"]["point"])
    assert regime["verdict"] == RED


def test_the_report_renders_a_missing_baseline_as_n_a():
    snap = _tiny_snapshot()
    split = Split(name=REGIME1, train=np.array([0, 2, 4]), test=np.array([1, 3, 5]))
    payload = {
        "snapshot": {},
        "seed": 0,
        "voided": False,
        "controls": [],
        "regimes": {REGIME1: _evaluate_regime(snap, split, seed=0)},
        "verdict": RED,
        "verdict_regime": REGIME1,
    }

    report = render_report(payload)
    assert "**Baseline to beat:** n/a" in report
    assert "None" not in report


# --- Defect 3: a voided run must not exit 0 --------------------------------
#
# VOID means the experiment itself was invalid. Exiting 0 makes any CI or
# scripted caller read an invalid run as a success — the fail-open class this
# codebase keeps hitting. GREEN/YELLOW/RED all exit 0: they are legitimate
# outcomes of a VALID experiment, and RED in particular is a real result, not
# an error.


def test_main_exits_zero_on_a_valid_run(signal_snapshot, tmp_path, capsys):
    code = main(["run", "--snapshot", str(signal_snapshot), "--out", str(tmp_path)])
    assert code == EXIT_OK
    assert GREEN in capsys.readouterr().out


def test_main_exits_zero_on_red_because_red_is_a_real_result(null_snapshot, tmp_path, capsys):
    code = main(["run", "--snapshot", str(null_snapshot), "--out", str(tmp_path)])
    assert code == EXIT_OK
    assert RED in capsys.readouterr().out


def test_main_exits_non_zero_on_a_voided_run(contaminated_snapshot, tmp_path, capsys):
    code = main(["run", "--snapshot", str(contaminated_snapshot), "--out", str(tmp_path)])
    assert code == EXIT_VOID
    assert code != 0
    assert VOID in capsys.readouterr().out


def test_main_synth_writes_a_loadable_snapshot(tmp_path, capsys):
    code = main(["synth", "--world", "signal", "--out", str(tmp_path / "snap")])
    assert code == EXIT_OK
    assert "signal" in capsys.readouterr().out
    snap = load_snapshot(tmp_path / "snap")
    assert snap.manifest["producer"] == "synthetic"


# --- Defect 4: the headline band must name the regime it came from ---------
#
# Prereg §7 says "Splits, both reported" and §8's results table carries a
# single unqualified "Verdict (Green / Yellow / Red)" row — it never says which
# regime that verdict is. Regime 1 is the right choice (it is the production
# case) but it is the PIPELINE's choice, not the pre-registration's, so the
# artifact must not let a Regime-1 GREEN be read as a joint result while
# Regime 2 is RED.


def test_run_records_which_regime_the_headline_band_came_from(signal_snapshot, tmp_path):
    payload = run(signal_snapshot, tmp_path, seed=0)
    assert payload["verdict_regime"] == HEADLINE_REGIME == REGIME1
    assert payload["verdict"] == payload["regimes"][REGIME1]["verdict"]


def test_report_headline_names_regime1_when_the_regimes_disagree():
    regime = {
        "rungs": {"B1": {"rho": 0.1, "lo": 0.0, "hi": 0.2}},
        "baseline_rung": "B1",
        "uplift": {"point": 0.19, "lo": 0.14, "hi": 0.24},
        "p_value": 0.0001,
        "pairwise_accuracy": 0.68,
        "top1": 0.42,
        "verdict": GREEN,
        "explanation": "GREEN: ...",
    }
    disagreeing = dict(regime, verdict=RED, explanation="RED: ...")
    payload = {
        "snapshot": {},
        "seed": 0,
        "voided": False,
        "controls": [],
        "regimes": {REGIME1: regime, REGIME2: disagreeing},
        "verdict": GREEN,
        "verdict_regime": REGIME1,
    }

    report = render_report(payload)
    headline = next(line for line in report.splitlines() if "Headline band" in line)
    assert REGIME1 in headline
    # Both regimes' own bands are on that line, so a GREEN headline over a RED
    # Regime 2 cannot read as a joint result.
    assert f"`{REGIME1}` {GREEN}" in headline
    assert f"`{REGIME2}` {RED}" in headline
    # The H1 itself is unchanged — `test_report.py` pins it to end with the band.
    assert report.splitlines()[0].endswith(GREEN)


def test_the_written_report_names_the_headline_regime(signal_snapshot, tmp_path):
    run(signal_snapshot, tmp_path, seed=0)
    report = (tmp_path / "report.md").read_text()
    assert f"Headline band from `{REGIME1}`" in report


def test_run_binds_the_headline_band_to_the_regime_it_names(disagreeing_snapshot, tmp_path):
    # Review Important 1. `run` used to make TWO independent statements about
    # one fact -- read the band from `HEADLINE_REGIME`, then separately label it
    # `verdict_regime` -- so a typo in either made the report attribute a band
    # to a regime it did not come from. Measured: swapping the band's lookup to
    # REGIME2 while leaving the label at REGIME1 passed all 154 tests, because
    # every end-to-end fixture had both regimes on the same band, and the
    # render-level disagreement test hand-builds its payload and so cannot see
    # `run`. The band is now DERIVED through `verdict_regime`, so the two cannot
    # disagree by construction; this pins it against a re-introduction.
    payload = run(disagreeing_snapshot, tmp_path, seed=0)
    bands = {name: regime["verdict"] for name, regime in payload["regimes"].items()}

    # Precondition, asserted rather than assumed: on a world whose regimes
    # agree, every assertion below holds no matter which regime the band was
    # taken from, and this test silently stops testing anything.
    assert bands[REGIME1] != bands[REGIME2], f"fixture no longer disagrees: {bands}"

    assert payload["verdict_regime"] == REGIME1
    assert payload["verdict"] == bands[REGIME1]
    assert payload["verdict"] != bands[REGIME2]


# --- Review Important 2: the numbers, not just the bands -------------------
#
# Every other assertion in this file is categorical -- a band, a key set, a
# file that exists. None of them touches a value, and five separate mutations
# inside `_evaluate_regime` each passed the whole suite:
#
#   * uplift computed on B4 instead of B3
#   * Wilcoxon p computed on B4 instead of B3
#   * pairwise accuracy taken from B1's predictions
#   * top-1 taken from B1's predictions
#   * `y_train` taken raw, dropping prereg §7's within-creator normalization
#     from the training target entirely (the normalizer is still fit and its
#     provenance still asserted, so the LEAK guard survives -- whether its
#     output is used does not)
#
# The report would print "**Uplift B3 − baseline:**" over a B4 number with a
# fully green suite. B3 is the treatment; a harness that silently reports B4
# as B3 is the failure this project exists to prevent.
#
# Regenerating these: they are the signal world at seed 0, printed straight out
# of `run`. If a deliberate change to `synth`, `ladder`, `normalize`, `metrics`
# or `stats` moves them, re-read them from a run and update -- but read the
# diff first, because that is the whole point of pinning them.

#: Absolute tolerance. ~450x smaller than the smallest gap this must resolve
#: (B3 0.680 vs B4 0.725 = 0.045), so it discriminates every mutation above by
#: orders of magnitude, while staying loose enough not to fail on last-bit
#: BLAS differences between platforms.
GOLDEN_TOL = 1e-4

GOLDEN = {
    REGIME1: {
        "rungs": {"B1": 0.175, "B2": 0.1625, "B3": 0.68, "B4": 0.725},
        "baseline_rung": "B1",
        "uplift": 0.505,
        "p_value": 4.3000864625495016e-06,
        "pairwise_accuracy": 0.785,
        "top1": 0.675,
    },
    REGIME2: {
        "rungs": {
            "B1": 0.33634615384615385,
            "B2": 0.24413461538461534,
            "B3": 0.7715384615384615,
            "B4": 0.8427884615384615,
        },
        "baseline_rung": "B1",
        "uplift": 0.4351923076923077,
        "p_value": 0.0078125,
        "pairwise_accuracy": 0.79625,
        "top1": 0.5,
    },
}


@pytest.mark.parametrize("regime_name", [REGIME1, REGIME2])
def test_signal_world_recovers_its_known_numbers(signal_snapshot, tmp_path, regime_name):
    payload = run(signal_snapshot, tmp_path, seed=0)
    regime = payload["regimes"][regime_name]
    expected = GOLDEN[regime_name]

    # B0 is the null floor and predicts a constant per creator, so its
    # per-creator Spearman is undefined and the rung is legitimately NaN. Pinned
    # as NaN rather than skipped, so a change that gives B0 a number is caught.
    assert math.isnan(regime["rungs"]["B0"]["rho"])
    for rung, rho in expected["rungs"].items():
        assert regime["rungs"][rung]["rho"] == pytest.approx(rho, abs=GOLDEN_TOL), rung

    assert regime["baseline_rung"] == expected["baseline_rung"]
    # The uplift and p must come from B3 -- the treatment -- not from B4, which
    # is the ceiling rung and scores higher.
    assert regime["uplift"]["point"] == pytest.approx(expected["uplift"], abs=GOLDEN_TOL)
    assert regime["p_value"] == pytest.approx(expected["p_value"], rel=1e-3)
    # The secondary metrics must come from B3's predictions, not any other
    # rung's.
    assert regime["pairwise_accuracy"] == pytest.approx(
        expected["pairwise_accuracy"], abs=GOLDEN_TOL
    )
    assert regime["top1"] == pytest.approx(expected["top1"], abs=GOLDEN_TOL)


def test_the_uplift_is_measured_against_b3_not_the_ceiling_rung(signal_snapshot, tmp_path):
    # A standalone statement of the relation the golden numbers encode, so the
    # intent survives even if the constants above are ever regenerated wrongly:
    # uplift is B3 minus the baseline, and B4 (all three feature families) beats
    # B3, so an uplift silently taken from B4 lands measurably higher.
    payload = run(signal_snapshot, tmp_path, seed=0)
    for regime in payload["regimes"].values():
        rungs = regime["rungs"]
        assert rungs["B4"]["rho"] > rungs["B3"]["rho"]  # the confusable pair
        baseline = rungs[regime["baseline_rung"]]["rho"]
        assert regime["uplift"]["point"] == pytest.approx(
            rungs["B3"]["rho"] - baseline, abs=GOLDEN_TOL
        )


# --- Review gap: a VOID run must still produce its artifacts ---------------


def test_a_voided_run_still_writes_both_artifacts(contaminated_snapshot, tmp_path):
    # `test_run_writes_both_artifacts` covers only the GREEN path, so deleting
    # `write_results` from the void branch survived the whole suite. The VOID
    # report is the one that matters most: it is the only record of WHICH
    # control fired and why, and a void run that writes nothing is
    # indistinguishable from a run that never happened.
    payload = run(contaminated_snapshot, tmp_path, seed=0)
    assert payload["voided"]
    assert (tmp_path / "results.json").exists()
    assert (tmp_path / "report.md").exists()

    report = (tmp_path / "report.md").read_text()
    assert "was not computed" in report
    assert "feature_label_leak" in report  # the failed control is named
    loaded = json.loads((tmp_path / "results.json").read_text())
    assert loaded["verdict"] == VOID


def test_a_voided_report_does_not_name_a_headline_regime():
    # The `not voided` half of the headline line's guard. Task 10's own void
    # tests cannot reach it: their payload fixture has no `verdict_regime` key
    # at all, so the line is skipped by the `and headline_regime` half whether
    # or not the `not voided` half is there -- removing it passed 154/154. This
    # payload sets the key AND voids the run, which is the only shape that
    # separates the two conditions.
    regime = {
        "rungs": {"B3": {"rho": 0.68, "lo": 0.5, "hi": 0.8}},
        "baseline_rung": "B1",
        "uplift": {"point": 0.19, "lo": 0.14, "hi": 0.24},
        "p_value": 0.0001,
        "pairwise_accuracy": 0.68,
        "top1": 0.42,
        "verdict": GREEN,
        "explanation": "GREEN: ...",
    }
    payload = {
        "snapshot": {},
        "seed": 0,
        "voided": True,
        "controls": [{"name": "brain_average", "passed": False, "detail": "x", "value": 0.9}],
        "regimes": {REGIME1: regime},
        "verdict": VOID,
        "verdict_regime": REGIME1,  # set, unlike Task 10's fixture
    }

    report = render_report(payload)
    assert "was not computed" in report
    assert "Headline band" not in report
    assert REGIME1 not in report


def test_the_report_renders_one_p_value_the_same_way_in_both_places(signal_snapshot, tmp_path):
    # The uplift line and the verdict sentence directly beneath it render the
    # SAME number through two different code paths (`report._fmt(..., '.4g')`
    # and `verdict.explain`'s own format spec). Under `explain`'s original
    # `.4f` they disagreed in the artifact a human reads to make the go/no-go
    # call: `p = 4.3e-06` above, `p=0.0000` below. A p that reads as exactly
    # zero is a claim no finite-sample test can make.
    payload = run(signal_snapshot, tmp_path, seed=0)
    report = (tmp_path / "report.md").read_text()

    p_value = payload["regimes"][REGIME1]["p_value"]
    # Precondition: small enough that a `.4f` really would round it to zero.
    assert p_value < 1e-4, p_value
    assert "0.0000" not in report

    # Both renderings present, and identical.
    assert report.count(format(p_value, ".4g")) >= 2


# --- Review gap: --seed must reach everything it is supposed to ------------


def test_the_seed_reaches_the_controls_the_grouped_split_and_the_record(
    signal_snapshot, tmp_path
):
    # Three separate hardcodings of `seed=0` each survived the whole suite: into
    # `run_controls`, into `regime2_grouped`, and into `payload["seed"]`. The
    # last is the record that manifest-reproducibility depends on -- a run whose
    # payload misreports its own seed cannot be reproduced from its artifact.
    # Seed 3, not an arbitrary one: the run seed also seeds `label_shuffle`'s
    # permutation, and that control voids the CLEAN signal world on 4 of the
    # first 20 seeds (values landing at -0.100, -0.102, -0.145, +0.105 against
    # a 0.10 tolerance). Same known, deliberately unfixed calibration issue as
    # `brain_average`'s -- a control that fails closed on a boundary case --
    # but it means a second seed has to be one that leaves the run VALID, or
    # this test measures a voided payload's missing keys instead.
    a = run(signal_snapshot, tmp_path / "a", seed=0)
    b = run(signal_snapshot, tmp_path / "b", seed=3)

    # Precondition, so a future change surfaces as this message rather than as
    # a KeyError on `regimes` further down.
    assert not a["voided"] and not b["voided"], "a seed voided the clean signal world"

    # (1) the record
    assert a["seed"] == 0 and b["seed"] == 3

    # (2) the controls: label-shuffle permutes within creator off this seed
    def shuffle_value(payload: dict) -> float:
        return next(c["value"] for c in payload["controls"] if c["name"] == "label_shuffle")

    assert shuffle_value(a) != shuffle_value(b), "the seed does not reach run_controls"

    # (3) the grouped split: a different seed holds out different creators
    assert (
        a["regimes"][REGIME2]["rungs"]["B3"]["rho"]
        != b["regimes"][REGIME2]["rungs"]["B3"]["rho"]
    ), "the seed does not reach regime2_grouped"

    # And the counterpart that says where it must NOT reach: Regime 1's split is
    # purely temporal and takes no seed, so its point estimates are identical.
    # (Only the bootstrap CI around them moves, which is resampling, not the
    # split.) Without this, hardcoding the seed everywhere would also pass (2).
    assert (
        a["regimes"][REGIME1]["rungs"]["B3"]["rho"]
        == b["regimes"][REGIME1]["rungs"]["B3"]["rho"]
    )
    assert (
        a["regimes"][REGIME1]["rungs"]["B3"]["lo"]
        != b["regimes"][REGIME1]["rungs"]["B3"]["lo"]
    )


# --- Review gap: byte-reproducibility, on the bytes -----------------------


def _sha256(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_two_runs_write_byte_identical_artifacts(signal_snapshot, tmp_path):
    # The Global Constraint is BYTE-reproducibility. The brief's reproducibility
    # test compares `json.dumps(..., default=str, sort_keys=True)` of two
    # in-process payloads: `default=str` tolerates a value that is not
    # serializable at all, `sort_keys=True` tolerates key-order drift, and the
    # written files are never opened. This compares what actually ships.
    run(signal_snapshot, tmp_path / "a", seed=0)
    run(signal_snapshot, tmp_path / "b", seed=0)
    for artifact in ("results.json", "report.md"):
        assert _sha256(tmp_path / "a" / artifact) == _sha256(tmp_path / "b" / artifact), artifact


def test_artifacts_are_identical_across_processes_and_hash_seeds(signal_snapshot, tmp_path):
    # The in-process test above shares one interpreter, so it cannot see
    # anything that varies with PYTHONHASHSEED -- and dict/set iteration order
    # is exactly the kind of thing that reaches an artifact through a `" · "`
    # join or a JSON key order. Two subprocesses with deliberately different
    # hash seeds is the honest form of "reproducible from its manifest".
    digests = []
    for hash_seed in ("0", "12345"):
        out = tmp_path / f"h{hash_seed}"
        env = {**os.environ, "PYTHONHASHSEED": hash_seed}
        proc = subprocess.run(
            [sys.executable, "-m", "eval", "run", "--snapshot", str(signal_snapshot),
             "--out", str(out)],
            cwd=str(ROOT), env=env, capture_output=True, text=True,
        )
        assert proc.returncode == 0, proc.stderr
        digests.append({a: _sha256(out / a) for a in ("results.json", "report.md")})
    assert digests[0] == digests[1]


# --- The Leaky world: corrupt splits, fired from inside the pipeline -------


def _corrupt_time_order(split: Split) -> Split:
    """Regime 1 with train and test swapped.

    Every training post now post-dates a test post for its own creator, which
    is exactly the rule `assert_time_order` enforces. Train and test stay
    DISJOINT, so the normalizer's fit-provenance assertion cannot fire instead
    and mask a deleted time-order check.
    """
    return Split(name=REGIME1, train=split.test, test=split.train)


def _corrupt_creator_overlap(posts: pd.DataFrame, split: Split) -> Split:
    """Regime 2 with one held-out creator's EARLIEST post moved into train.

    That creator now appears on both sides, which is the rule
    `assert_no_creator_overlap` enforces. Its earliest post specifically, so
    the creator's whole test set post-dates its single training post and
    `assert_time_order` — which runs first — still passes. Train and test stay
    disjoint (the post is moved, not copied), so the normalizer assertion
    cannot fire either.
    """
    creators = posts["creator_id"].to_numpy()
    published = posts["published_at"].to_numpy()
    victim = sorted(set(creators[split.test]))[0]
    own = split.test[creators[split.test] == victim]
    moved = own[np.argmin(published[own])]
    return Split(
        name=REGIME2,
        train=np.sort(np.append(split.train, moved)),
        test=split.test[split.test != moved],
    )


def _corrupt_normalizer_provenance(posts: pd.DataFrame, split: Split) -> Split:
    """Regime 1 whose test set is a single row the normalizer was fit on.

    That is the rule `assert_fit_disjoint_from` enforces. The row is one
    creator's LATEST training post, so its creator's `latest_train` equals its
    `earliest_test` and `assert_time_order` — which runs first — passes on the
    `>` comparison. The split is named Regime 1, so the creator-overlap check
    does not run. Only the normalizer assertion can fire.
    """
    creators = posts["creator_id"].to_numpy()
    published = posts["published_at"].to_numpy()
    victim = sorted(set(creators[split.train]))[0]
    own = split.train[creators[split.train] == victim]
    latest = own[np.argmax(published[own])]
    return Split(name=REGIME1, train=split.train, test=np.array([latest]))


def test_the_pipeline_fires_the_time_order_assertion(signal):
    corrupt = _corrupt_time_order(regime1_temporal(signal.posts))
    with pytest.raises(LeakageError, match="time order violated"):
        _evaluate_regime(signal, corrupt, seed=0)


def test_the_pipeline_fires_the_creator_overlap_assertion(signal):
    corrupt = _corrupt_creator_overlap(signal.posts, regime2_grouped(signal.posts, seed=0))
    with pytest.raises(LeakageError, match="appear in both train and test"):
        _evaluate_regime(signal, corrupt, seed=0)


def test_the_pipeline_fires_the_normalizer_fit_provenance_assertion(signal):
    corrupt = _corrupt_normalizer_provenance(signal.posts, regime1_temporal(signal.posts))
    with pytest.raises(LeakageError, match="was fit on 1 row"):
        _evaluate_regime(signal, corrupt, seed=0)


def test_each_corrupt_split_isolates_exactly_one_rule(signal):
    # The three tests above are only meaningful if each corruption trips ONE
    # assertion. If a split tripped two, deleting the call under test would be
    # masked by the other one raising and the test would still pass — the
    # "passes for the wrong reason" failure this file exists to rule out.
    posts = signal.posts
    r1 = regime1_temporal(posts)
    r2 = regime2_grouped(posts, seed=0)

    time_order = _corrupt_time_order(r1)
    assert not set(time_order.train) & set(time_order.test)  # normalizer rule is clean

    overlap = _corrupt_creator_overlap(posts, r2)
    assert not set(overlap.train) & set(overlap.test)  # normalizer rule is clean

    provenance = _corrupt_normalizer_provenance(posts, r1)
    assert set(provenance.train) & set(provenance.test)  # the rule under test
    assert provenance.name == REGIME1  # so the creator-overlap check does not run


# --- The name the creator-overlap rule is keyed on --------------------------
#
# `_evaluate_regime` decides whether to run `assert_no_creator_overlap` from
# `split.name`, because the rule cannot be derived from the data (Regime 1
# legitimately has the same creators on both sides). A drifted name would
# silently stop the assertion running, so the pipeline rejects a name it does
# not recognise, and this pins `splits.py`'s names against the pipeline's
# constants so the drift fails a test instead of a run.


def test_split_names_match_the_pipelines_constants(signal):
    assert regime1_temporal(signal.posts).name == REGIME1
    assert regime2_grouped(signal.posts, seed=0).name == REGIME2


def test_the_pipeline_rejects_an_unrecognised_split_name(signal):
    split = regime1_temporal(signal.posts)
    renamed = Split(name="regime1_temporal_v2", train=split.train, test=split.test)
    with pytest.raises(ValueError, match="unknown split name"):
        _evaluate_regime(signal, renamed, seed=0)
