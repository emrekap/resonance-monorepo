"""Task A metrics, always computed per creator.

Prereg §8: the unit of analysis is the creator, not the post. Posts within a
creator are correlated, and treating them as independent inflates significance.
So every function here returns a dict keyed by creator, and aggregation happens
once, explicitly, in `mean_over_creators`.

A creator with fewer than two test posts is EXCLUDED rather than scored zero. A
rank correlation over one point does not exist, and inventing a value for it
would quietly drag the mean toward zero.

Coordinate systems — read this before touching `index` here or in a caller.
This module sits at the point where two different meanings of "index" in this
package meet, and mixing them silently mis-scores:

- In `eval.splits` and `eval.normalize`, `index` (e.g. `Split.train` /
  `Split.test`) holds integer positions into the FULL `posts` frame.
- In THIS module, `y_true` and `y_pred` are NOT aligned to `posts` — they are
  aligned to `index` itself. `y_true[k]` / `y_pred[k]` is the prediction for
  the post at `posts.iloc[index[k]]`, for `k` in `0 .. len(index) - 1`.

So `_by_creator` below does two different-looking things that are actually one
step: it reads `posts["creator_id"].to_numpy()[index]` to get the creator for
each element of the ALIGNED arrays (this is the one place `index` is used to
index into `posts`), then groups the enumeration position `k` — not
`index[k]` — by that creator. Those `k` values are what every metric function
then uses to subscript `y_true` / `y_pred` directly. Using `index[k]` there
instead would be the coordinate-system bug: it would subscript `y_true` /
`y_pred` (which are `len(index)` long) with values that range over `posts`'
length instead.
"""

from __future__ import annotations

from itertools import combinations

import numpy as np
import pandas as pd
from scipy.stats import spearmanr


def _by_creator(
    posts: pd.DataFrame, index: np.ndarray
) -> dict[str, np.ndarray]:
    """Map creator -> positions WITHIN the aligned arrays (not into posts)."""
    creators = posts["creator_id"].to_numpy()[np.asarray(index)]
    groups: dict[str, list[int]] = {}
    for position, creator in enumerate(creators):
        groups.setdefault(str(creator), []).append(position)
    return {creator: np.array(positions) for creator, positions in groups.items()}


def per_creator_spearman(
    posts: pd.DataFrame, index: np.ndarray, y_true: np.ndarray, y_pred: np.ndarray
) -> dict[str, float]:
    out: dict[str, float] = {}
    for creator, positions in _by_creator(posts, index).items():
        if len(positions) < 2:
            continue
        rho = spearmanr(y_true[positions], y_pred[positions]).statistic
        if np.isfinite(rho):
            out[creator] = float(rho)
    return out


def per_creator_pairwise_accuracy(
    posts: pd.DataFrame, index: np.ndarray, y_true: np.ndarray, y_pred: np.ndarray
) -> dict[str, float]:
    """Given two of a creator's posts, do we pick the higher performer?"""
    out: dict[str, float] = {}
    for creator, positions in _by_creator(posts, index).items():
        if len(positions) < 2:
            continue
        correct = 0
        total = 0
        for i, j in combinations(positions, 2):
            if y_true[i] == y_true[j]:
                continue  # an unordered pair cannot be got right or wrong
            total += 1
            true_order = y_true[i] > y_true[j]
            pred_order = y_pred[i] > y_pred[j]
            correct += int(true_order == pred_order)
        if total:
            out[creator] = correct / total
    return out


def per_creator_top1(
    posts: pd.DataFrame, index: np.ndarray, y_true: np.ndarray, y_pred: np.ndarray
) -> dict[str, float]:
    """Did the highest-predicted post turn out to be the best one?"""
    out: dict[str, float] = {}
    for creator, positions in _by_creator(posts, index).items():
        if len(positions) < 2:
            continue
        best_predicted = positions[int(np.argmax(y_pred[positions]))]
        best_actual = y_true[positions].max()
        out[creator] = float(y_true[best_predicted] == best_actual)
    return out


def mean_over_creators(per_creator: dict[str, float]) -> float:
    """Average the metric across creators. NaN when nothing was measurable."""
    if not per_creator:
        return float("nan")
    return float(np.mean(list(per_creator.values())))
