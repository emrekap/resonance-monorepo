"""Creator-level statistics.

Prereg §7: "Bootstrap over creators for 95% CIs on each metric and on the
uplift. Paired Wilcoxon signed-rank across creators on per-creator uplift."
Resampling POSTS instead of creators is the classic way to manufacture
significance out of within-creator correlation, so the resampling unit is
explicit here and tested.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.stats import wilcoxon


@dataclass(frozen=True)
class Interval:
    point: float
    lo: float
    hi: float

    def includes_zero(self) -> bool:
        """True if the interval demonstrates no lift — including when undefined.

        The Red-first verdict rule (plan Global Constraint: CI-includes-zero ->
        RED, checked before any Green check) asks "is there demonstrated
        lift?". An interval with a NaN bound — e.g. what
        `bootstrap_over_creators({})` returns when zero creators are
        measurable — demonstrates no lift either: there is no data to
        demonstrate it, so it must take the same conservative branch as a
        straddling interval. Returning False here for a NaN bound would let a
        completely unmeasured run report a BETTER band than one that measured
        lift and found none — the same flattering-silence failure class this
        harness exists to catch.
        """
        if np.isnan(self.lo) or np.isnan(self.hi):
            return True
        return self.lo <= 0.0 <= self.hi


def bootstrap_over_creators(
    per_creator: dict[str, float], *, n_boot: int = 2000, seed: int = 0
) -> Interval:
    """Percentile bootstrap CI, resampling CREATORS with replacement."""
    values = np.array(list(per_creator.values()), dtype=float)
    if values.size == 0:
        return Interval(point=float("nan"), lo=float("nan"), hi=float("nan"))

    rng = np.random.default_rng(seed)
    draws = rng.integers(0, values.size, size=(n_boot, values.size))
    means = values[draws].mean(axis=1)
    return Interval(
        point=float(values.mean()),
        lo=float(np.percentile(means, 2.5)),
        hi=float(np.percentile(means, 97.5)),
    )


def paired_uplift(
    treatment: dict[str, float], baseline: dict[str, float]
) -> dict[str, float]:
    """Per-creator (treatment - baseline), over creators measurable in both."""
    shared = sorted(set(treatment) & set(baseline))
    return {creator: treatment[creator] - baseline[creator] for creator in shared}


def paired_wilcoxon(
    treatment: dict[str, float], baseline: dict[str, float]
) -> float:
    """Paired Wilcoxon signed-rank across creators. NaN when underpowered."""
    uplift = paired_uplift(treatment, baseline)
    values = np.array(list(uplift.values()), dtype=float)
    if values.size < 5:
        return float("nan")
    if np.allclose(values, 0.0):
        return 1.0  # scipy raises on an all-zero difference vector
    return float(wilcoxon(values).pvalue)
