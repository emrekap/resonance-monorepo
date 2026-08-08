"""Within-creator label normalisation, with the fit provenance recorded.

Prereg §7: "Within-creator normalization statistics are fit on train only and
applied to test." Fitting them on everything leaks the outcome distribution and
makes the number BETTER, which is why the rule needs a guard rather than a
convention. This class records the exact row positions its statistics came from,
so `assert_fit_disjoint_from` can prove they never saw test.
"""

from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd

from eval.splits import LeakageError


def _fingerprint(posts: pd.DataFrame) -> bytes:
    """A stable, order- and content-sensitive fingerprint of the columns this
    class reads (`creator_id`, `label`) across the *whole* frame.

    A length check is not enough: a frame with the same length, the same
    rows, but a different row order leaves every stored position in-bounds
    while silently pointing at a different row — `fit`'s position `7` and
    `transform`'s position `7` no longer name the same post. That produces
    wrong z-scores with no exception, which is worse than the noisy
    `IndexError` a length mismatch happens to raise today. A fingerprint over
    row content, in row order, catches both: different length changes it,
    and reordering rows (even within one creator, where `creator_id` alone
    would look unchanged) changes it too, because it depends on which value
    sits at which position, not just which values are present.

    `pd.util.hash_pandas_object` returns one `uint64` per row, and that hash
    is a function of both the row's content and its position — reordering
    two rows swaps which hash lands at which index. Folding that array down
    to a single digest with `hashlib.sha256` over its raw bytes is safe
    *because* the array's dtype is `uint64`, a fixed-width number: `.tobytes()`
    on a numeric array reads its actual values. That would NOT be safe on an
    object-dtype array (e.g. hashing `creators.tobytes()` directly) — an
    object array's buffer holds pointers, not content, so `.tobytes()` there
    hashes memory addresses instead of the data they point to.
    """
    row_hashes = pd.util.hash_pandas_object(posts[["creator_id", "label"]], index=False)
    return hashlib.sha256(row_hashes.to_numpy().tobytes()).digest()


class WithinCreatorNormalizer:
    """Z-scores the label within each creator, using train rows only.

    Calling convention: `fit` and `transform` both take the *whole, unsliced*
    `posts` DataFrame plus integer positions into it (the same convention as
    `Split.train` / `Split.test` in `eval.splits`) — never a pre-sliced subset
    with positions renumbered from zero. `assert_fit_disjoint_from` compares
    raw integer positions recorded by `fit` against a caller-supplied `index`;
    that comparison is only meaningful when both sides share the same
    coordinate system, i.e. positions into the same, full `posts` frame.
    `transform` enforces its half of that contract at runtime by fingerprinting
    `posts[["creator_id", "label"]]` (see `_fingerprint`) and refusing to run
    against a frame whose content or row order differs from the one `fit` saw.
    """

    def __init__(self) -> None:
        self._stats: dict[str, tuple[float, float]] = {}
        self._global: tuple[float, float] | None = None
        self._fit_positions: frozenset[int] | None = None
        self._fit_fingerprint: bytes | None = None

    def fit(self, posts: pd.DataFrame, index: np.ndarray) -> "WithinCreatorNormalizer":
        """Fit mean/std per creator (and globally) on `posts.iloc[index]` only.

        `index` must be integer positions into the full `posts` frame (see
        class docstring) — the positions recorded here are later compared
        raw, in `assert_fit_disjoint_from`, against test positions in that
        same frame. A fingerprint of `posts` (see `_fingerprint`) is recorded
        too, so `transform` can catch a caller that comes back with a frame
        whose content or row order has changed — same-length-but-reordered
        included, which a length check alone cannot see, because reordered
        positions stay in-bounds while pointing at different rows.
        """
        index = np.asarray(index)
        self._fit_positions = frozenset(int(i) for i in index)
        self._fit_fingerprint = _fingerprint(posts)

        labels = posts["label"].to_numpy()[index]
        creators = posts["creator_id"].to_numpy()[index]

        self._global = (float(labels.mean()), float(labels.std()) or 1.0)
        self._stats = {}
        for creator in np.unique(creators):
            own = labels[creators == creator]
            std = float(own.std())
            self._stats[str(creator)] = (float(own.mean()), std if std > 0.0 else 1.0)
        return self

    def transform(self, posts: pd.DataFrame, index: np.ndarray) -> np.ndarray:
        """Z-score `posts.iloc[index]` using the statistics from `fit`.

        `index` must be integer positions into the same, full `posts` frame
        passed to `fit` (see class docstring) — it need not be, and usually
        is not, the same index `fit` was called with. `posts` itself must be
        that same frame, content and row order both: a fingerprint mismatch
        (see `_fingerprint`) means the positions in `index` do not refer to
        the rows they did at fit time — different length, different rows, or
        the same rows reordered all trip it — so that mismatch raises
        `LeakageError` rather than silently normalizing against the wrong
        rows.
        """
        if self._fit_positions is None or self._global is None or self._fit_fingerprint is None:
            raise RuntimeError("WithinCreatorNormalizer is not fitted")

        if _fingerprint(posts) != self._fit_fingerprint:
            raise LeakageError(
                "normalizer's frame does not match the one its statistics were fit on "
                "(creator_id/label content or row order differs) — positions are not "
                "comparable across different frames"
            )

        index = np.asarray(index)
        labels = posts["label"].to_numpy()[index]
        creators = posts["creator_id"].to_numpy()[index]

        out = np.empty(len(index), dtype=float)
        for position, (label, creator) in enumerate(zip(labels, creators)):
            # A creator with no train rows is Regime 2's cold start, which is a
            # legitimate case, not a leak — fall back to the global statistics.
            mean, std = self._stats.get(str(creator), self._global)
            out[position] = (label - mean) / std
        return out

    def assert_fit_disjoint_from(self, index: np.ndarray) -> None:
        """Prereg §7: the statistics must not have been fit on any test row.

        `index` must be integer positions into the same, full `posts` frame
        that was passed to `fit` (see class docstring); this method compares
        raw positions recorded by `fit` against `index`, so the two must
        share that coordinate system for the comparison to mean anything.
        """
        if self._fit_positions is None:
            raise RuntimeError("WithinCreatorNormalizer is not fitted")
        overlap = self._fit_positions & {int(i) for i in np.asarray(index)}
        if overlap:
            raise LeakageError(
                f"normalizer was fit on {len(overlap)} row(s) that are in the test set"
            )
