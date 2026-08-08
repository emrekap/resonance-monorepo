import numpy as np
import pandas as pd
import pytest

from eval.metrics import (
    mean_over_creators,
    per_creator_pairwise_accuracy,
    per_creator_spearman,
    per_creator_top1,
)


def _posts() -> pd.DataFrame:
    return pd.DataFrame({"creator_id": ["a", "a", "a", "b", "b", "b"]})


def test_perfect_ranking_scores_one_per_creator():
    posts = _posts()
    index = np.arange(6)
    y_true = np.array([1.0, 2.0, 3.0, 10.0, 20.0, 30.0])
    rho = per_creator_spearman(posts, index, y_true, y_true.copy())
    assert rho == {"a": pytest.approx(1.0), "b": pytest.approx(1.0)}


def test_reversed_ranking_scores_minus_one():
    posts = _posts()
    index = np.arange(6)
    y_true = np.array([1.0, 2.0, 3.0, 10.0, 20.0, 30.0])
    rho = per_creator_spearman(posts, index, y_true, -y_true)
    assert rho["a"] == pytest.approx(-1.0)


def test_creator_with_one_test_post_is_excluded_not_zeroed():
    posts = pd.DataFrame({"creator_id": ["a", "a", "b"]})
    index = np.arange(3)
    y_true = np.array([1.0, 2.0, 5.0])
    rho = per_creator_spearman(posts, index, y_true, y_true.copy())
    assert set(rho) == {"a"}  # "b" cannot have a rank correlation


def test_mean_over_creators_averages_creators_not_posts():
    # "a" has many posts and "b" has few; both must count equally.
    assert mean_over_creators({"a": 1.0, "b": 0.0}) == pytest.approx(0.5)


def test_mean_over_creators_of_nothing_is_nan():
    assert np.isnan(mean_over_creators({}))


def test_pairwise_accuracy_counts_correctly_ordered_pairs():
    posts = pd.DataFrame({"creator_id": ["a", "a", "a"]})
    index = np.arange(3)
    y_true = np.array([1.0, 2.0, 3.0])
    # Predictions get one of the three pairs backwards.
    y_pred = np.array([1.0, 3.0, 2.0])
    acc = per_creator_pairwise_accuracy(posts, index, y_true, y_pred)
    assert acc["a"] == pytest.approx(2.0 / 3.0)


def test_top1_is_one_when_the_best_post_is_picked():
    posts = pd.DataFrame({"creator_id": ["a", "a", "a"]})
    index = np.arange(3)
    y_true = np.array([1.0, 5.0, 3.0])
    y_pred = np.array([0.0, 9.0, 1.0])
    assert per_creator_top1(posts, index, y_true, y_pred)["a"] == pytest.approx(1.0)


def test_top1_is_zero_when_the_best_post_is_missed():
    posts = pd.DataFrame({"creator_id": ["a", "a", "a"]})
    index = np.arange(3)
    y_true = np.array([1.0, 5.0, 3.0])
    y_pred = np.array([9.0, 0.0, 1.0])
    assert per_creator_top1(posts, index, y_true, y_pred)["a"] == pytest.approx(0.0)


# --- Investigated behaviours (see task-5-report.md) -------------------------
#
# These are not in the brief's eight, but they are settled, deterministic
# mathematical consequences of `spearmanr` on a constant input, not
# tie-breaking accidents — so locking them in with a test does not paper over
# an ambiguity. Task 7's B0 rung ("creator historical mean") predicts exactly
# one constant per creator, so this is the path every creator takes under B0.


def test_constant_prediction_excludes_the_creator_from_spearman():
    # y_pred has zero variance for creator "a" (spearmanr is undefined for a
    # constant input -> nan -> dropped by the `np.isfinite` filter), even
    # though "a" has 3 test posts, well above the <2 exclusion threshold.
    posts = pd.DataFrame({"creator_id": ["a", "a", "a"]})
    index = np.arange(3)
    y_true = np.array([1.0, 5.0, 3.0])
    y_pred = np.array([7.0, 7.0, 7.0])
    rho = per_creator_spearman(posts, index, y_true, y_pred)
    assert rho == {}


def test_a_whole_constant_prediction_rung_means_to_nan():
    # Every creator predicts its own constant (a B0-shaped rung spanning two
    # creators) -> per_creator_spearman drops both -> mean_over_creators of
    # the empty result is nan, not 0. A caller that means-over-regimes without
    # handling nan explicitly will silently propagate it.
    posts = _posts()
    index = np.arange(6)
    y_true = np.array([1.0, 2.0, 3.0, 10.0, 20.0, 30.0])
    y_pred = np.array([2.0, 2.0, 2.0, 100.0, 100.0, 100.0])
    rho = per_creator_spearman(posts, index, y_true, y_pred)
    assert rho == {}
    assert np.isnan(mean_over_creators(rho))


def test_constant_true_labels_also_exclude_the_creator():
    # The `np.isfinite` filter is wider than "fewer than two test posts": a
    # creator with a constant y_true (no variance to rank against) is equally
    # undefined for spearmanr, and is excluded the same silent way.
    posts = pd.DataFrame({"creator_id": ["a", "a", "a"]})
    index = np.arange(3)
    y_true = np.array([4.0, 4.0, 4.0])
    y_pred = np.array([1.0, 2.0, 3.0])
    rho = per_creator_spearman(posts, index, y_true, y_pred)
    assert rho == {}
