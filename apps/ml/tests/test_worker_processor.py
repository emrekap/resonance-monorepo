"""What the worker tells `apps/worker` happened.

`apps/ml` never writes Postgres — it reports, and `apps/worker` persists. So
everything this process decides is expressed in what it publishes, and the two
decisions that matter are both booleans-in-disguise:

- `retryable` is how `apps/worker` knows whether to mark the analysis FAILED or
  leave it PROCESSING for the next attempt. Get it wrong on the last attempt and
  the analysis is stranded forever.
- the result `jobId` is deterministic so that a crash between publishing and
  acking cannot write the same row twice.
"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest
from bullmq import UnrecoverableError

import worker
from atlas.axis_map import n_vertices
from queue_contract import (
    RESULT_JOB_FAILED,
    RESULT_JOB_STARTED,
    RESULT_JOB_SUCCEEDED,
)


@pytest.fixture
def processor(spy_results_queue, monkeypatch):
    """A processor whose download is replaced, so the test is about the
    orchestration and nothing else."""

    def _download(url, directory, modality):
        path = directory / "media.mp4"
        path.write_bytes(b"x")
        return path

    monkeypatch.setattr(worker, "_download", _download)
    # The GPU semaphore is shared with `CorpusProcessor` in `main()` — both
    # processors route through `_infer`, which holds it across the model call.
    return worker.AnalysisProcessor(spy_results_queue, asyncio.Semaphore(1))


@pytest.fixture
def succeeding(monkeypatch):
    """Inference that returns a real synthetic run."""
    from backends.synthetic import SyntheticBackend

    backend = SyntheticBackend(scenario="mixed", seed=0, duration_sec=30.0)
    monkeypatch.setattr(
        worker.engine,
        "run_inference",
        lambda modality, path: backend.run(modality, path),
    )
    monkeypatch.setattr(worker.engine, "device", lambda: "synthetic")


@pytest.fixture
def exploding(monkeypatch):
    """Inference that raises whatever the test hands it."""

    def build(exc):
        def _boom(modality, path):
            raise exc

        monkeypatch.setattr(worker.engine, "run_inference", _boom)
        monkeypatch.setattr(worker.engine, "device", lambda: "synthetic")

    return build


class TestStarted:
    async def test_publishes_started_before_doing_any_work(
        self, processor, fake_job, spy_results_queue, succeeding
    ):
        await processor(fake_job(), token="t")
        assert spy_results_queue.calls[0][0] == RESULT_JOB_STARTED

    async def test_started_carries_the_device(
        self, processor, fake_job, spy_results_queue, succeeding
    ):
        """This is the string that lands in `inference_runs.device` and marks the
        row as fabricated."""
        await processor(fake_job(), token="t")
        assert spy_results_queue.named(RESULT_JOB_STARTED)["device"] == "synthetic"

    async def test_attempt_is_one_based(
        self, processor, fake_job, spy_results_queue, succeeding
    ):
        await processor(fake_job(attempts=3, attempts_started=2), token="t")
        assert spy_results_queue.named(RESULT_JOB_STARTED)["attempt"] == 2


class TestSucceeded:
    async def test_publishes_the_five_timeline_arrays(
        self, processor, fake_job, spy_results_queue, succeeding
    ):
        await processor(fake_job(), token="t")
        timeline = spy_results_queue.named(RESULT_JOB_SUCCEEDED)["timeline"]
        lengths = {
            len(timeline[key])
            for key in ("startSec", "attention", "visual", "audio", "language")
        }
        assert len(lengths) == 1, f"arrays disagree: {lengths}"
        assert lengths.pop() > 0

    async def test_publishes_all_five_axis_bands(
        self, processor, fake_job, spy_results_queue, succeeding
    ):
        await processor(fake_job(), token="t")
        bands = spy_results_queue.named(RESULT_JOB_SUCCEEDED)["axisBands"]
        assert set(bands) == {
            "visual",
            "audio",
            "language",
            "emotional",
            "memorability",
        }
        assert set(bands["visual"]) == {"mean", "std", "peak"}

    async def test_reports_the_surface_it_ran_on(
        self, processor, fake_job, spy_results_queue, succeeding
    ):
        await processor(fake_job(), token="t")
        stats = spy_results_queue.named(RESULT_JOB_SUCCEEDED)["stats"]
        assert stats["nVertices"] == n_vertices()

    async def test_returns_a_small_summary_for_bullmq_to_store(
        self, processor, fake_job, succeeding
    ):
        returned = await processor(fake_job(), token="t")
        assert set(returned) == {"analysisId", "attempt", "durationMs"}

    async def test_publishes_what_the_stimulus_probe_found(
        self, processor, fake_job, spy_results_queue, succeeding, monkeypatch
    ):
        from stimulus import StimulusProbe

        monkeypatch.setattr(
            worker, "probe_stimulus", lambda path, modality: StimulusProbe(False, True)
        )
        await processor(fake_job(), token="t")
        payload = spy_results_queue.named(RESULT_JOB_SUCCEEDED)
        assert payload["stimulus"] == {"hasAudio": False, "hasVisual": True}

    async def test_a_failed_probe_is_omitted_not_fatal(
        self, processor, fake_job, spy_results_queue, succeeding
    ):
        """The fake download writes one junk byte, so the real probe fails on
        every path — the job must still succeed, with no stimulus key at all
        (`exclude_none`)."""
        await processor(fake_job(), token="t")
        payload = spy_results_queue.named(RESULT_JOB_SUCCEEDED)
        assert "stimulus" not in payload


class TestFailed:
    async def test_publishes_failed_and_re_raises(
        self, processor, fake_job, spy_results_queue, exploding
    ):
        """Re-raising is what makes BullMQ apply its own retry policy — the
        published `failed` only *describes* what it is about to do."""
        exploding(RuntimeError("cuda oom"))
        with pytest.raises(RuntimeError, match="cuda oom"):
            await processor(fake_job(attempts=3, attempts_started=1), token="t")
        assert spy_results_queue.named(RESULT_JOB_FAILED)["error"].startswith(
            "RuntimeError"
        )

    async def test_a_transient_error_with_attempts_left_is_retryable(
        self, processor, fake_job, spy_results_queue, exploding
    ):
        exploding(RuntimeError("connection reset"))
        with pytest.raises(RuntimeError):
            await processor(fake_job(attempts=3, attempts_started=1), token="t")
        assert spy_results_queue.named(RESULT_JOB_FAILED)["retryable"] is True

    async def test_the_last_attempt_is_not_retryable(
        self, processor, fake_job, spy_results_queue, exploding
    ):
        """False is what lets `apps/worker` mark the analysis FAILED. Without it
        the row sits in PROCESSING forever."""
        exploding(RuntimeError("connection reset"))
        with pytest.raises(RuntimeError):
            await processor(fake_job(attempts=3, attempts_started=3), token="t")
        assert spy_results_queue.named(RESULT_JOB_FAILED)["retryable"] is False

    async def test_an_unrecoverable_error_is_never_retryable(
        self, processor, fake_job, spy_results_queue, exploding
    ):
        """Even on attempt 1 of 3. A 404 does not become a 200 on retry."""
        exploding(UnrecoverableError("media unreachable: 404"))
        with pytest.raises(UnrecoverableError):
            await processor(fake_job(attempts=3, attempts_started=1), token="t")
        assert spy_results_queue.named(RESULT_JOB_FAILED)["retryable"] is False

    async def test_the_error_message_is_truncated(
        self, processor, fake_job, spy_results_queue, exploding
    ):
        exploding(RuntimeError("x" * 5000))
        with pytest.raises(RuntimeError):
            await processor(fake_job(), token="t")
        assert len(spy_results_queue.named(RESULT_JOB_FAILED)["error"]) <= 2000

    async def test_a_failed_run_still_reports_started_first(
        self, processor, fake_job, spy_results_queue, exploding
    ):
        """`apps/worker` needs the STARTED row to exist before it can mark the
        analysis failed against it."""
        exploding(RuntimeError("boom"))
        with pytest.raises(RuntimeError):
            await processor(fake_job(), token="t")
        assert [name for name, _, _ in spy_results_queue.calls] == [
            RESULT_JOB_STARTED,
            RESULT_JOB_FAILED,
        ]


class TestPublishOptions:
    async def test_the_result_job_id_is_deterministic(
        self, processor, fake_job, spy_results_queue, succeeding
    ):
        """A crash between publishing and acking republishes the same id, and
        BullMQ drops the duplicate rather than writing the row twice."""
        await processor(fake_job(attempts=3, attempts_started=2), token="t")
        opts = spy_results_queue.opts_for(RESULT_JOB_SUCCEEDED)
        assert opts["jobId"] == f"analysis-1:2:{RESULT_JOB_SUCCEEDED}"

    async def test_results_carry_a_retry_policy(
        self, processor, fake_job, spy_results_queue, succeeding
    ):
        """BullMQ reads the retry policy off the job, and only the producer can
        put it there — without it a dropped pooler connection discards the
        outcome of a GPU run that cannot be recomputed."""
        await processor(fake_job(), token="t")
        opts = spy_results_queue.opts_for(RESULT_JOB_SUCCEEDED)
        assert opts["attempts"] >= 1
        assert opts["backoff"]["type"] == "exponential"

    async def test_unset_optionals_are_omitted_not_nulled(
        self, processor, fake_job, spy_results_queue, monkeypatch
    ):
        """`exclude_none` — a `null` on the wire reads as "the model reported
        nothing" rather than "this field does not apply"."""
        monkeypatch.setattr(
            worker.engine,
            "run_inference",
            lambda modality, path: (
                np.zeros((2, n_vertices()), dtype=np.float32),
                [],
            ),
        )
        monkeypatch.setattr(worker.engine, "device", lambda: "synthetic")
        await processor(fake_job(), token="t")
        payload = spy_results_queue.named(RESULT_JOB_SUCCEEDED)
        assert all(value is not None for value in payload.values())
