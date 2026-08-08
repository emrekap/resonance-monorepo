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


# --- Fix round 1: tie-invariance for pairwise accuracy and top-1 ------------
#
# Reviewer-confirmed defect: with the original strict `>` comparisons, a
# constant `y_pred` (Task 7's B0 baseline predicts exactly one constant per
# creator, so this is B0's common case, not a corner) made
# `per_creator_pairwise_accuracy` and `per_creator_top1` range over the
# entire [0, 1] interval depending purely on the row order `y_true`/`y_pred`
# happened to be listed in — not a property of the data. Fixed by half
# credit on a predicted tie (pairwise accuracy, the standard AUC/Kendall's
# tau-b convention) and by expected value under uniform random tie-breaking
# among the predicted-max-tied posts (top-1). Both are order-invariant by
# construction: neither computation depends on which position within a tied
# group comes first.


def test_pairwise_accuracy_constant_prediction_is_half_and_order_invariant():
    posts = pd.DataFrame({"creator_id": ["a", "a", "a", "a"]})
    index = np.arange(4)
    y_pred = np.full(4, 7.0)  # constant prediction -> every pair is tied

    forward = np.array([1.0, 5.0, 3.0, 9.0])
    reversed_ = forward[::-1].copy()

    acc_forward = per_creator_pairwise_accuracy(posts, index, forward, y_pred)["a"]
    acc_reversed = per_creator_pairwise_accuracy(posts, index, reversed_, y_pred)["a"]

    # Every one of the C(4, 2) = 6 pairs is tied in y_pred and scores exactly
    # 0.5, regardless of what y_true says or what order it is listed in.
    assert acc_forward == pytest.approx(0.5)
    assert acc_reversed == pytest.approx(0.5)
    assert acc_forward == pytest.approx(acc_reversed)


def test_pairwise_accuracy_with_a_partial_tie_hits_the_worked_fraction():
    # positions 0,1,2,3 — y_pred ties (0, 1) at 1.0 and leaves 2, 3 distinct.
    posts = pd.DataFrame({"creator_id": ["a", "a", "a", "a"]})
    index = np.arange(4)
    y_true = np.array([10.0, 20.0, 30.0, 40.0])  # strictly increasing
    y_pred = np.array([1.0, 1.0, 5.0, 2.0])

    # By hand, over all C(4, 2) = 6 pairs (all true-distinct, so none skipped):
    #   (0,1): y_pred tied            -> 0.5
    #   (0,2): true 10<30, pred 1<5   -> both "j is higher"  -> correct: 1
    #   (0,3): true 10<40, pred 1<2   -> both "j is higher"  -> correct: 1
    #   (1,2): true 20<30, pred 1<5   -> both "j is higher"  -> correct: 1
    #   (1,3): true 20<40, pred 1<2   -> both "j is higher"  -> correct: 1
    #   (2,3): true 30<40, pred 5>2   -> disagree             -> correct: 0
    # sum = 0.5 + 1 + 1 + 1 + 1 + 0 = 4.5, total = 6, accuracy = 4.5 / 6 = 0.75
    acc = per_creator_pairwise_accuracy(posts, index, y_true, y_pred)
    assert acc["a"] == pytest.approx(4.5 / 6)


def test_top1_constant_prediction_is_one_over_n_and_order_invariant():
    posts = pd.DataFrame({"creator_id": ["a", "a", "a", "a"]})
    index = np.arange(4)
    y_pred = np.full(4, 7.0)  # constant prediction -> all 4 posts tied at max

    forward = np.array([1.0, 5.0, 3.0, 9.0])  # exactly one post (9.0) is best
    reversed_ = forward[::-1].copy()

    top1_forward = per_creator_top1(posts, index, forward, y_pred)["a"]
    top1_reversed = per_creator_top1(posts, index, reversed_, y_pred)["a"]

    # 1 actual-best post out of 4 tied-at-max posts -> expected score 1/4,
    # regardless of which row the best post happens to occupy.
    assert top1_forward == pytest.approx(1.0 / 4.0)
    assert top1_reversed == pytest.approx(1.0 / 4.0)
    assert top1_forward == pytest.approx(top1_reversed)


def test_top1_unique_predicted_max_is_still_a_strict_zero_or_one():
    # Same fixtures as the brief's own top-1 tests: the predicted max is
    # unique in both, so the tied-set-of-one reduces exactly to the old
    # hit/miss indicator — this is what "strict generalisation" means.
    posts = pd.DataFrame({"creator_id": ["a", "a", "a"]})
    index = np.arange(3)
    y_true = np.array([1.0, 5.0, 3.0])

    hit = per_creator_top1(posts, index, y_true, np.array([0.0, 9.0, 1.0]))["a"]
    miss = per_creator_top1(posts, index, y_true, np.array([9.0, 0.0, 1.0]))["a"]

    assert hit == pytest.approx(1.0)
    assert miss == pytest.approx(0.0)
