import numpy as np
import pandas as pd
import pytest

from eval.normalize import WithinCreatorNormalizer
from eval.splits import LeakageError


def _posts() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "creator_id": ["a"] * 5 + ["b"] * 5,
            "label": [10.0, 20.0, 30.0, 40.0, 50.0, 100.0, 200.0, 300.0, 400.0, 500.0],
        }
    )


def test_z_scores_within_each_creator():
    posts = _posts()
    index = np.arange(10)
    z = WithinCreatorNormalizer().fit(posts, index).transform(posts, index)

    # Each creator's own rows are centred on that creator, not on the pool.
    assert abs(float(z[:5].mean())) < 1e-9
    assert abs(float(z[5:].mean())) < 1e-9
    # Both creators' top post maps to the same z despite 10x different scale.
    assert z[4] == pytest.approx(z[9])


def test_unseen_creator_falls_back_to_global_statistics():
    posts = _posts()
    normalizer = WithinCreatorNormalizer().fit(posts, np.arange(5))  # creator "a" only
    z = normalizer.transform(posts, np.arange(5, 10))  # creator "b", cold start
    assert np.isfinite(z).all()


def test_fit_provenance_guard_fires_when_fit_touched_test_rows():
    posts = _posts()
    train = np.arange(0, 8)
    test = np.arange(6, 10)  # deliberately overlaps train
    normalizer = WithinCreatorNormalizer().fit(posts, train)

    with pytest.raises(LeakageError, match="fit on 2 row"):
        normalizer.assert_fit_disjoint_from(test)


def test_fit_provenance_guard_passes_on_a_clean_split():
    posts = _posts()
    normalizer = WithinCreatorNormalizer().fit(posts, np.arange(0, 7))
    normalizer.assert_fit_disjoint_from(np.arange(7, 10))  # must not raise


def test_transform_before_fit_is_an_error():
    posts = _posts()
    with pytest.raises(RuntimeError, match="not fitted"):
        WithinCreatorNormalizer().transform(posts, np.arange(3))


def test_zero_variance_creator_does_not_produce_nan():
    posts = pd.DataFrame({"creator_id": ["a"] * 4, "label": [7.0, 7.0, 7.0, 7.0]})
    index = np.arange(4)
    z = WithinCreatorNormalizer().fit(posts, index).transform(posts, index)
    assert np.isfinite(z).all()
    assert np.allclose(z, 0.0)


def test_transform_guard_fires_on_a_reordered_frame():
    # The dangerous corruption, and the one a length check structurally cannot
    # see: same length, same rows, reversed order. `test = [7, 8, 9]` is still
    # in-bounds for the 10-row reversed frame, so this does not raise
    # IndexError on its own — without a content/order fingerprint it would
    # silently normalize row 7 of the reversed frame (which is row 2's data)
    # against creator "a"'s statistics from the *original* frame's row 7.
    posts = _posts()
    train = np.arange(0, 7)
    test = np.arange(7, 10)
    normalizer = WithinCreatorNormalizer().fit(posts, train)

    reordered = posts.iloc[::-1].reset_index(drop=True)
    with pytest.raises(LeakageError, match="does not match"):
        normalizer.transform(reordered, test)


def test_transform_guard_fires_on_a_resliced_frame():
    # The weaker corruption: a re-sliced, differently-sized frame. Kept as a
    # companion case — the fingerprint subsumes a plain length check, so this
    # still raises LeakageError, but (unlike the reordered case above) an
    # out-of-bounds position would have raised *something* even without the
    # guard.
    posts = _posts()
    train = np.arange(0, 7)
    test = np.arange(7, 10)
    normalizer = WithinCreatorNormalizer().fit(posts, train)

    resliced = posts.iloc[test].reset_index(drop=True)
    with pytest.raises(LeakageError, match="does not match"):
        normalizer.transform(resliced, test)


def test_transform_frame_fingerprint_guard_passes_on_matching_frame():
    posts = _posts()
    normalizer = WithinCreatorNormalizer().fit(posts, np.arange(0, 7))
    z = normalizer.transform(posts, np.arange(7, 10))  # same frame: the correct convention
    assert np.isfinite(z).all()
