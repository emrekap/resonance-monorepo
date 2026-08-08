import numpy as np
import pandas as pd
import pytest

from eval.splits import (
    LeakageError,
    Split,
    assert_no_creator_overlap,
    assert_time_order,
    regime1_temporal,
    regime2_grouped,
)


def _posts(n_creators: int = 5, per_creator: int = 10) -> pd.DataFrame:
    rows = []
    for c in range(n_creators):
        for i in range(per_creator):
            rows.append(
                {
                    "post_id": f"p{c}_{i}",
                    "creator_id": f"c{c}",
                    "published_at": pd.Timestamp("2026-01-01") + pd.Timedelta(days=i),
                }
            )
    return pd.DataFrame(rows)


def test_regime1_holds_out_the_most_recent_posts_per_creator():
    posts = _posts()
    split = regime1_temporal(posts, test_fraction=0.2)

    assert split.name == "regime1_temporal"
    # Every creator appears on both sides — that is the point of Regime 1.
    assert set(posts["creator_id"]) == set(posts["creator_id"].to_numpy()[split.train])
    assert set(posts["creator_id"]) == set(posts["creator_id"].to_numpy()[split.test])
    assert len(split.test) == 5 * 2  # ceil(10 * 0.2) per creator


def test_regime1_respects_time_order():
    posts = _posts()
    split = regime1_temporal(posts)
    assert_time_order(posts, split)  # must not raise


def test_time_order_guard_fires_on_a_corrupted_split():
    posts = _posts()
    good = regime1_temporal(posts)
    # Swap one train and one test position for the same creator, so a training
    # post now post-dates a test post.
    #
    # train[0]/test[1] rather than train[-1]/test[0]: the split arrays are
    # sorted globally, and creator blocks are contiguous, so the global
    # extremes (train[-1], test[0]) fall in *different* creators (the last
    # and first creator respectively) and swapping them only shifts each
    # creator's train/test boundary by a day without ever reversing order —
    # the guard correctly does not fire on that swap, which proves nothing.
    # train[0] (creator c0's earliest train day) and test[1] (creator c0's
    # latest test day) are both c0's, so swapping them puts c0's newest post
    # in train and its oldest post in test: a genuine violation.
    train = good.train.copy()
    test = good.test.copy()
    train[0], test[1] = test[1], train[0]
    corrupted = Split(name="corrupted", train=train, test=test)

    with pytest.raises(LeakageError, match="time order"):
        assert_time_order(posts, corrupted)


def test_regime2_holds_out_whole_creators():
    posts = _posts()
    split = regime2_grouped(posts, test_fraction=0.2, seed=0)

    assert split.name == "regime2_grouped"
    train_creators = set(posts["creator_id"].to_numpy()[split.train])
    test_creators = set(posts["creator_id"].to_numpy()[split.test])
    assert train_creators.isdisjoint(test_creators)
    assert len(test_creators) == 1  # ceil(5 * 0.2)


def test_regime2_is_deterministic_for_a_seed():
    posts = _posts()
    a = regime2_grouped(posts, seed=3)
    b = regime2_grouped(posts, seed=3)
    np.testing.assert_array_equal(a.test, b.test)


def test_creator_overlap_guard_fires_on_a_corrupted_split():
    posts = _posts()
    good = regime2_grouped(posts, seed=0)
    # Leak one training row of a train-only creator into test.
    corrupted = Split(
        name="corrupted",
        train=good.train,
        test=np.concatenate([good.test, good.train[:1]]),
    )

    with pytest.raises(LeakageError, match="appear in both"):
        assert_no_creator_overlap(posts, corrupted)


def test_every_split_covers_disjoint_positions():
    posts = _posts()
    for split in (regime1_temporal(posts), regime2_grouped(posts, seed=0)):
        assert set(split.train).isdisjoint(set(split.test))
