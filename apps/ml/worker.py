"""
TRIBE v2 queue worker — the production entry point for `apps/ml`.

Consumes the `analysis` queue that `apps/api` produces to, runs TRIBE v2, and
reports the outcome on `analysis-results`. It never touches Postgres: Prisma is
the single owner of the app schema, so `apps/worker` (Bun) does the writing.
See `packages/queue/src/contract.ts` for the full flow.

Why a worker and not the HTTP endpoints in `main.py`: inference is
seconds-to-minutes and GPU-bound. Blocking a client request on it would tie up
an API connection for the duration and lose the work on any disconnect; the
queue gives durability, retries with backoff, and lets the GPU box scale
independently of the API box.

Run it:

    python worker.py

`main.py` (FastAPI) still works and is what the Hugging Face Space serves —
both share `engine.py`, so they cannot drift.
"""

import asyncio
import logging
import os
import signal
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

from bullmq import Queue, UnrecoverableError, Worker

import engine
from queue_contract import (
    ANALYSIS_QUEUE,
    ANALYSIS_RESULTS_QUEUE,
    QUEUE_PREFIX,
    RESULT_JOB_FAILED,
    RESULT_JOB_STARTED,
    RESULT_JOB_SUCCEEDED,
    AnalysisFailed,
    AnalysisJob,
    AnalysisStarted,
    AnalysisSucceeded,
    Stats,
    Timeline,
    iso,
    now_iso,
)

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ml.worker")

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379")

# One job at a time by default: concurrency here is GPU memory, not I/O. Two
# TRIBE runs on one card is how you get an OOM halfway through both.
CONCURRENCY = int(os.getenv("ML_WORKER_CONCURRENCY", "1"))

# A job may legitimately take minutes. BullMQ's lock has to outlive the run or
# the stalled-job checker hands the same clip to another worker while this one
# is still on it — and renewal only happens between awaits, which a 20-minute
# torch call does not offer.
LOCK_DURATION_MS = int(os.getenv("ML_WORKER_LOCK_MS", str(30 * 60 * 1000)))

MAX_MEDIA_BYTES = int(os.getenv("ML_MAX_MEDIA_BYTES", str(2 * 1024 * 1024 * 1024)))
DOWNLOAD_TIMEOUT_S = int(os.getenv("ML_DOWNLOAD_TIMEOUT_S", "300"))

# Content types we can map back to an extension when the URL has none (a signed
# Storage URL usually does not).
_SUFFIX_BY_CONTENT_TYPE = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv",
    "video/webm": ".webm",
    "video/x-msvideo": ".avi",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "audio/ogg": ".ogg",
}


# ─── media ───────────────────────────────────────────────────────────────────


def _download(url: str, directory: Path, modality: str) -> Path:
    """Stream the media into `directory`, returning the file it wrote.

    Blocking — call it off the event loop. Raises UnrecoverableError for
    anything a retry cannot fix (a 404, a file type TRIBE does not read), and a
    plain exception for everything else so BullMQ backs off and tries again.
    """
    import requests

    allowed = engine.SUFFIXES_BY_MODALITY[modality]

    with requests.get(url, stream=True, timeout=DOWNLOAD_TIMEOUT_S) as response:
        if 400 <= response.status_code < 500:
            raise UnrecoverableError(
                f"media unreachable: {response.status_code} for {url}"
            )
        response.raise_for_status()

        # tribev2 dispatches on the file extension, so the name on disk has to
        # carry it. Prefer the URL's; fall back to the served content type,
        # which is all a signed Storage URL tends to give.
        suffix = Path(unquote(urlparse(url).path)).suffix.lower()
        if suffix not in allowed:
            content_type = (response.headers.get("content-type") or "").split(";")[0].strip()
            suffix = _SUFFIX_BY_CONTENT_TYPE.get(content_type, "")
        if suffix not in allowed:
            raise UnrecoverableError(
                f"unsupported {modality} media at {url}: accepted extensions {', '.join(allowed)}"
            )

        declared = response.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_MEDIA_BYTES:
            raise UnrecoverableError(
                f"media is {int(declared) / 1e6:.0f} MB, over the {MAX_MEDIA_BYTES / 1e6:.0f} MB cap"
            )

        destination = directory / f"media{suffix}"
        written = 0
        with destination.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                written += len(chunk)
                if written > MAX_MEDIA_BYTES:
                    # Servers lie about (or omit) content-length, so cap the
                    # stream itself rather than trust the header.
                    raise UnrecoverableError(
                        f"media exceeded the {MAX_MEDIA_BYTES / 1e6:.0f} MB cap while downloading"
                    )
                handle.write(chunk)

    logger.info(f"downloaded {written / 1e6:.1f} MB from {url}")
    return destination


def _timeline(result: dict) -> Timeline:
    """The per-segment attention curve, from what `predictions_to_dict` returns.

    `mean_activation_per_timestep` is row-aligned with `segments`, but only when
    both survived the same filtering — truncate to the shorter rather than pair
    an activation with someone else's timestamp.
    """
    attention = [float(value) for value in result.get("mean_activation_per_timestep", [])]
    starts = [float(segment["start"]) for segment in result.get("segments", [])]

    if len(starts) != len(attention):
        logger.warning(
            f"segments ({len(starts)}) and timesteps ({len(attention)}) disagree — "
            "truncating the timeline to the shorter of the two."
        )
        length = min(len(starts), len(attention))
        starts, attention = starts[:length], attention[:length]

    # visual / audio / language stay unset until the Yeo-7 parcellation exists.
    return Timeline(startSec=starts, attention=attention)


def _stats(result: dict) -> Stats:
    raw = result.get("stats", {})
    return Stats(
        globalMean=float(raw.get("global_mean", 0.0)),
        globalStd=float(raw.get("global_std", 0.0)),
        globalMin=float(raw.get("global_min", 0.0)),
        globalMax=float(raw.get("global_max", 0.0)),
        nTimesteps=int(result.get("n_timesteps", 0)),
        nVertices=int(result.get("n_vertices", 0)),
    )


# ─── the processor ───────────────────────────────────────────────────────────


class AnalysisProcessor:
    """Holds the results queue so every job does not open a new connection."""

    def __init__(self, results: Queue):
        self.results = results

    async def publish(self, name: str, payload, analysis_id: str, attempt: int) -> None:
        """Report an outcome to `apps/worker`.

        The job id is deterministic so a duplicate publish — this worker
        crashing after the publish but before the ack, then retrying — is
        dropped by BullMQ instead of writing the same row twice.

        `exclude_none` because Pydantic would otherwise serialise an unset
        optional as `null`, and JSON has no way to say "absent". The zod schemas
        accept both, but sending the key at all is noise that reads as "the
        model reported nothing" rather than "this field does not apply yet".
        """
        await self.results.add(
            name,
            payload.model_dump(exclude_none=True),
            {"jobId": f"{analysis_id}:{attempt}:{name}"},
        )

    async def __call__(self, job, token: str):
        started_at = datetime.now(timezone.utc)

        # `attemptsStarted` is incremented when the job is moved to active, so
        # it is this attempt's 1-based number. `attemptsMade` counts failures
        # only, hence the fallback.
        attempt = job.attemptsStarted or (job.attemptsMade + 1)
        max_attempts = job.opts.get("attempts") or 1
        payload = AnalysisJob(**job.data)
        analysis_id = payload.analysisId

        logger.info(
            f"[{analysis_id}] attempt {attempt}/{max_attempts} — "
            f"{payload.modality} {payload.media.url}"
        )

        await self.publish(
            RESULT_JOB_STARTED,
            AnalysisStarted(
                analysisId=analysis_id,
                attempt=attempt,
                queueJobId=str(job.id),
                device=engine.DEVICE,
                startedAt=iso(started_at),
            ),
            analysis_id,
            attempt,
        )

        try:
            # A directory rather than a named temp file: the extension is only
            # known once the response headers are in, and TemporaryDirectory
            # cleans up whatever name the download settled on.
            with tempfile.TemporaryDirectory(prefix="resonance-") as tmp_dir:
                media_path = await asyncio.to_thread(
                    _download, payload.media.url, Path(tmp_dir), payload.modality
                )
                preds, segments = await asyncio.to_thread(
                    engine.run_inference, payload.modality, str(media_path)
                )
                result = engine.predictions_to_dict(preds, segments)
        except Exception as exc:
            finished_at = datetime.now(timezone.utc)
            retryable = attempt < max_attempts and not isinstance(exc, UnrecoverableError)
            logger.error(f"[{analysis_id}] attempt {attempt} failed: {exc}", exc_info=True)

            await self.publish(
                RESULT_JOB_FAILED,
                AnalysisFailed(
                    analysisId=analysis_id,
                    attempt=attempt,
                    queueJobId=str(job.id),
                    device=engine.DEVICE,
                    startedAt=iso(started_at),
                    finishedAt=iso(finished_at),
                    error=f"{type(exc).__name__}: {exc}"[:2000],
                    retryable=retryable,
                ),
                analysis_id,
                attempt,
            )
            # Re-raise so BullMQ applies its own retry/backoff policy. The
            # published `failed` above only *describes* what it will do.
            raise

        finished_at = datetime.now(timezone.utc)
        duration_ms = int((finished_at - started_at).total_seconds() * 1000)

        await self.publish(
            RESULT_JOB_SUCCEEDED,
            AnalysisSucceeded(
                analysisId=analysis_id,
                attempt=attempt,
                queueJobId=str(job.id),
                device=engine.DEVICE,
                startedAt=iso(started_at),
                finishedAt=iso(finished_at),
                durationMs=duration_ms,
                timeline=_timeline(result),
                stats=_stats(result),
            ),
            analysis_id,
            attempt,
        )

        logger.info(
            f"[{analysis_id}] done in {duration_ms / 1000:.1f}s — "
            f"shape={result['shape']}"
        )

        # BullMQ stores this on the job; keep it small — the real payload went
        # out on the results queue.
        return {"analysisId": analysis_id, "attempt": attempt, "durationMs": duration_ms}


# ─── entry point ─────────────────────────────────────────────────────────────


async def main() -> None:
    logger.info(f"Loading TRIBE v2 before consuming (device: {engine.DEVICE})…")
    await asyncio.to_thread(engine.load_model)

    results = Queue(
        ANALYSIS_RESULTS_QUEUE,
        {"connection": REDIS_URL, "prefix": QUEUE_PREFIX},
    )
    worker = Worker(
        ANALYSIS_QUEUE,
        AnalysisProcessor(results),
        {
            "connection": REDIS_URL,
            "prefix": QUEUE_PREFIX,
            "concurrency": CONCURRENCY,
            "lockDuration": LOCK_DURATION_MS,
        },
    )

    logger.info(
        f"🧠 ml worker consuming \"{QUEUE_PREFIX}:{ANALYSIS_QUEUE}\" on {REDIS_URL} "
        f"(concurrency {CONCURRENCY})"
    )

    stop = asyncio.Future()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))

    await stop

    # `close()` waits for the in-flight job, so a deploy does not throw away a
    # GPU run that is nearly finished.
    logger.info("Draining… (finishing the current job)")
    await worker.close()
    await results.close()


if __name__ == "__main__":
    asyncio.run(main())
