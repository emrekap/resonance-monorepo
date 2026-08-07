"""The stand-in for TRIBE, and the one assertion that makes it worth having.

A backend that returned noise would prove the plumbing carries a well-formed
payload and nothing else. This one plants a known signal into named cortical
networks at a known time, so a test can assert *meaning*: a visual-heavy clip
must peak in the visual band, in the window it was planted in. That single
assertion fails if the atlas mapping breaks, if `axis_timeline`'s column order
drifts from AXES, or if the timeline arrays fall out of alignment.
"""

from __future__ import annotations

import numpy as np
import pytest

import engine
import parcellation
from atlas.axis_map import AXES, n_vertices
from backends.synthetic import TR_SEC, SyntheticBackend

CLIP = "/nonexistent/clip.mp4"  # never opened — duration comes from the override


def build(scenario: str, seconds: float = 30.0, seed: int = 0):
    backend = SyntheticBackend(scenario=scenario, seed=seed, duration_sec=seconds)
    backend.load()
    return backend.run("video", CLIP)


class TestShape:
    def test_reports_itself_as_synthetic(self):
        """This string lands in `inference_runs.device`. It is how a fake run is
        told apart from a real one in the database, forever after."""
        assert SyntheticBackend().device == "synthetic"

    def test_is_on_the_fsaverage5_surface(self):
        preds, _ = build("flat")
        assert preds.ndim == 2
        assert preds.shape[1] == n_vertices()

    def test_one_segment_per_row(self):
        preds, segments = build("flat", seconds=30.0)
        assert len(segments) == preds.shape[0]
        assert preds.shape[0] == int(30.0 // TR_SEC)

    def test_segments_advance_monotonically(self):
        _preds, segments = build("flat")
        starts = [segment.start for segment in segments]
        assert starts == sorted(starts)
        assert segments[0].stop == pytest.approx(
            segments[0].start + segments[0].duration
        )

    def test_is_float32_like_the_real_model_is_assumed_to_be(self):
        preds, _ = build("flat")
        assert preds.dtype == np.float32


class TestDeterminism:
    def test_the_same_seed_gives_the_same_tensor(self):
        first, _ = build("mixed", seed=7)
        second, _ = build("mixed", seed=7)
        assert np.array_equal(first, second)

    def test_a_different_seed_does_not(self):
        first, _ = build("mixed", seed=7)
        second, _ = build("mixed", seed=8)
        assert not np.array_equal(first, second)


class TestPlantedSignal:
    def test_a_visual_burst_peaks_in_the_visual_band(self):
        """The assertion this whole backend exists to make possible."""
        preds, _segments = build("visual_burst", seconds=30.0)
        bands = parcellation.axis_bands(preds)
        visual = bands[:, AXES.index("visual")]

        peak_at = float(np.argmax(visual)) * TR_SEC
        assert 10.0 <= peak_at <= 14.0, f"visual peak landed at {peak_at:.1f}s"

    def test_a_visual_burst_does_not_light_the_language_band(self):
        """A burst that raised every axis would pass the test above for the wrong
        reason."""
        preds, _ = build("visual_burst")
        bands = parcellation.axis_bands(preds)
        assert (
            bands[:, AXES.index("visual")].max() > bands[:, AXES.index("language")].max()
        )

    def test_a_flat_clip_plants_nothing(self):
        preds, _ = build("flat")
        bands = parcellation.axis_bands(preds)
        # Seeded standard normal averaged over thousands of vertices: every band
        # sits near zero. A planted burst is 3σ, so this margin separates them.
        assert np.abs(bands).max() < 0.5

    def test_a_talky_clip_carries_a_transcript(self):
        _preds, segments = build("talky")
        spoken = [engine.segment_text(segment) for segment in segments]
        assert any(text for text in spoken), "no segment carried any words"

    def test_a_visual_burst_is_silent(self):
        _preds, segments = build("visual_burst")
        assert all(engine.segment_text(segment) == "" for segment in segments)


class TestThroughTheEngine:
    def test_predictions_to_dict_accepts_it(self):
        """The real integration point: whatever this backend returns has to
        survive `engine.predictions_to_dict`, which `worker.py` calls."""
        preds, segments = build("mixed")
        result = engine.predictions_to_dict(preds, segments)

        assert result["n_vertices"] == n_vertices()
        assert result["n_timesteps"] == preds.shape[0]
        assert set(result["axis_timeline"]) == set(AXES)
        for axis in AXES:
            assert len(result["axis_timeline"][axis]) == preds.shape[0]
        assert len(result["segments"]) == preds.shape[0]
        assert result["duration_sec"] > 0
