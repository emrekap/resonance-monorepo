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
from typing import Optional
from urllib.parse import unquote, urlparse

from bullmq import Queue, UnrecoverableError, Worker

import engine
from queue_contract import (
    ANALYSIS_QUEUE,
    ANALYSIS_RESULTS_QUEUE,
    CORPUS_JOB,
    CORPUS_QUEUE,
    CORPUS_RESULTS_QUEUE,
    CORPUS_RESULT_JOB_FAILED,
    CORPUS_RESULT_JOB_SUCCEEDED,
    QUEUE_PREFIX,
    RESULT_JOB_FAILED,
    RESULT_JOB_STARTED,
    RESULT_JOB_SUCCEEDED,
    AnalysisFailed,
    AnalysisJob,
    AnalysisStarted,
    AnalysisSucceeded,
    AxisBands,
    AxisSummary,
    CorpusFailed,
    CorpusJob,
    CorpusSucceeded,
    Stats,
    Stimulus,
    Timeline,
    TranscriptEntry,
    iso,
    now_iso,
)
from stimulus import probe_stimulus

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ml.worker")

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379")

# One job at a time by default: concurrency here is GPU memory, not I/O. Two
# TRIBE runs on one card is how you get an OOM halfway through both.
CONCURRENCY = int(os.getenv("ML_WORKER_CONCURRENCY", "1"))

# Which queues this instance serves. Both by default; a dedicated corpus
# backfill box runs with ML_QUEUES=corpus so 1,600 research clips never sit in
# front of a customer's upload on the same card. The queue split guarantees the
# two never share a RESULT table (spec §4b) — it cannot, on its own, stop them
# sharing a GPU, and pretending otherwise would be the kind of claim that is
# only discovered false under load.
QUEUES = [q.strip() for q in os.getenv("ML_QUEUES", "analysis,corpus").split(",") if q.strip()]

# A job may legitimately take minutes. BullMQ's lock has to outlive the run or
# the stalled-job checker hands the same clip to another worker while this one
# is still on it — and renewal only happens between awaits, which a 20-minute
# torch call does not offer.
LOCK_DURATION_MS = int(os.getenv("ML_WORKER_LOCK_MS", str(30 * 60 * 1000)))

# How many times `apps/worker` may retry persisting one result. These are short
# database writes against idempotent handlers, so the only thing a retry can be
# recovering from is transient — and the alternative is losing a GPU run's
# outcome to a dropped connection.
RESULT_ATTEMPTS = int(os.getenv("ML_RESULT_ATTEMPTS", "1"))

MAX_MEDIA_BYTES = int(os.getenv("ML_MAX_MEDIA_BYTES",
                      str(2 * 1024 * 1024 * 1024)))
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


def _redacted(url: str) -> str:
    """A Redis URL safe to log.

    A managed Redis hands you `rediss://default:<token>@host:6379`, and the
    startup banner logs the connection it is using — so without this, every boot
    writes a live credential into wherever logs are shipped. Logs outlive
    processes and are rarely as access-controlled as a secret store.

    Never raises: a banner that crashes the worker would be worse than one that
    says nothing useful.
    """
    try:
        parsed = urlparse(url)
        if not parsed.password:
            return url
        host = parsed.netloc.rsplit("@", 1)[-1]
        return f"{parsed.scheme}://{parsed.username or ''}:***@{host}"
    except Exception:
        return "<unparseable REDIS_URL>"


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
            content_type = (response.headers.get(
                "content-type") or "").split(";")[0].strip()
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
    """The per-segment curves, from what `predictions_to_dict` returns.

    `mean_activation_per_timestep` and each band are row-aligned with `segments`,
    but only when they all survived the same filtering — truncate every array to
    the shortest rather than pair an activation with someone else's timestamp.

    All five arrays are truncated together on purpose:
    `analysis_results_timeline_len_chk` rejects a row whose arrays disagree, and
    it would do so on every retry.
    """
    attention = [float(value) for value in result.get(
        "mean_activation_per_timestep", [])]
    starts = [float(segment["start"])
              for segment in result.get("segments", [])]

    axis_timeline = result.get("axis_timeline") or {}
    bands = {
        axis: [float(value) for value in axis_timeline.get(axis, [])]
        for axis in ("visual", "audio", "language")
    }

    lengths = [len(starts), len(attention), *(len(curve) for curve in bands.values())]
    if len(set(lengths)) > 1:
        logger.warning(
            f"timeline arrays disagree in length ({lengths}) — truncating to the shortest."
        )
        length = min(lengths)
        starts, attention = starts[:length], attention[:length]
        bands = {axis: curve[:length] for axis, curve in bands.items()}

    return Timeline(startSec=starts, attention=attention, **bands)


def _stimulus(result: dict) -> Optional[Stimulus]:
    """What the ffmpeg probe found, or None when it found nothing usable.

    Both-probes-failed collapses to None rather than an all-null object so the
    payload (`exclude_none`) carries no `stimulus` key at all — identical on
    the wire to a payload from before the probe existed, which is the pair of
    cases `apps/worker` should not be able to tell apart.
    """
    raw = result.get("stimulus") or {}
    has_audio = raw.get("has_audio")
    has_visual = raw.get("has_visual")
    if has_audio is None and has_visual is None:
        return None
    return Stimulus(hasAudio=has_audio, hasVisual=has_visual)


def _transcript(result: dict) -> list[TranscriptEntry]:
    """One entry per segment, silent ones included, so it stays row-aligned."""
    return [
        TranscriptEntry(startSec=float(segment["start"]), text=segment.get("text", ""))
        for segment in result.get("segments", [])
    ]


def _axis_bands(result: dict) -> Optional[AxisBands]:
    """Clip-level statistics per axis, or None if the parcellation produced nothing."""
    summary = result.get("axis_means")
    if not summary:
        return None
    return AxisBands(
        **{
            axis: AxisSummary(**summary.get(axis, {"mean": 0.0, "std": 0.0, "peak": 0.0}))
            for axis in AxisBands.model_fields
        }
    )


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


# ─── the processors ──────────────────────────────────────────────────────────


async def _infer(modality: str, url: str, gpu: asyncio.Semaphore) -> dict:
    """Download, run TRIBE, and reduce — the whole inference path, once.

    Shared verbatim by both processors. **This function is the reason a second
    queue is safe:** a separate queue is not a separate inference path, and if
    the corpus reduced its features through different code the backtest would
    stop describing the product with nothing to catch it.

    `gpu` is held across the model call only. Two Workers each at concurrency 1
    would otherwise put two TRIBE runs on one card, which is how you get an OOM
    halfway through both.
    """
    # A directory rather than a named temp file: the extension is only known
    # once the response headers are in, and TemporaryDirectory cleans up
    # whatever name the download settled on.
    with tempfile.TemporaryDirectory(prefix="resonance-") as tmp_dir:
        media_path = await asyncio.to_thread(_download, url, Path(tmp_dir), modality)
        # Probed here because this is the only scope where the file exists —
        # the tempdir is gone the moment this block closes. Outside the GPU
        # semaphore on purpose: two ffmpeg passes need no card.
        probe = await asyncio.to_thread(probe_stimulus, media_path, modality)
        async with gpu:
            preds, segments = await asyncio.to_thread(
                engine.run_inference, modality, str(media_path)
            )
        result = engine.predictions_to_dict(preds, segments)
        result["stimulus"] = {
            "has_audio": probe.has_audio,
            "has_visual": probe.has_visual,
        }
        return result


class AnalysisProcessor:
    """Holds the results queue so every job does not open a new connection."""

    def __init__(self, results: Queue, gpu: asyncio.Semaphore):
        self.results = results
        self.gpu = gpu

    async def publish(self, name: str, payload, analysis_id: str, attempt: int) -> None:
        """Report an outcome to `apps/worker`.

        The job id is deterministic so a duplicate publish — this worker
        crashing after the publish but before the ack, then retrying — is
        dropped by BullMQ instead of writing the same row twice.

        `exclude_none` because Pydantic would otherwise serialise an unset
        optional as `null`, and JSON has no way to say "absent". The zod schemas
        accept both, but sending the key at all is noise that reads as "the
        model reported nothing" rather than "this field does not apply yet".

        `attempts` is set here rather than on the consumer because BullMQ reads
        the retry policy off the job, and the producer is the only one who can
        put it there. Without it every result job has exactly one attempt, so a
        transient Postgres error — a dropped pooler connection, a lock timeout —
        discards the outcome of a GPU run that cannot be recomputed, and the
        analysis is stranded PROCESSING forever. The writes on the other side are
        idempotent, so retrying costs nothing when the first attempt half-worked.
        """
        await self.results.add(
            name,
            payload.model_dump(exclude_none=True),
            {
                "jobId": f"{analysis_id}:{attempt}:{name}",
                "attempts": RESULT_ATTEMPTS,
                "backoff": {"type": "exponential", "delay": 1000},
            },
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
                device=engine.device(),
                startedAt=iso(started_at),
            ),
            analysis_id,
            attempt,
        )

        try:
            result = await _infer(payload.modality, payload.media.url, self.gpu)
        except Exception as exc:
            finished_at = datetime.now(timezone.utc)
            retryable = attempt < max_attempts and not isinstance(
                exc, UnrecoverableError)
            logger.error(
                f"[{analysis_id}] attempt {attempt} failed: {exc}", exc_info=True)

            await self.publish(
                RESULT_JOB_FAILED,
                AnalysisFailed(
                    analysisId=analysis_id,
                    attempt=attempt,
                    queueJobId=str(job.id),
                    device=engine.device(),
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
                device=engine.device(),
                startedAt=iso(started_at),
                finishedAt=iso(finished_at),
                durationMs=duration_ms,
                timeline=_timeline(result),
                durationSec=float(result.get("duration_sec", 0.0)),
                transcript=_transcript(result),
                axisBands=_axis_bands(result),
                stimulus=_stimulus(result),
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


class CorpusProcessor:
    """`corpus` → `corpus-results`. Same engine, different contract.

    No `started` event: nothing is watching a status column, and there is no row
    to walk from QUEUED to PROCESSING. No insights step either — recommendations
    are creator-facing output, and 1,600 of them is spend on text nobody reads.
    """

    def __init__(self, results: Queue, gpu: asyncio.Semaphore):
        self.results = results
        self.gpu = gpu

    async def publish(self, name: str, payload, post_id: str, attempt: int) -> None:
        await self.results.add(
            name,
            payload.model_dump(exclude_none=True),
            {
                "jobId": f"{post_id}:{attempt}:{name}",
                "attempts": RESULT_ATTEMPTS,
                "backoff": {"type": "exponential", "delay": 1000},
            },
        )

    async def __call__(self, job, token: str):
        started_at = datetime.now(timezone.utc)
        attempt = job.attemptsStarted or (job.attemptsMade + 1)
        max_attempts = job.opts.get("attempts") or 1
        payload = CorpusJob(**job.data)

        logger.info(
            f"[corpus {payload.corpusPostId}] attempt {attempt}/{max_attempts} — "
            f"{payload.media.url}"
        )

        try:
            result = await _infer(payload.modality, payload.media.url, self.gpu)
        except Exception as exc:
            finished_at = datetime.now(timezone.utc)
            retryable = attempt < max_attempts and not isinstance(exc, UnrecoverableError)
            logger.error(
                f"[corpus {payload.corpusPostId}] attempt {attempt} failed: {exc}",
                exc_info=True,
            )
            await self.publish(
                CORPUS_RESULT_JOB_FAILED,
                CorpusFailed(
                    corpusPostId=payload.corpusPostId,
                    clipId=payload.clipId,
                    attempt=attempt,
                    queueJobId=str(job.id),
                    device=engine.device(),
                    startedAt=iso(started_at),
                    finishedAt=iso(finished_at),
                    error=f"{type(exc).__name__}: {exc}"[:2000],
                    retryable=retryable,
                ),
                payload.corpusPostId,
                attempt,
            )
            raise

        finished_at = datetime.now(timezone.utc)
        bands = _axis_bands(result)
        if bands is None:
            # The contract requires them, so producing the payload would fail
            # anyway — this raises with a message that says why instead.
            raise UnrecoverableError(
                f"[corpus {payload.corpusPostId}] parcellation produced no axis bands; "
                "a corpus score with no bands can never be ranked"
            )

        await self.publish(
            CORPUS_RESULT_JOB_SUCCEEDED,
            CorpusSucceeded(
                corpusPostId=payload.corpusPostId,
                clipId=payload.clipId,
                attempt=attempt,
                queueJobId=str(job.id),
                device=engine.device(),
                startedAt=iso(started_at),
                finishedAt=iso(finished_at),
                durationMs=int((finished_at - started_at).total_seconds() * 1000),
                timeline=_timeline(result),
                durationSec=float(result.get("duration_sec", 0.0)),
                transcript=_transcript(result),
                axisBands=bands,
                stats=_stats(result),
            ),
            payload.corpusPostId,
            attempt,
        )
        return {"corpusPostId": payload.corpusPostId, "attempt": attempt}


# ─── entry point ─────────────────────────────────────────────────────────────


async def main() -> None:
    # "the model", not "TRIBE v2": under ML_BACKEND=synthetic this loads a
    # fabricator, and a banner that claims otherwise is how someone ends up
    # trusting a synthetic run. The backend says which it is via `device()`.
    logger.info(f"Loading the model before consuming (device: {engine.device()})…")
    await asyncio.to_thread(engine.load_model)

    # One semaphore across BOTH workers. Concurrency here is GPU memory, not
    # I/O, and two Workers at concurrency 1 each is two TRIBE runs on one card.
    gpu = asyncio.Semaphore(CONCURRENCY)

    queues: list[Queue] = []
    workers: list[Worker] = []

    common = {"connection": REDIS_URL, "prefix": QUEUE_PREFIX,
              "lockDuration": LOCK_DURATION_MS}

    if "analysis" in QUEUES:
        results = Queue(ANALYSIS_RESULTS_QUEUE, {
                        "connection": REDIS_URL, "prefix": QUEUE_PREFIX})
        queues.append(results)
        workers.append(
            Worker(ANALYSIS_QUEUE, AnalysisProcessor(results, gpu),
                   {**common, "concurrency": CONCURRENCY})
        )

    if "corpus" in QUEUES:
        corpus_results = Queue(
            CORPUS_RESULTS_QUEUE, {"connection": REDIS_URL,
                                   "prefix": QUEUE_PREFIX}
        )
        queues.append(corpus_results)
        workers.append(
            Worker(CORPUS_QUEUE, CorpusProcessor(corpus_results, gpu),
                   {**common, "concurrency": CONCURRENCY})
        )

    if not workers:
        raise SystemExit(f"ML_QUEUES={QUEUES!r} selects no queue to consume")

    logger.info(
        f"🧠 ml worker consuming {', '.join(f'{QUEUE_PREFIX}:{q}' for q in QUEUES)} on "
        f"{_redacted(REDIS_URL)} (gpu concurrency {CONCURRENCY})"
    )

    stop = asyncio.Future()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: stop.done()
                                or stop.set_result(None))

    await stop

    # `close()` waits for the in-flight job, so a deploy does not throw away a
    # GPU run that is nearly finished.
    logger.info("Draining… (finishing the current job)")
    for w in workers:
        await w.close()
    for q in queues:
        await q.close()


if __name__ == "__main__":
    asyncio.run(main())
