import numpy as np
import pandas as pd
import pytest

from eval.controls import (
    _shuffle_labels_within_creator,
    brain_average_control,
    feature_label_leak_control,
    label_shuffle_control,
    run_controls,
)
from eval.snapshot import Snapshot
from eval.splits import Split, regime1_temporal
from eval.synth import CONTAMINATED_WORLD, SIGNAL_WORLD, generate


def _snapshot(world) -> Snapshot:
    posts, text, neuro = generate(world)
    return Snapshot(posts=posts, text=text, neuro=neuro, manifest={})


@pytest.fixture(scope="module")
def clean() -> Snapshot:
    return _snapshot(SIGNAL_WORLD)


@pytest.fixture(scope="module")
def contaminated() -> Snapshot:
    return _snapshot(CONTAMINATED_WORLD)


def test_label_shuffle_passes_on_clean_data(clean):
    split = regime1_temporal(clean.posts)
    result = label_shuffle_control(clean, split, seed=0)
    assert result.passed, result.detail


def test_label_shuffle_passes_even_on_a_contaminated_world(contaminated):
    # The contaminated world copies the label straight into neuro column 0. A
    # label permutation destroys the feature<->label association just as much
    # as it destroys the model's ability to exploit it -- whether or not that
    # association was a real leak -- so B3 on the shuffled labels collapses to
    # chance either way. A permutation test is structurally unable to tell "no
    # leak" apart from "a feature literally is the label"; that leak class is
    # caught by feature_label_leak_control instead (see the tests below). This
    # test exists specifically to stop a future reader from "fixing"
    # label_shuffle_control (e.g. tightening SHUFFLE_TOLERANCE) to try to catch
    # this world -- it can't, by construction, and shouldn't be made to.
    split = regime1_temporal(contaminated.posts)
    result = label_shuffle_control(contaminated, split, seed=0)
    assert result.passed, result.detail


def test_label_shuffle_catches_train_test_overlap(clean):
    # Paired with the test above: together they state label_shuffle_control's
    # actual scope. It cannot catch a feature that *is* the label (that's
    # feature_label_leak_control's job), but it IS a procedural-leak detector,
    # and train/test overlap is the textbook procedural leak. Built by hand,
    # not through regime1_temporal/regime2_grouped -- those functions correctly
    # refuse to ever produce an overlapping split, so the only way to hand the
    # control one is to construct it directly.
    #
    # With `split.test` a subset of `split.train`, B3 is fit on the shuffled
    # labels of those very rows and then scored on them again: it doesn't need
    # to generalise, it just needs to reproduce what it memorised during
    # training. So the shuffled run does NOT collapse to chance, and the
    # control must fire.
    split = regime1_temporal(clean.posts)
    corrupt = Split(name="train_test_overlap", train=split.train, test=split.train)

    result = label_shuffle_control(clean, corrupt, seed=0)
    assert not result.passed
    assert "shuffle" in result.detail.lower()


def test_brain_average_control_fails_to_predict_on_clean_data(clean):
    # Replicating the known negative result: a naive average across neuro
    # dimensions must NOT clear the Green bar.
    split = regime1_temporal(clean.posts)
    result = brain_average_control(clean, split)
    assert result.passed, result.detail
    assert abs(result.value) < 0.10


def test_brain_average_control_fails_closed_when_unmeasurable():
    # Three creators, one train post and one test post each. per_creator_spearman
    # requires >= 2 test positions per creator to compute a rank correlation, so
    # every creator is excluded, per_creator_spearman returns {}, and
    # mean_over_creators({}) is NaN. A gate that "passes" when it cannot even be
    # evaluated is the same flattering-silence failure this harness exists to
    # catch, so this must be a hard fail, not a pass.
    posts = pd.DataFrame(
        {
            "post_id": [f"p{i}" for i in range(6)],
            "creator_id": ["a", "a", "b", "b", "c", "c"],
            "published_at": pd.to_datetime(["2026-01-01"] * 6),
            "label": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
            "view_count": [10_000] * 6,
            "format": "SHORT_FORM",
            "duration_sec": [10.0] * 6,
            "hashtag_count": [1] * 6,
            "published_hour": [12] * 6,
            "published_dow": [1] * 6,
            "follower_count": [1_000.0] * 6,
        }
    )
    neuro = np.random.default_rng(0).normal(size=(6, 4)).astype(np.float32)
    text = np.random.default_rng(1).normal(size=(6, 2)).astype(np.float32)
    snap = Snapshot(posts=posts, text=text, neuro=neuro, manifest={})

    # Positions 0/2/4 ("a","b","c" first post) train; 1/3/5 (their second post)
    # test -- exactly one test row per creator.
    split = Split(name="one_test_per_creator", train=np.array([0, 2, 4]), test=np.array([1, 3, 5]))

    result = brain_average_control(snap, split)
    assert np.isnan(result.value)
    assert result.passed is False


def test_feature_label_leak_control_passes_on_clean_data(clean):
    split = regime1_temporal(clean.posts)
    result = feature_label_leak_control(clean, split)
    assert result.passed, result.detail
    assert result.value < 0.5  # synthetic signal tops out near 0.27, nowhere near the ceiling


def test_feature_label_leak_control_catches_the_contaminated_world(contaminated):
    split = regime1_temporal(contaminated.posts)
    result = feature_label_leak_control(contaminated, split)
    assert not result.passed
    assert result.value == pytest.approx(1.0)
    assert "run is void" in result.detail.lower()


def test_run_controls_returns_one_result_per_control(clean):
    split = regime1_temporal(clean.posts)
    results = run_controls(clean, split, seed=0)
    assert {r.name for r in results} == {"label_shuffle", "brain_average", "feature_label_leak"}


def test_controls_are_deterministic(clean):
    split = regime1_temporal(clean.posts)
    a = label_shuffle_control(clean, split, seed=5)
    b = label_shuffle_control(clean, split, seed=5)
    assert a.value == b.value


def test_shuffle_labels_within_creator_actually_permutes(clean):
    # A silently-no-op shuffle (e.g. dropping the `labels[mask] = own`
    # write-back, since `labels[mask]` is a copy, not a view) would make
    # label_shuffle_control meaningless -- it would always "pass" because it
    # would never actually have broken the feature<->label association.
    posts = clean.posts
    shuffled = _shuffle_labels_within_creator(posts, seed=0)

    original = posts["label"].to_numpy()
    new = shuffled["label"].to_numpy()
    assert not np.array_equal(original, new)

    # And the permutation must stay WITHIN each creator: shuffling across
    # creators would leak one creator's scale into another's B3 fit.
    creators = posts["creator_id"].to_numpy()
    for creator in np.unique(creators):
        mask = creators == creator
        assert sorted(original[mask].tolist()) == sorted(new[mask].tolist())
