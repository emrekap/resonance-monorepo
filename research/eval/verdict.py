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


def verdict(uplift: Interval, p_value: float) -> str:
    # An unmeasurable result is not a pass. NaN anywhere means RED.
    if _is_unmeasurable(uplift):
        return RED
    if uplift.includes_zero():
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
