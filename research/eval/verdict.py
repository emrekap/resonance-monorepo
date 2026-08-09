"""The go/no-go call, computed rather than chosen.

The pre-registration commits to a threshold. A human applying that threshold
after seeing the numbers is the failure mode the document exists to prevent, so
the band is computed here and the report renders whatever it says.

PRECEDENCE IS RED-FIRST, and that is not arbitrary. Prereg §6's three bands are
not mutually exclusive as written: a positive point estimate below 0.10 whose
95% CI includes zero satisfies BOTH Yellow ("positive but sub-threshold") and
Red ("CI includes 0"). Resolved in the design spec, before any data existed:

  1. RED    if the CI on the uplift includes zero  (no demonstrated lift)
  2. GREEN  if uplift >= 0.10 and p < 0.05
  3. YELLOW otherwise

Do not reorder these. The ordering is the commitment.

Rule 1 also covers a CI lying ENTIRELY BELOW zero — B3 significantly WORSE than
the baseline. That case is not in the prereg's parenthetical ("95% CI on the
uplift includes 0"), because nobody writing it pictured a negative uplift, and
the two bands as literally worded leave it homeless: its CI does not include
zero, and Yellow's text requires the uplift to be "Positive". So the untouched
`otherwise` swallowed it and returned YELLOW. That is backwards in the direction
that flatters the result: prereg §6 pairs Yellow with "iterate and re-run under
a new pre-registration" and Red with "pivot the technical story before scaling
spend", so the harness was recommending the softer action for the single
clearest refutation the experiment can produce. Measured on the null world,
where B3 carries nothing and B1 carries real signal: the uplift is about -0.36
with a CI of [-0.56, -0.17], and 7 of 8 seeds banded YELLOW. Red's row is headed
"No lift over metadata+text", which a wholly-negative CI demonstrates about as
emphatically as anything can, so it is read here as the criterion and the
parenthetical as an incomplete spelling of it.
"""

from __future__ import annotations

import math

from eval.stats import Interval

GREEN = "GREEN"
YELLOW = "YELLOW"
RED = "RED"
VOID = "VOID"

DELTA_RHO_THRESHOLD = 0.10
ALPHA = 0.05


def _is_unmeasurable(uplift: Interval) -> bool:
    """True if any field of the interval is NaN — a result that was never computed.

    `verdict()` and `explain()` must agree on which NaN counts as "no result".
    A single helper, not two copies of the same three-field check, is what
    keeps them from drifting apart.
    """
    return math.isnan(uplift.point) or math.isnan(uplift.lo) or math.isnan(uplift.hi)


def _is_worse_than_baseline(uplift: Interval) -> bool:
    """True if the whole CI sits below zero — B3 significantly WORSE than the baseline.

    Disjoint from `includes_zero()` by construction: an interval with `hi == 0`
    already includes zero, so this is strictly `hi < 0`. Together the two cover
    "the CI does not demonstrate positive lift" (`lo <= 0`), which is what Red
    means. Kept as a named helper rather than folded into `includes_zero()`
    because that method's name is its contract and `stats.py` tests it as such.
    """
    return uplift.hi < 0.0


def verdict(uplift: Interval, p_value: float) -> str:
    # An unmeasurable result is not a pass. NaN anywhere means RED.
    if _is_unmeasurable(uplift):
        return RED
    if uplift.includes_zero():
        return RED
    # Still rule 1, not a fourth rule inserted ahead of Green: a CI entirely
    # below zero is the strongest possible "no lift over metadata+text".
    if _is_worse_than_baseline(uplift):
        return RED
    if (
        uplift.point >= DELTA_RHO_THRESHOLD
        and not math.isnan(p_value)
        and p_value < ALPHA
    ):
        return GREEN
    return YELLOW


def explain(uplift: Interval, p_value: float) -> str:
    """One sentence naming the rule that decided the band."""
    band = verdict(uplift, p_value)
    if band == RED:
        if _is_unmeasurable(uplift):
            return "RED: the uplift could not be measured."
        if _is_worse_than_baseline(uplift):
            return (
                f"RED: the 95% confidence interval on the uplift "
                f"[{uplift.lo:.3f}, {uplift.hi:.3f}] lies entirely below zero, so B3 is "
                f"worse than the baseline, not better."
            )
        return (
            f"RED: the 95% confidence interval on the uplift "
            f"[{uplift.lo:.3f}, {uplift.hi:.3f}] includes zero, so no lift is demonstrated."
        )
    if band == GREEN:
        return (
            f"GREEN: uplift {uplift.point:.3f} clears the {DELTA_RHO_THRESHOLD:.2f} "
            f"threshold at p={p_value:.4f}."
        )
    if uplift.point < DELTA_RHO_THRESHOLD:
        return (
            f"YELLOW: uplift {uplift.point:.3f} is positive but below the "
            f"{DELTA_RHO_THRESHOLD:.2f} threshold."
        )
    if math.isnan(p_value):
        return (
            f"YELLOW: uplift {uplift.point:.3f} clears the threshold but significance "
            f"could not be computed (fewer than five measurable creators)."
        )
    return (
        f"YELLOW: uplift {uplift.point:.3f} clears the threshold but is not "
        f"significant (p={p_value:.4f}, alpha={ALPHA})."
    )
