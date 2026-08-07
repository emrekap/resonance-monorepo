"""
The Python half of the queue contract.

**Mirrors `packages/queue/src/contract.ts` by hand.** That file is the source of
truth and carries the flow diagram and the reasoning; this one exists because a
Python process cannot import TypeScript. Change one, change the other.

Validating in both directions is the point: a field that drifts fails loudly
here, at the boundary, instead of arriving in `apps/worker` as a null that
Postgres happily stores.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# ── Keys and names (must equal the TS constants) ─────────────────────────────

QUEUE_PREFIX = "resonance"

ANALYSIS_QUEUE = "analysis"
ANALYSIS_RESULTS_QUEUE = "analysis-results"

ANALYZE_JOB = "analyze"

RESULT_JOB_STARTED = "analysis.started"
RESULT_JOB_SUCCEEDED = "analysis.succeeded"
RESULT_JOB_FAILED = "analysis.failed"


def iso(moment: datetime) -> str:
    """UTC ISO-8601 that zod's `z.iso.datetime()` accepts.

    `z.iso.datetime()` rejects a `+00:00` offset by default — it wants `Z` — and
    a naive datetime would silently claim local time on a worker whose clock is
    not UTC. Both are handled here so no caller has to remember.
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_iso() -> str:
    return iso(datetime.now(timezone.utc))


# ── api → ml ─────────────────────────────────────────────────────────────────


class Media(BaseModel):
    model_config = ConfigDict(extra="ignore")

    assetId: str
    url: str


class AnalysisJob(BaseModel):
    """Payload of an `analyze` job on the `analysis` queue."""

    model_config = ConfigDict(extra="ignore")

    analysisId: str
    workspaceId: str
    modality: Literal["video", "audio"]
    media: Media


# ── ml → worker ──────────────────────────────────────────────────────────────


class Timeline(BaseModel):
    """Per-segment curves.

    `visual` / `audio` / `language` come from parcellating the fsaverage5
    vertices into cortical networks (`atlas/axis_map.py`). They stay Optional so
    a worker deployed ahead of this image still validates, and because
    `analysis_results_timeline_len_chk` requires all five arrays equal-length or
    all empty — `apps/worker` writes the timeline only when all five arrived.
    """

    model_config = ConfigDict(extra="ignore")

    startSec: list[float]
    attention: list[float]
    visual: Optional[list[float]] = None
    audio: Optional[list[float]] = None
    language: Optional[list[float]] = None


class AxisBands(BaseModel):
    """Clip-level activation per product axis, in `analysis_axis_scores.position` order.

    Raw z-scored BOLD means, never rendered. `apps/worker` ranks them against the
    workspace's prior analyses to produce the 0-100 a creator sees — the raw
    value has to cross the queue because a percentile needs history, and this
    process has no database.
    """

    model_config = ConfigDict(extra="ignore")

    visual: float
    audio: float
    language: float
    emotional: float
    memorability: float


class TranscriptEntry(BaseModel):
    """One segment's speech, row-aligned with `Timeline`.

    Silent segments carry an empty string rather than being dropped — the
    alignment with the attention curve is the point, and an all-empty transcript
    is how `apps/worker` knows to downgrade the CLARITY axis to BETA.
    """

    model_config = ConfigDict(extra="ignore")

    startSec: float
    text: str


class Stats(BaseModel):
    """Dev telemetry → `analysis_results.raw_stats`. Never rendered to a creator."""

    model_config = ConfigDict(extra="ignore")

    globalMean: float
    globalStd: float
    globalMin: float
    globalMax: float
    nTimesteps: int
    nVertices: int


class AnalysisStarted(BaseModel):
    model_config = ConfigDict(extra="ignore")

    analysisId: str
    attempt: int = Field(ge=1)
    queueJobId: str
    device: Optional[str] = None
    startedAt: str


class AnalysisSucceeded(BaseModel):
    model_config = ConfigDict(extra="ignore")

    analysisId: str
    attempt: int = Field(ge=1)
    queueJobId: str
    device: Optional[str] = None
    startedAt: str
    finishedAt: str
    durationMs: int = Field(ge=0)
    timeline: Timeline
    durationSec: Optional[float] = Field(default=None, ge=0)
    transcript: Optional[list[TranscriptEntry]] = None
    axisBands: Optional[AxisBands] = None
    stats: Stats


class AnalysisFailed(BaseModel):
    model_config = ConfigDict(extra="ignore")

    analysisId: str
    attempt: int = Field(ge=1)
    queueJobId: str
    device: Optional[str] = None
    startedAt: str
    finishedAt: str
    error: str
    #: False means this was the last attempt — only then does the analysis go FAILED.
    retryable: bool
