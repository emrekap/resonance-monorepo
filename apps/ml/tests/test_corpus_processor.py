"""The corpus processor routes to the SAME engine as the analysis one.

This is the test that keeps the backtest describing the product. A separate
queue is not a separate inference path (spec §4b): if corpus features were
computed by different code, nothing else here would notice.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import worker
from queue_contract import CORPUS_RESULT_JOB_FAILED, CORPUS_RESULT_JOB_SUCCEEDED


class FakeQueue:
    def __init__(self):
        self.added = []

    async def add(self, name, payload, opts):
        self.added.append((name, payload, opts))


def fake_job(data, job_id="job-1", attempts=1):
    return SimpleNamespace(
        id=job_id, data=data, attemptsStarted=1, attemptsMade=0, opts={"attempts": attempts}
    )


JOB_DATA = {
    "corpusPostId": "0199b2f3-4c5d-7e6f-8a01-2b3c4d5e6f70",
    "clipId": "0199b2f3-4c5d-7e6f-8a01-2b3c4d5e6f71",
    "modality": "video",
    "media": {"url": "https://example.test/clip.mp4"},
}


@pytest.fixture
def stub_engine(monkeypatch, tmp_path):
    calls = []

    def run_inference(modality, path):
        calls.append((modality, path))
        return ("preds", "segments")

    monkeypatch.setattr(worker.engine, "run_inference", run_inference)
    monkeypatch.setattr(
        worker.engine,
        "predictions_to_dict",
        lambda preds, segments: {
            "mean_activation_per_timestep": [0.1, 0.2],
            "segments": [{"start": 0.0, "text": "a"}, {"start": 1.5, "text": ""}],
            "axis_timeline": {"visual": [0.1, 0.2], "audio": [0.0, 0.1], "language": [0.0, 0.0]},
            "axis_means": {
                axis: {"mean": 0.0, "std": 0.1, "peak": 0.2}
                for axis in ("visual", "audio", "language", "emotional", "memorability")
            },
            "stats": {"global_mean": 0.0, "global_std": 0.4, "global_min": -1.0, "global_max": 1.0},
            "n_timesteps": 2,
            "n_vertices": 20484,
            "duration_sec": 2.98,
            "shape": (2, 20484),
        },
    )
    monkeypatch.setattr(worker.engine, "device", lambda: "cpu")
    monkeypatch.setattr(
        worker, "_download", lambda url, directory, modality: tmp_path / "media.mp4"
    )
    return calls


def test_publishes_succeeded_with_bands(stub_engine):
    results = FakeQueue()
    processor = worker.CorpusProcessor(results, asyncio.Semaphore(1))

    asyncio.run(processor(fake_job(JOB_DATA), "token"))

    assert len(results.added) == 1
    name, payload, _ = results.added[0]
    assert name == CORPUS_RESULT_JOB_SUCCEEDED
    assert payload["corpusPostId"] == JOB_DATA["corpusPostId"]
    assert payload["clipId"] == JOB_DATA["clipId"]
    assert set(payload["axisBands"]) == {
        "visual",
        "audio",
        "language",
        "emotional",
        "memorability",
    }


def test_uses_the_same_engine_entry_point_as_an_analysis(stub_engine):
    results = FakeQueue()
    asyncio.run(worker.CorpusProcessor(results, asyncio.Semaphore(1))(fake_job(JOB_DATA), "t"))
    assert stub_engine == [("video", str(stub_engine[0][1]))] or stub_engine[0][0] == "video"


def test_publishes_no_started_event(stub_engine):
    results = FakeQueue()
    asyncio.run(worker.CorpusProcessor(results, asyncio.Semaphore(1))(fake_job(JOB_DATA), "t"))
    assert [name for name, _, _ in results.added] == [CORPUS_RESULT_JOB_SUCCEEDED]


def test_reports_failure_and_re_raises(monkeypatch, stub_engine):
    def boom(modality, path):
        raise RuntimeError("gpu fell over")

    monkeypatch.setattr(worker.engine, "run_inference", boom)
    results = FakeQueue()
    processor = worker.CorpusProcessor(results, asyncio.Semaphore(1))

    with pytest.raises(RuntimeError):
        asyncio.run(processor(fake_job(JOB_DATA, attempts=3), "t"))

    name, payload, _ = results.added[0]
    assert name == CORPUS_RESULT_JOB_FAILED
    # Attempt 1 of 3 — BullMQ will retry, so the poller must not mark it dead.
    assert payload["retryable"] is True
