from eval.stats import Interval
from eval.verdict import ALPHA, DELTA_RHO_THRESHOLD, GREEN, RED, YELLOW, explain, verdict


def test_clear_win_is_green():
    assert verdict(Interval(point=0.18, lo=0.11, hi=0.25), p_value=0.001) == GREEN


def test_no_lift_is_red():
    assert verdict(Interval(point=0.01, lo=-0.06, hi=0.08), p_value=0.7) == RED


def test_positive_but_under_threshold_is_yellow():
    assert verdict(Interval(point=0.06, lo=0.02, hi=0.10), p_value=0.01) == YELLOW


def test_over_threshold_but_not_significant_is_yellow():
    assert verdict(Interval(point=0.14, lo=0.01, hi=0.27), p_value=0.09) == YELLOW


def test_red_takes_precedence_over_yellow_when_bands_overlap():
    # THE ambiguity the spec's amendment resolves: a positive point estimate
    # below threshold whose CI includes zero satisfies both Yellow and Red.
    # Red wins, decided before any data existed.
    assert verdict(Interval(point=0.04, lo=-0.02, hi=0.10), p_value=0.30) == RED


def test_red_takes_precedence_even_over_a_green_sized_point_estimate():
    # A big point estimate with a CI through zero is not a demonstrated lift.
    assert verdict(Interval(point=0.22, lo=-0.03, hi=0.47), p_value=0.06) == RED


def test_nan_p_value_cannot_be_green():
    assert verdict(Interval(point=0.20, lo=0.10, hi=0.30), p_value=float("nan")) == YELLOW


def test_explain_names_the_deciding_rule():
    assert "confidence interval" in explain(
        Interval(point=0.01, lo=-0.06, hi=0.08), p_value=0.7
    )
    assert "threshold" in explain(Interval(point=0.06, lo=0.02, hi=0.10), p_value=0.01)


def test_nan_interval_is_red():
    nan = float("nan")
    assert verdict(Interval(point=nan, lo=nan, hi=nan), p_value=nan) == RED


# --- (b) boundary conventions, pinned so a refactor cannot silently flip a band ---


def test_threshold_is_inclusive_at_point_estimate_equal_to_threshold():
    assert DELTA_RHO_THRESHOLD == 0.10
    assert (
        verdict(Interval(point=0.10, lo=0.05, hi=0.15), p_value=0.01) == GREEN
    )


def test_alpha_is_exclusive_p_equal_to_alpha_is_not_significant():
    assert ALPHA == 0.05
    assert verdict(Interval(point=0.10, lo=0.05, hi=0.15), p_value=0.05) == YELLOW


def test_alpha_is_exclusive_p_just_under_alpha_is_significant():
    assert verdict(Interval(point=0.10, lo=0.05, hi=0.15), p_value=0.049) == GREEN


def test_includes_zero_is_inclusive_lower_bound_exactly_zero_is_red():
    # A lower bound sitting exactly on zero demonstrates no lift.
    assert verdict(Interval(point=0.15, lo=0.0, hi=0.30), p_value=0.001) == RED


# --- (c) explain: every branch, asserted on the substring that names the rule ---


def test_explain_red_by_ci_includes_zero():
    sentence = explain(Interval(point=0.01, lo=-0.06, hi=0.08), p_value=0.7)
    assert sentence.startswith("RED")
    assert "confidence interval" in sentence
    assert "includes zero" in sentence


def test_explain_red_by_unmeasurable_nan_interval():
    nan = float("nan")
    sentence = explain(Interval(point=nan, lo=nan, hi=nan), p_value=nan)
    assert sentence.startswith("RED")
    assert "could not be measured" in sentence


def test_explain_green():
    sentence = explain(Interval(point=0.18, lo=0.11, hi=0.25), p_value=0.001)
    assert sentence.startswith("GREEN")
    assert "clears" in sentence
    assert "threshold" in sentence


def test_explain_yellow_below_threshold():
    sentence = explain(Interval(point=0.06, lo=0.02, hi=0.10), p_value=0.01)
    assert sentence.startswith("YELLOW")
    assert "below the" in sentence
    assert "threshold" in sentence


def test_explain_yellow_above_threshold_but_not_significant():
    sentence = explain(Interval(point=0.14, lo=0.01, hi=0.27), p_value=0.09)
    assert sentence.startswith("YELLOW")
    assert "not significant" in sentence


def test_explain_yellow_p_value_undefined_does_not_call_it_not_significant():
    # (a) A NaN p-value means the test was never run to a conclusion — it is
    # underpowered/undefined, not "not significant". These must read differently.
    sentence = explain(Interval(point=0.20, lo=0.10, hi=0.30), p_value=float("nan"))
    assert sentence.startswith("YELLOW")
    assert "could not be computed" in sentence
    assert "not significant" not in sentence


# --- (d) verdict and explain must never disagree ---


def test_explain_band_always_matches_verdict_band():
    nan = float("nan")
    cases = [
        (Interval(point=0.18, lo=0.11, hi=0.25), 0.001),
        (Interval(point=0.01, lo=-0.06, hi=0.08), 0.7),
        (Interval(point=0.06, lo=0.02, hi=0.10), 0.01),
        (Interval(point=0.14, lo=0.01, hi=0.27), 0.09),
        (Interval(point=0.04, lo=-0.02, hi=0.10), 0.30),
        (Interval(point=0.22, lo=-0.03, hi=0.47), 0.06),
        (Interval(point=0.20, lo=0.10, hi=0.30), nan),
        (Interval(point=nan, lo=nan, hi=nan), nan),
        (Interval(point=0.10, lo=0.05, hi=0.15), 0.05),
        (Interval(point=0.10, lo=0.05, hi=0.15), 0.049),
        (Interval(point=0.15, lo=0.0, hi=0.30), 0.001),
    ]
    for uplift, p_value in cases:
        band = verdict(uplift, p_value)
        assert explain(uplift, p_value).startswith(band)
