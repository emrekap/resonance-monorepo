"""Within-creator label normalisation, with the fit provenance recorded.

Prereg §7: "Within-creator normalization statistics are fit on train only and
applied to test." Fitting them on everything leaks the outcome distribution and
makes the number BETTER, which is why the rule needs a guard rather than a
convention. This class records the exact row positions its statistics came from,
so `assert_fit_disjoint_from` can prove they never saw test.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from eval.splits import LeakageError


class WithinCreatorNormalizer:
    """Z-scores the label within each creator, using train rows only.

    Calling convention: `fit` and `transform` both take the *whole, unsliced*
    `posts` DataFrame plus integer positions into it (the same convention as
    `Split.train` / `Split.test` in `eval.splits`) — never a pre-sliced subset
    with positions renumbered from zero. `assert_fit_disjoint_from` compares
    raw integer positions recorded by `fit` against a caller-supplied `index`;
    that comparison is only meaningful when both sides share the same
    coordinate system, i.e. positions into the same, full `posts` frame.
    """

    def __init__(self) -> None:
        self._stats: dict[str, tuple[float, float]] = {}
        self._global: tuple[float, float] | None = None
        self._fit_positions: frozenset[int] | None = None
        self._fit_frame_len: int | None = None

    def fit(self, posts: pd.DataFrame, index: np.ndarray) -> "WithinCreatorNormalizer":
        """Fit mean/std per creator (and globally) on `posts.iloc[index]` only.

        `index` must be integer positions into the full `posts` frame (see
        class docstring) — the positions recorded here are later compared
        raw, in `assert_fit_disjoint_from`, against test positions in that
        same frame. The length of `posts` is recorded too, so `transform` can
        catch a caller that comes back with a differently-shaped frame — a
        different length means a different coordinate system, which is the
        actual hazard a same-length-but-resliced frame could otherwise hide
        from the position-set comparisons alone.
        """
        index = np.asarray(index)
        self._fit_positions = frozenset(int(i) for i in index)
        self._fit_frame_len = len(posts)

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
        that same frame (or an equal-length one): a differently-sized frame
        means the positions in `index` do not refer to the rows they did at
        fit time, so that mismatch raises `LeakageError` rather than silently
        normalizing against the wrong rows.
        """
        if self._fit_positions is None or self._global is None or self._fit_frame_len is None:
            raise RuntimeError("WithinCreatorNormalizer is not fitted")

        if len(posts) != self._fit_frame_len:
            raise LeakageError(
                f"normalizer was fit on a frame of {self._fit_frame_len} row(s) but "
                f"transform was given a frame of {len(posts)} row(s) — positions are not "
                "comparable across differently-sized frames"
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
