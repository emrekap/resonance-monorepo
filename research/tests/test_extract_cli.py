import pytest

from eval.cli import maturation_from_args


def test_phase_1_must_carry_the_fallback_value():
    # A phase-1 run uses the hard-coded fallback BY DEFINITION. A manifest
    # claiming phase 1 with any other N is either a typo or a computed value
    # mislabelled as an assumed one — and the manifest is the only thing that
    # makes two runs at different floors comparable.
    assert maturation_from_args(14, 1) == {"n_days": 14, "phase": 1}
    with pytest.raises(ValueError, match="phase 1"):
        maturation_from_args(11, 1)


def test_phase_2_takes_whatever_the_query_produced():
    assert maturation_from_args(11, 2) == {"n_days": 11, "phase": 2}


def test_an_unknown_phase_is_rejected():
    with pytest.raises(ValueError):
        maturation_from_args(14, 3)
