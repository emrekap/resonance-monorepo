"""The un-fitted headline: does the SHIPPED composite rank a creator's own posts?

Two analyses are worth running on this corpus (spec §8a), and they answer
different questions:

* **The ladder** answers the research question — do TRIBE features carry signal
  beyond metadata and text? It fits B0-B4.
* **This** answers the original one — does the product, exactly as it ships,
  rank a creator's posts against their realised reach? **Nothing is fitted, so
  nothing can be overfitted.**

The second is the more honest headline for precisely that reason. Reporting only
the fitted result would invite the obvious question of what was tuned, and the
answer "the corpus it was evaluated on" is not one worth giving.

Within creator, always. Across creators, reach is dominated by audience size,
and a correlation that does not condition on the creator is mostly a restatement
of subscriber count.
"""

from __future__ import annotations

import numpy as np

from eval.metrics import per_creator_spearman
from eval.snapshot import Snapshot
from eval.stats import bootstrap_over_creators


def zero_shot(snap: Snapshot, *, seed: int = 0) -> dict | None:
    """Within-creator Spearman of `composite` against `label`, bootstrapped.

    Returns None when the snapshot carries no `composite` column — a synthetic
    world has no shipped score to correlate, and an absent section reads as
    "not applicable" where a zero would read as "the product predicts nothing".
    """
    if "composite" not in snap.posts.columns:
        return None

    index = np.arange(len(snap.posts))
    y_true = snap.posts["label"].to_numpy(dtype=float)
    y_pred = snap.posts["composite"].to_numpy(dtype=float)

    by_creator = per_creator_spearman(snap.posts, index, y_true, y_pred)
    interval = bootstrap_over_creators(by_creator, seed=seed)

    return {
        "rho": interval.point,
        "lo": interval.lo,
        "hi": interval.hi,
        "creators": len(by_creator),
        "posts": int(len(snap.posts)),
    }
