"""The one thing a spy cannot prove: that the two BullMQ ports agree.

The polyglot split rests on `bullmq` (PyPI) and `bullmq` (npm) running the same
Lua scripts against the same keys. Nothing in the unit suite touches Redis, so
nothing there would notice a prefix change, a queue rename, or a payload the
other side cannot parse.

    bun run docker:local
    pytest -m integration
"""

from __future__ import annotations

import asyncio
import os

import pytest
from bullmq import Queue, Worker

from queue_contract import (
    ANALYSIS_QUEUE,
    ANALYSIS_RESULTS_QUEUE,
    ANALYZE_JOB,
    QUEUE_PREFIX,
    AnalysisJob,
)

pytestmark = pytest.mark.integration

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379")

JOB = {
    "analysisId": "integration-analysis",
    "workspaceId": "integration-workspace",
    "modality": "video",
    "media": {"assetId": "integration-asset", "url": "https://example.test/clip.mp4"},
}


async def test_a_queued_job_reaches_a_python_worker_intact():
    queue = Queue(ANALYSIS_QUEUE, {"connection": REDIS_URL, "prefix": QUEUE_PREFIX})
    received: asyncio.Future = asyncio.get_running_loop().create_future()

    async def process(job, token):
        if not received.done():
            received.set_result(job.data)
        return {"ok": True}

    worker = Worker(
        ANALYSIS_QUEUE,
        process,
        {"connection": REDIS_URL, "prefix": QUEUE_PREFIX, "lockDuration": 30_000},
    )
    try:
        await queue.add(ANALYZE_JOB, JOB, {"jobId": "integration-1"})
        data = await asyncio.wait_for(received, timeout=15)

        # Parsing with the same model `worker.py` uses is the actual assertion: a
        # field renamed on either side of the hand-mirrored contract fails here.
        parsed = AnalysisJob(**data)
        assert parsed.analysisId == JOB["analysisId"]
        assert parsed.media.url == JOB["media"]["url"]
    finally:
        await worker.close(force=True)
        await queue.obliterate(force=True)
        await queue.close()


async def test_the_results_queue_accepts_a_published_payload():
    results = Queue(
        ANALYSIS_RESULTS_QUEUE, {"connection": REDIS_URL, "prefix": QUEUE_PREFIX}
    )
    try:
        job = await results.add(
            "analysis.started",
            {
                "analysisId": "integration-analysis",
                "attempt": 1,
                "queueJobId": "integration-1",
                "device": "synthetic",
                "startedAt": "2026-08-07T00:00:00.000Z",
            },
            {"jobId": "integration-analysis:1:analysis.started", "attempts": 1},
        )
        assert job.id == "integration-analysis:1:analysis.started"
    finally:
        await results.obliterate(force=True)
        await results.close()
