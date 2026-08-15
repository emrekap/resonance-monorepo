"""Reshaping TRIBE's output into the queue contract.

These five functions are the entire surface between `engine.predictions_to_dict`
and what `apps/worker` writes to Postgres. They are pure, they run anywhere, and
until now nothing tested them.

The one that matters most is `_timeline`. `analysis_results_timeline_len_chk`
rejects a row whose five arrays disagree in length — and it would do so on every
retry, so a mismatch here does not fail loudly, it strands an analysis in
PROCESSING forever.
"""

from __future__ import annotations

import pytest

import worker
from atlas.axis_map import AXES


def result(n=3, **overrides):
    """A `predictions_to_dict`-shaped dict with all arrays the same length."""
    base = {
        "segments": [
            {"start": index * 1.49, "stop": (index + 1) * 1.49, "text": f"word{index}"}
            for index in range(n)
        ],
        "mean_activation_per_timestep": [0.1 * index for index in range(n)],
        "axis_timeline": {axis: [0.2 * index for index in range(n)] for axis in AXES},
        "axis_means": {axis: {"mean": 1.0, "std": 0.5, "peak": 2.0} for axis in AXES},
        "stats": {
            "global_mean": 0.5,
            "global_std": 1.5,
            "global_min": -3.0,
            "global_max": 4.0,
        },
        "n_timesteps": n,
        "n_vertices": 20484,
        "duration_sec": n * 1.49,
    }
    base.update(overrides)
    return base


class TestTimeline:
    def test_carries_all_five_arrays(self):
        timeline = worker._timeline(result(n=4))
        assert len(timeline.startSec) == 4
        assert len(timeline.attention) == 4
        assert len(timeline.visual) == len(timeline.audio) == len(timeline.language) == 4

    def test_start_seconds_come_from_the_segments(self):
        timeline = worker._timeline(result(n=3))
        assert timeline.startSec == pytest.approx([0.0, 1.49, 2.98])

    def test_truncates_every_array_to_the_shortest(self):
        """The database rejects a row whose arrays disagree — on every retry.

        Truncating all five together turns a stranded analysis into a slightly
        short timeline.
        """
        payload = result(n=5)
        payload["mean_activation_per_timestep"] = [0.0, 1.0, 2.0]  # short
        timeline = worker._timeline(payload)

        lengths = {
            len(timeline.startSec),
            len(timeline.attention),
            len(timeline.visual),
            len(timeline.audio),
            len(timeline.language),
        }
        assert lengths == {3}

    def test_an_empty_result_yields_empty_arrays_not_an_error(self):
        timeline = worker._timeline({})
        assert timeline.startSec == []
        assert timeline.attention == []
        assert timeline.visual == []

    def test_a_missing_axis_timeline_empties_the_lot(self):
        """A worker deployed against an older ML image must not crash.

        All five arrays truncate together, so a missing band empties the whole
        timeline rather than shipping a row the length constraint would reject.
        """
        payload = result(n=3)
        del payload["axis_timeline"]
        timeline = worker._timeline(payload)
        assert timeline.visual == []
        assert timeline.startSec == []


class TestTranscript:
    def test_one_entry_per_segment(self):
        entries = worker._transcript(result(n=3))
        assert len(entries) == 3
        assert entries[1].text == "word1"
        assert entries[1].startSec == pytest.approx(1.49)

    def test_keeps_silent_segments_so_it_stays_row_aligned(self):
        """Dropping silent segments would misalign the transcript against the
        attention curve, which is the only reason to carry it."""
        payload = result(n=3)
        payload["segments"][1] = {"start": 1.49, "stop": 2.98}  # no text key
        entries = worker._transcript(payload)
        assert len(entries) == 3
        assert entries[1].text == ""


class TestAxisBands:
    def test_maps_all_five_axes(self):
        bands = worker._axis_bands(result())
        assert bands is not None
        for axis in AXES:
            assert getattr(bands, axis).mean == pytest.approx(1.0)
            assert getattr(bands, axis).peak == pytest.approx(2.0)

    def test_is_none_when_the_parcellation_produced_nothing(self):
        assert worker._axis_bands(result(axis_means={})) is None
        assert worker._axis_bands({}) is None

    def test_a_missing_axis_defaults_to_zero_rather_than_failing(self):
        payload = result()
        payload["axis_means"] = {"visual": {"mean": 9.0, "std": 1.0, "peak": 9.0}}
        bands = worker._axis_bands(payload)
        assert bands.visual.mean == pytest.approx(9.0)
        assert bands.audio.mean == pytest.approx(0.0)


class TestStimulus:
    def test_maps_the_probe_to_the_contract_model(self):
        payload = {"stimulus": {"has_audio": False, "has_visual": True}}
        stimulus = worker._stimulus(payload)
        assert stimulus is not None
        assert stimulus.hasAudio is False
        assert stimulus.hasVisual is True

    def test_is_none_when_the_probe_never_ran(self):
        """A payload from before the probe existed must not grow a stimulus key."""
        assert worker._stimulus({}) is None

    def test_is_none_when_both_probes_failed(self):
        payload = {"stimulus": {"has_audio": None, "has_visual": None}}
        assert worker._stimulus(payload) is None

    def test_one_failed_probe_still_reports_the_other(self):
        payload = {"stimulus": {"has_audio": None, "has_visual": False}}
        stimulus = worker._stimulus(payload)
        assert stimulus is not None
        assert stimulus.hasAudio is None
        assert stimulus.hasVisual is False


class TestStats:
    def test_renames_snake_case_to_the_contract(self):
        stats = worker._stats(result())
        assert stats.globalMean == pytest.approx(0.5)
        assert stats.globalMax == pytest.approx(4.0)
        assert stats.nTimesteps == 3
        assert stats.nVertices == 20484

    def test_an_empty_result_is_zeros_not_an_error(self):
        stats = worker._stats({})
        assert stats.globalMean == 0.0
        assert stats.nVertices == 0
