"""Splits, and the leakage rules turned into assertions.

The pre-registration's §7 rules are prose. Prose does not enforce itself, and
the failure mode is silent: a leaked normalizer or a shuffled time order
produces a BETTER number, not an error. So each rule is a guard here, and the
test that matters for each is the one that corrupts a split on purpose and
proves the guard fires.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd


class LeakageError(RuntimeError):
    """A split violates one of the pre-registered leakage rules."""


@dataclass(frozen=True)
class Split:
    name: str
    train: np.ndarray  # integer positions into posts
    test: np.ndarray


def regime1_temporal(posts: pd.DataFrame, *, test_fraction: float = 0.2) -> Split:
    """Regime 1 — new post, known creator.

    Per creator, train on the older posts and test on the most recent
    `test_fraction`. Mirrors production ("score my next post") and blocks
    temporal leakage.

    F7: an exact `published_at` TIE straddling the train/test boundary is not
    a leak `assert_time_order` will catch — it uses `latest_train >
    earliest_test`, a strict `>`, so a training post published at the same
    instant as a test post passes. Which tie-mate lands in train vs test is
    then decided by `np.argsort(..., kind="stable")`'s row-order tie-break
    here, not by anything about the posts themselves. Defensible against the
    prose this guards ("never train on a post published *after* the test
    post" — equal is not after), and `synth.py` draws day-granularity dates
    so ties already occur in the synthetic worlds without incident; left as
    `>` deliberately, not tightened to `>=`.
    """
    # `positions[group.index.to_numpy()]` below reads `group.index` as if it
    # already equals row position (0..len(posts)-1) — true only when `posts`
    # carries a clean RangeIndex at the point `.groupby` runs, which THIS line
    # guarantees for every caller, not just the ones that already happen to
    # pass one in (the test fixture, `snapshot.load_snapshot(...).posts`).
    # Do not read `positions = np.arange(len(posts))` below as decoration to
    # strip out along with this line: `positions[x] == x` for any in-range
    # `x`, so that indirection is not independently what makes a permuted
    # frame correct — but the lookup's correctness still depends on THIS
    # reset having already run, and the risk is a maintainer who reads the
    # indirection as dead code and, on that same reasoning, also removes the
    # reset. A permuted-index frame (`posts.iloc[::-1]`, `.sample()`, a join,
    # ...) then silently produces a DIFFERENT, WRONG split — no exception, no
    # warning. `test_regime1_temporal_is_correct_on_a_permuted_index` pins
    # against exactly that; see its docstring for the fuller version of this
    # note.
    posts = posts.reset_index(drop=True)

    train_parts: list[np.ndarray] = []
    test_parts: list[np.ndarray] = []

    positions = np.arange(len(posts))
    for _, group in posts.groupby("creator_id", sort=True):
        ordered = positions[group.index.to_numpy()]
        ordered = ordered[np.argsort(posts["published_at"].to_numpy()[ordered], kind="stable")]
        n_test = max(1, math.ceil(len(ordered) * test_fraction))
        if n_test >= len(ordered):
            n_test = len(ordered) - 1
        train_parts.append(ordered[: len(ordered) - n_test])
        test_parts.append(ordered[len(ordered) - n_test :])

    return Split(
        name="regime1_temporal",
        train=np.sort(np.concatenate(train_parts)),
        test=np.sort(np.concatenate(test_parts)),
    )


def regime2_grouped(
    posts: pd.DataFrame, *, test_fraction: float = 0.2, seed: int = 0
) -> Split:
    """Regime 2 — new creator. Entire creators are held out of training."""
    creators = np.array(sorted(posts["creator_id"].unique()))
    rng = np.random.default_rng(seed)
    n_test = max(1, math.ceil(len(creators) * test_fraction))
    if n_test >= len(creators):
        n_test = len(creators) - 1
    test_creators = set(rng.choice(creators, size=n_test, replace=False).tolist())

    is_test = posts["creator_id"].isin(test_creators).to_numpy()
    positions = np.arange(len(posts))
    return Split(
        name="regime2_grouped",
        train=positions[~is_test],
        test=positions[is_test],
    )


def assert_no_creator_overlap(posts: pd.DataFrame, split: Split) -> None:
    """Prereg §7: no creator appears in both train and test in Regime 2."""
    creators = posts["creator_id"].to_numpy()
    overlap = set(creators[split.train]) & set(creators[split.test])
    if overlap:
        sample = ", ".join(sorted(overlap)[:5])
        raise LeakageError(
            f"{len(overlap)} creator(s) appear in both train and test: {sample}"
        )


def assert_time_order(posts: pd.DataFrame, split: Split) -> None:
    """Prereg §7: never train on a post published after the test post."""
    creators = posts["creator_id"].to_numpy()
    published = posts["published_at"].to_numpy()

    train_by_creator: dict[str, np.ndarray] = {}
    for creator in set(creators[split.train]):
        train_by_creator[creator] = published[split.train][creators[split.train] == creator]

    for creator in set(creators[split.test]):
        if creator not in train_by_creator:
            continue  # held-out creator: Regime 2, nothing to order against
        latest_train = train_by_creator[creator].max()
        earliest_test = published[split.test][creators[split.test] == creator].min()
        if latest_train > earliest_test:
            raise LeakageError(
                f"time order violated for {creator}: a training post "
                f"({latest_train}) post-dates a test post ({earliest_test})"
            )
