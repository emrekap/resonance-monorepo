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


class AxisSummary(BaseModel):
    """Clip-level statistics for one product axis, in raw z-scored BOLD units.

    Three, not one, because which of them should *be* the score is an open
    empirical question — there is no calibration data yet. Sending all three
    makes that a one-line constant in `apps/worker/src/scoring.ts` rather than a
    change to this image and the TypeScript contract together. See
    `parcellation.clip_summary` for what each one measures.
    """

    model_config = ConfigDict(extra="ignore")

    mean: float
    std: float
    peak: float


class AxisBands(BaseModel):
    """The five product axes, in `analysis_axis_scores.position` order.

    Never rendered. `apps/worker` ranks these against the workspace's prior
    analyses to produce the 0-100 a creator sees — the raw values have to cross
    the queue because a percentile needs history, and this process has no
    database.
    """

    model_config = ConfigDict(extra="ignore")

    visual: AxisSummary
    audio: AxisSummary
    language: AxisSummary
    emotional: AxisSummary
    memorability: AxisSummary


class TranscriptEntry(BaseModel):
    """One segment's speech, row-aligned with `Timeline`.

    Silent segments carry an empty string rather than being dropped — the
    alignment with the attention curve is the point, and an all-empty transcript
    is how `apps/worker` knows to downgrade the CLARITY axis to BETA.
    """

    model_config = ConfigDict(extra="ignore")

    startSec: float
    text: str


class Stimulus(BaseModel):
    """What the ffmpeg probe found in the media file itself (`stimulus.py`).

    The model predicts every brain network regardless of what the clip
    contains, so these flags — not the curves — are how the result screen knows
    which timeline lines to fade. `hasSpeech` is deliberately absent:
    `apps/worker` derives it from the all-empty transcript, and a second source
    could disagree with the first. Each field is independently Optional because
    the probes run separately; None means "unknown", never "no".
    """

    model_config = ConfigDict(extra="ignore")

    hasAudio: Optional[bool] = None
    hasVisual: Optional[bool] = None


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
    stimulus: Optional[Stimulus] = None
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


# ── poller → ml → poller (the research corpus) ───────────────────────────────
#
# A symmetric second pair. Mirrors the corpus section of
# `packages/queue/src/contract.ts` by hand — change one, change the other.
#
# Two asymmetries with the analysis pair above, both intentional:
#   * there is no `corpus.started` — nothing is watching a status column;
#   * `axisBands` is REQUIRED, because a corpus row exists only to yield a
#     composite and one without bands can never be ranked.

CORPUS_QUEUE = "corpus"
CORPUS_RESULTS_QUEUE = "corpus-results"

CORPUS_JOB = "corpus.score"

CORPUS_RESULT_JOB_SUCCEEDED = "corpus.succeeded"
CORPUS_RESULT_JOB_FAILED = "corpus.failed"


class CorpusMedia(BaseModel):
    model_config = ConfigDict(extra="ignore")

    url: str


class CorpusJob(BaseModel):
    """Payload of a `corpus.score` job on the `corpus` queue."""

    model_config = ConfigDict(extra="ignore")

    corpusPostId: str
    clipId: str
    modality: Literal["video", "audio"]
    media: CorpusMedia


class CorpusSucceeded(BaseModel):
    model_config = ConfigDict(extra="ignore")

    corpusPostId: str
    clipId: str
    attempt: int = Field(ge=1)
    queueJobId: str
    device: Optional[str] = None
    startedAt: str
    finishedAt: str
    durationMs: int = Field(ge=0)
    timeline: Timeline
    durationSec: Optional[float] = Field(default=None, ge=0)
    transcript: Optional[list[TranscriptEntry]] = None
    #: Required, not Optional — see the module note above.
    axisBands: AxisBands
    stats: Stats


class CorpusFailed(BaseModel):
    model_config = ConfigDict(extra="ignore")

    corpusPostId: str
    clipId: str
    attempt: int = Field(ge=1)
    queueJobId: str
    device: Optional[str] = None
    startedAt: str
    finishedAt: str
    error: str
    retryable: bool
