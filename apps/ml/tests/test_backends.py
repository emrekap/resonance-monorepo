"""Backend selection — the seam that lets this island be tested without a GPU.

The default must stay `tribe`: production sets no environment variables, and a
default that silently produced synthetic brain data would be the worst possible
failure mode this repo has.
"""

from __future__ import annotations

import pytest

import backends


def test_defaults_to_tribe_when_unset(monkeypatch):
    """Production sets nothing. Nothing must mean the real model."""
    monkeypatch.delenv("ML_BACKEND", raising=False)
    assert backends.selected_name() == "tribe"


def test_selects_synthetic(monkeypatch):
    monkeypatch.setenv("ML_BACKEND", "synthetic")
    assert backends.selected_name() == "synthetic"


def test_name_is_case_and_space_insensitive(monkeypatch):
    monkeypatch.setenv("ML_BACKEND", "  Synthetic ")
    assert backends.selected_name() == "synthetic"


def test_rejects_an_unknown_backend(monkeypatch):
    """A typo must not fall back to either real or fake — both are wrong."""
    monkeypatch.setenv("ML_BACKEND", "trbie")
    with pytest.raises(ValueError, match="trbie"):
        backends.get_backend()


def test_caches_one_backend_per_process(monkeypatch):
    monkeypatch.setenv("ML_BACKEND", "synthetic")
    assert backends.get_backend() is backends.get_backend()


def test_reset_clears_the_cache(monkeypatch):
    monkeypatch.setenv("ML_BACKEND", "synthetic")
    first = backends.get_backend()
    backends.reset_backend()
    assert backends.get_backend() is not first
