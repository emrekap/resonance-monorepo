import numpy as np
import pytest

from eval.stats import (
    Interval,
    bootstrap_over_creators,
    paired_uplift,
    paired_wilcoxon,
)


def test_bootstrap_point_estimate_is_the_mean():
    values = {f"c{i}": float(i) for i in range(10)}
    interval = bootstrap_over_creators(values, n_boot=500, seed=0)
    assert interval.point == pytest.approx(4.5)


def test_bootstrap_interval_brackets_the_point():
    values = {f"c{i}": float(i) for i in range(30)}
    interval = bootstrap_over_creators(values, n_boot=1000, seed=0)
    assert interval.lo < interval.point < interval.hi


def test_bootstrap_is_deterministic_for_a_seed():
    values = {f"c{i}": float(i % 7) for i in range(25)}
    a = bootstrap_over_creators(values, n_boot=500, seed=3)
    b = bootstrap_over_creators(values, n_boot=500, seed=3)
    assert (a.point, a.lo, a.hi) == (b.point, b.lo, b.hi)


def test_bootstrap_resamples_creators_not_posts():
    # A single creator cannot produce a non-degenerate interval: resampling one
    # creator with replacement always yields that creator.
    interval = bootstrap_over_creators({"only": 2.0}, n_boot=200, seed=0)
    assert interval.lo == pytest.approx(2.0)
    assert interval.hi == pytest.approx(2.0)


def test_includes_zero_detects_a_straddling_interval():
    assert Interval(point=0.02, lo=-0.05, hi=0.09).includes_zero()
    assert not Interval(point=0.20, lo=0.11, hi=0.29).includes_zero()


def test_includes_zero_is_true_for_an_undefined_interval():
    # A NaN bound means the interval demonstrates nothing, not that it
    # demonstrates lift away from zero. Red-first treats "undefined" the same
    # as "straddles zero" — see the docstring on Interval.includes_zero.
    assert Interval(point=float("nan"), lo=float("nan"), hi=float("nan")).includes_zero()
    assert Interval(point=1.0, lo=float("nan"), hi=2.0).includes_zero()
    assert Interval(point=1.0, lo=0.5, hi=float("nan")).includes_zero()


def test_bootstrap_over_empty_creators_includes_zero():
    # End-to-end path: zero measurable creators (e.g. every creator excluded
    # upstream, as under Task 7's B0 rung) must not read as "no lift, but
    # measured" — it must read as RED under the Red-first verdict rule.
    interval = bootstrap_over_creators({}, n_boot=200, seed=0)
    assert interval.includes_zero()


def test_paired_uplift_uses_only_creators_present_in_both():
    treatment = {"a": 0.5, "b": 0.4, "c": 0.9}
    baseline = {"a": 0.2, "b": 0.4}
    assert paired_uplift(treatment, baseline) == {"a": pytest.approx(0.3), "b": pytest.approx(0.0)}


def test_wilcoxon_finds_a_consistent_difference_significant():
    treatment = {f"c{i}": 0.5 for i in range(20)}
    baseline = {f"c{i}": 0.2 for i in range(20)}
    assert paired_wilcoxon(treatment, baseline) < 0.05


def test_wilcoxon_of_identical_inputs_is_not_significant():
    same = {f"c{i}": 0.3 for i in range(20)}
    assert paired_wilcoxon(same, dict(same)) == pytest.approx(1.0)


def test_wilcoxon_needs_enough_creators():
    assert np.isnan(paired_wilcoxon({"a": 0.5}, {"a": 0.2}))
