import numpy as np
import pytest

from eval.ladder import RUNGS, features_for, fit_predict
from eval.metrics import per_creator_spearman
from eval.normalize import WithinCreatorNormalizer
from eval.snapshot import Snapshot
from eval.splits import regime1_temporal, regime2_grouped
from eval.synth import SIGNAL_WORLD, generate


@pytest.fixture(scope="module")
def snap() -> Snapshot:
    posts, text, neuro = generate(SIGNAL_WORLD)
    return Snapshot(posts=posts, text=text, neuro=neuro, manifest={})


def test_every_rung_predicts_one_value_per_test_row(snap):
    split = regime1_temporal(snap.posts)
    y_train = WithinCreatorNormalizer().fit(snap.posts, split.train).transform(
        snap.posts, split.train
    )
    for rung in RUNGS:
        predictions = fit_predict(rung, snap, split, y_train)
        assert predictions.shape == (len(split.test),)
        assert np.isfinite(predictions).all()


def test_b0_predicts_a_constant_per_creator(snap):
    split = regime1_temporal(snap.posts)
    y_train = WithinCreatorNormalizer().fit(snap.posts, split.train).transform(
        snap.posts, split.train
    )
    predictions = fit_predict("B0", snap, split, y_train)
    creators = snap.posts["creator_id"].to_numpy()[split.test]
    for creator in np.unique(creators):
        own = predictions[creators == creator]
        assert np.allclose(own, own[0])


def test_b0_survives_a_cold_start_creator(snap):
    split = regime2_grouped(snap.posts, seed=0)
    y_train = WithinCreatorNormalizer().fit(snap.posts, split.train).transform(
        snap.posts, split.train
    )
    predictions = fit_predict("B0", snap, split, y_train)
    assert np.isfinite(predictions).all()


def test_features_for_selects_the_right_matrix(snap):
    assert features_for("B0", snap) is None
    assert features_for("B1", snap).shape[1] == 5
    assert features_for("B2", snap).shape[1] == snap.text.shape[1]
    assert features_for("B3", snap).shape[1] == snap.neuro.shape[1]
    assert features_for("B4", snap).shape[1] == 5 + snap.text.shape[1] + snap.neuro.shape[1]


def test_unknown_rung_is_an_error(snap):
    split = regime1_temporal(snap.posts)
    y_train = np.zeros(len(split.train))
    with pytest.raises(ValueError, match="unknown rung"):
        fit_predict("B9", snap, split, y_train)


def test_fit_predict_is_deterministic(snap):
    split = regime1_temporal(snap.posts)
    y_train = WithinCreatorNormalizer().fit(snap.posts, split.train).transform(
        snap.posts, split.train
    )
    a = fit_predict("B3", snap, split, y_train)
    b = fit_predict("B3", snap, split, y_train)
    np.testing.assert_array_equal(a, b)


def test_b0_has_no_within_creator_rank_signal(snap):
    """B0 predicts one constant per creator, so within any single creator its
    predictions have zero variance. A Spearman rank correlation is undefined
    over a constant array, so `per_creator_spearman` excludes every creator
    (see its docstring / `eval.metrics`) and returns `{}` — not a bug to fix
    here, but the contract this rung is expected to have, pinned so later
    tasks that consume the ladder can rely on it and handle a NaN rung
    (`mean_over_creators({})` is `nan`) rather than special-case B0.
    """
    split = regime1_temporal(snap.posts)
    normalizer = WithinCreatorNormalizer().fit(snap.posts, split.train)
    y_train = normalizer.transform(snap.posts, split.train)
    y_test_true = normalizer.transform(snap.posts, split.test)

    predictions = fit_predict("B0", snap, split, y_train)

    result = per_creator_spearman(snap.posts, split.test, y_test_true, predictions)
    assert result == {}


def test_fit_predict_rejects_mismatched_y_train_length(snap):
    """B0 is the rung that actually needs this guard: it masks `y_train` with a
    boolean array built from `split.train`, so a length mismatch there raises a
    confusing `IndexError` deep inside a comprehension rather than a named
    error at the boundary. (B1-B4 would eventually get a `ValueError` out of
    sklearn's own shape check regardless of this guard, which is why this test
    deliberately exercises B0, not B1 — a B1 case would pass even with the
    guard deleted, for the wrong reason.)
    """
    split = regime1_temporal(snap.posts)
    y_train = WithinCreatorNormalizer().fit(snap.posts, split.train).transform(
        snap.posts, split.train
    )
    with pytest.raises(ValueError, match="y_train has"):
        fit_predict("B0", snap, split, y_train[:-1])
