"""Capturing what the real model's output actually looks like.

`backends/synthetic.py` guesses at TRIBE's dtype and segment spacing, and nothing
in this repo can settle those without the model. This decorator writes a ~1 KB
manifest describing whatever it wrapped, so the first real run anywhere — a GPU
box, the HF Space — turns those guesses into checked facts.

It is a decorator rather than a flag inside `TribeBackend` precisely so it can be
tested here, by recording the synthetic backend.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from backends.recording import MANIFEST_NAME, RecordingBackend, build_manifest
from backends.synthetic import TR_SEC, SyntheticBackend


@pytest.fixture
def recorded(tmp_path):
    backend = RecordingBackend(
        SyntheticBackend(scenario="mixed", seed=0, duration_sec=30.0), tmp_path
    )
    backend.load()
    preds, segments = backend.run("video", "/nonexistent/clip.mp4")
    return preds, segments, json.loads((tmp_path / MANIFEST_NAME).read_text())


class TestTransparency:
    def test_returns_the_inner_result_unchanged(self, tmp_path):
        expected, _ = SyntheticBackend(
            scenario="mixed", seed=0, duration_sec=30.0
        ).run("video", "/x.mp4")

        wrapped = RecordingBackend(
            SyntheticBackend(scenario="mixed", seed=0, duration_sec=30.0), tmp_path
        )
        actual, _ = wrapped.run("video", "/x.mp4")
        assert np.array_equal(actual, expected)

    def test_forwards_the_device(self, tmp_path):
        wrapped = RecordingBackend(SyntheticBackend(), tmp_path)
        assert wrapped.device == "synthetic"

    def test_forwards_the_lifecycle(self, tmp_path):
        wrapped = RecordingBackend(SyntheticBackend(), tmp_path)
        assert wrapped.is_loaded() is False
        wrapped.load()
        assert wrapped.is_loaded() is True
        wrapped.unload()
        assert wrapped.is_loaded() is False

    def test_a_write_failure_never_loses_the_run(self, tmp_path):
        """A GPU run costs minutes. Losing one because telemetry could not be
        written to a read-only path would be indefensible."""
        blocked = tmp_path / "blocked"
        blocked.mkdir()
        blocked.chmod(0o500)
        wrapped = RecordingBackend(
            SyntheticBackend(duration_sec=30.0), blocked / "deeper"
        )
        try:
            preds, segments = wrapped.run("video", "/x.mp4")
            assert preds.shape[0] == len(segments) > 0
        finally:
            blocked.chmod(0o700)


class TestManifest:
    def test_records_the_dtype(self, recorded):
        _preds, _segments, manifest = recorded
        assert manifest["dtype"] == "float32"

    def test_records_the_surface(self, recorded):
        preds, _segments, manifest = recorded
        assert manifest["nVertices"] == preds.shape[1]
        assert manifest["ndim"] == 2

    def test_infers_the_tr_spacing(self, recorded):
        _preds, _segments, manifest = recorded
        assert manifest["trSec"] == pytest.approx(TR_SEC, abs=1e-6)

    def test_records_the_segment_members_it_saw(self, recorded):
        _preds, _segments, manifest = recorded
        assert set(manifest["segmentAttrs"]) >= {
            "start",
            "duration",
            "stop",
            "ns_events",
        }

    def test_records_the_event_type_names_it_saw(self, recorded):
        _preds, _segments, manifest = recorded
        assert "Word" in manifest["eventTypeNames"]

    def test_a_single_segment_clip_reports_no_spacing(self):
        """One segment gives no interval to measure. Null, not a guessed number."""
        preds = np.zeros((1, 4), dtype=np.float32)
        manifest = build_manifest(preds, [])
        assert manifest["trSec"] is None
