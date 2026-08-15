import { z } from 'zod';

/**
 * The wire contract between the three processes on the queue.
 *
 * ```text
 *   apps/api  ──add──▶  [analysis]          ──▶  apps/ml (python worker)
 *                                                  │ TRIBE v2 inference
 *                                                  ▼
 *   apps/worker  ◀────  [analysis-results]  ◀──────┘
 *        │ prismaService (BYPASSRLS)
 *        ▼
 *   analyses · analysis_results · inference_runs
 * ```
 *
 * Two queues rather than one because `apps/ml` must never write app tables —
 * Prisma is the single schema owner, and a second ORM in Python is exactly the
 * drift this architecture is shaped to avoid. So the Python worker reports what
 * it computed and a Bun worker persists it.
 *
 * `apps/ml` cannot import this file, so it mirrors these shapes as Pydantic
 * models in `apps/ml/queue_contract.py`. **Change one, change the other** —
 * both sides validate on the way in, so a drifted field fails loudly at the
 * boundary instead of silently writing a null.
 */

/**
 * Namespaces every Redis key BullMQ writes (`resonance:analysis:*`).
 *
 * Set explicitly rather than left at BullMQ's `bull` default so a Redis shared
 * with anything else — or a second environment pointed at the same instance —
 * cannot collide on queue names as generic as "analysis".
 */
export const QUEUE_PREFIX = 'resonance';

/** api → ml. One job per `analyses` row. */
export const ANALYSIS_QUEUE = 'analysis';

/** ml → worker. Progress and outcome of the job above. */
export const ANALYSIS_RESULTS_QUEUE = 'analysis-results';

/** The only job name on {@link ANALYSIS_QUEUE}. */
export const ANALYZE_JOB = 'analyze';

/**
 * Job names on {@link ANALYSIS_RESULTS_QUEUE}.
 *
 * The name is the discriminant: the Bun worker switches on `job.name` and
 * parses with the matching schema, so a new outcome is a new name rather than
 * an optional field on a union.
 */
export const RESULT_JOB = {
  started: 'analysis.started',
  succeeded: 'analysis.succeeded',
  failed: 'analysis.failed',
} as const;

export type ResultJobName = (typeof RESULT_JOB)[keyof typeof RESULT_JOB];

// ─── api → ml ────────────────────────────────────────────────────────────────

/**
 * Mirrors `media_kind_enum` minus IMAGE — TRIBE takes video or audio.
 *
 * Spelled as literals rather than imported from `@repo/db` on purpose: this
 * package is the contract with a Python process, so it must not depend on the
 * Prisma client. `apps/api` maps the enum to these on the way in.
 */
export const modalitySchema = z.enum(['video', 'audio']);
export type Modality = z.infer<typeof modalitySchema>;

export const analysisJobSchema = z.object({
  /** `analyses.id`. Also the BullMQ job id — see `enqueueAnalysis`. */
  analysisId: z.uuid(),
  workspaceId: z.uuid(),
  modality: modalitySchema,
  media: z.object({
    /** `media_assets.id`. */
    assetId: z.uuid(),
    /**
     * Where the worker fetches the bytes. Today this is the caller-supplied URL
     * parked in the `external` bucket; once uploads go through Supabase Storage
     * it becomes a short-lived signed URL, and only this field changes.
     */
    url: z.url(),
  }),
});
export type AnalysisJob = z.infer<typeof analysisJobSchema>;

// ─── ml → worker ─────────────────────────────────────────────────────────────

/** Fields every outcome carries, so `inference_runs` can be written from any of them. */
const runIdentity = {
  analysisId: z.uuid(),
  /**
   * 1-based, from BullMQ's own attempt counter. Keyed with `analysisId` by
   * `inference_runs.@@unique([analysisId, attempt])`, which is what makes these
   * writes idempotent under an at-least-once queue.
   */
  attempt: z.int().min(1),
  /** The `analysis` queue's job id — equal to `analysisId`, kept for audit. */
  queueJobId: z.string(),
  /**
   * `cuda` / `mps` / `cpu`. Absent before the model reports one.
   *
   * `.nullish()`, not `.nullable()` or `.optional()`, throughout this file:
   * the producer is Python, and Pydantic serialises an unset field as `null`
   * while `.optional()` accepts only `undefined` — a mismatch that parses fine
   * in every TS-to-TS test and fails on the first real job. Accepting both is
   * the boundary being tolerant about a distinction Python does not have.
   */
  device: z.string().nullish(),
};

export const analysisStartedSchema = z.object({
  ...runIdentity,
  startedAt: z.iso.datetime(),
});
export type AnalysisStarted = z.infer<typeof analysisStartedSchema>;

/**
 * The per-segment timeline.
 *
 * `startSec` and `attention` are what TRIBE gives us directly; the three
 * modality bands come from parcellating the ~20 k fsaverage5 vertices into
 * cortical networks (`apps/ml/atlas`, and `docs/resonance-model-design.md` §1a).
 *
 * The bands stay `.nullish()` even though `apps/ml` now always sends them, for
 * two reasons: a worker deployed ahead of the ml image must not reject every
 * job, and `analysis_results_timeline_len_chk` requires the five arrays to be
 * equal-length **or all empty** — so `apps/worker` still writes the timeline
 * only when all five are present, rather than handing Postgres a partial row it
 * would reject on every retry.
 */
export const timelineSchema = z.object({
  startSec: z.array(z.number()),
  attention: z.array(z.number()),
  visual: z.array(z.number()).nullish(),
  audio: z.array(z.number()).nullish(),
  language: z.array(z.number()).nullish(),
});
export type Timeline = z.infer<typeof timelineSchema>;

/**
 * Clip-level statistics for one product axis, in raw z-scored BOLD units.
 *
 * Three, not one, because which of them should *be* the score is an open
 * empirical question — there is no calibration data yet. Sending all three makes
 * that a one-line constant in `apps/worker/src/scoring.ts` rather than a change
 * to the ML image and this contract together.
 *
 * `mean` is the weakest of the three and is kept for comparison: TRIBE predicts
 * z-scored BOLD, so a time-average sits near zero by construction — the same
 * objection `docs/resonance-model-design.md` §0 raises against the brain-wide
 * average. `std` is that doc's "dynamism" proxy; `peak` (top-quartile mean) is
 * the closest to "did the hook land".
 */
export const axisSummarySchema = z.object({
  mean: z.number(),
  std: z.number(),
  peak: z.number(),
});
export type AxisSummary = z.infer<typeof axisSummarySchema>;

/**
 * The five product axes, in `analysis_axis_scores.position` order.
 *
 * Never rendered. `apps/worker` ranks these against the same workspace's prior
 * analyses to get the 0–100 a creator sees, which is why the raw values have to
 * cross the queue rather than being reduced here: a percentile needs the
 * *history*, and `apps/ml` has no database.
 */
export const axisBandsSchema = z.object({
  visual: axisSummarySchema,
  audio: axisSummarySchema,
  language: axisSummarySchema,
  emotional: axisSummarySchema,
  memorability: axisSummarySchema,
});
export type AxisBands = z.infer<typeof axisBandsSchema>;

/**
 * The transcript, one entry per segment, row-aligned with {@link timelineSchema}.
 *
 * Segments with no speech carry an empty `text` rather than being omitted — the
 * alignment with the attention curve is the point. An all-empty transcript is
 * how `apps/worker` knows the clip has no speech and downgrades the CLARITY
 * axis to BETA.
 */
export const transcriptEntrySchema = z.object({
  startSec: z.number(),
  text: z.string(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

/**
 * Dev telemetry only — lands in `analysis_results.raw_stats`, never rendered
 * to a creator. `globalMean` is near zero by construction (the model predicts
 * z-scored fMRI), so it measures nothing about the content.
 *
 * Named rather than inline because the corpus contract carries the identical
 * block: one definition means one place to change when the model reports
 * something new.
 */
export const statsSchema = z.object({
  globalMean: z.number(),
  globalStd: z.number(),
  globalMin: z.number(),
  globalMax: z.number(),
  nTimesteps: z.int().min(0),
  nVertices: z.int().min(0),
});
export type Stats = z.infer<typeof statsSchema>;

export const analysisSucceededSchema = z.object({
  ...runIdentity,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.int().min(0),
  timeline: timelineSchema,
  /** Media length in seconds — bounds every recommendation timestamp. */
  durationSec: z.number().min(0).nullish(),
  transcript: z.array(transcriptEntrySchema).nullish(),
  axisBands: axisBandsSchema.nullish(),
  stats: statsSchema,
});
export type AnalysisSucceeded = z.infer<typeof analysisSucceededSchema>;

export const analysisFailedSchema = z.object({
  ...runIdentity,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  error: z.string(),
  /**
   * Whether `apps/ml` has an attempt left. While true the analysis stays
   * QUEUED/PROCESSING and only `inference_runs` records the miss, so a
   * transient GPU or download error never shows a creator a failed job that
   * the queue is about to retry.
   */
  retryable: z.boolean(),
});
export type AnalysisFailed = z.infer<typeof analysisFailedSchema>;

// ─── poller → ml → poller (the research corpus) ──────────────────────────────

/**
 * A symmetric second pair, mirroring the analysis path rather than borrowing
 * from it: `[corpus]` in, `[corpus-results]` out, persisted by `apps/poller`.
 *
 * ```text
 *   apps/poller ──add──▶ [corpus] ──▶ apps/ml ──▶ [corpus-results] ──▶ apps/poller
 *                                    same engine.py                        │
 *                                                                          ▼
 *                                                                   corpus.scores
 * ```
 *
 * Two queues rather than reusing `analysis`, because corpus results land in
 * `corpus.scores` rather than `analysis_results` — so `apps/worker` needs no
 * changes at all, and a corpus backfill cannot starve or delay a customer job
 * in the queue.
 *
 * **The one thing that must stay shared is `engine.py`.** A separate queue is
 * not a separate inference path. If corpus features were computed by different
 * code than product features, the backtest would silently stop describing the
 * product, and no test would catch it. `apps/ml` consumes both queues and routes
 * both to the same engine; only the payload and result contracts differ.
 *
 * Corpus jobs skip the Anthropic insights step — recommendations are
 * creator-facing output, and 1,600 of them is spend on text nobody reads. That
 * is enforced by `apps/poller` simply never calling it; there is no field here
 * to turn it off, because there is no path that would turn it on.
 */

/** poller → ml. One job per acquired clip. */
export const CORPUS_QUEUE = 'corpus';

/** ml → poller. Outcome of the job above. */
export const CORPUS_RESULTS_QUEUE = 'corpus-results';

/** The only job name on {@link CORPUS_QUEUE}. */
export const CORPUS_JOB = 'corpus.score';

/**
 * Job names on {@link CORPUS_RESULTS_QUEUE}.
 *
 * There is no `started`, deliberately: no creator is watching a status column
 * and there is no row to walk from QUEUED to PROCESSING, so the event would
 * write nothing.
 */
export const CORPUS_RESULT_JOB = {
  succeeded: 'corpus.succeeded',
  failed: 'corpus.failed',
} as const;

export type CorpusResultJobName = (typeof CORPUS_RESULT_JOB)[keyof typeof CORPUS_RESULT_JOB];

export const corpusJobSchema = z.object({
  /** `corpus.posts.id`. */
  corpusPostId: z.uuid(),
  /** `corpus.clips.id` — a corpus job without an acquired clip has nothing to run. */
  clipId: z.uuid(),
  modality: modalitySchema,
  media: z.object({
    /** Short-lived signed URL to the clip in the private bucket. */
    url: z.url(),
  }),
});
export type CorpusJob = z.infer<typeof corpusJobSchema>;

/** Fields every corpus outcome carries. No workspace and no analysis — there is no tenant. */
const corpusRunIdentity = {
  corpusPostId: z.uuid(),
  clipId: z.uuid(),
  attempt: z.int().min(1),
  queueJobId: z.string(),
  device: z.string().nullish(),
};

export const corpusSucceededSchema = z.object({
  ...corpusRunIdentity,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.int().min(0),
  timeline: timelineSchema,
  durationSec: z.number().min(0).nullish(),
  transcript: z.array(transcriptEntrySchema).nullish(),
  /**
   * REQUIRED here, unlike `analysisSucceededSchema`.
   *
   * A corpus row exists only to yield a composite, which is a reduction over
   * these bands — so a score without them is a row that can never be ranked.
   * Rejecting it at the boundary is better than writing a null the extract
   * would have to filter, silently shrinking N for a reason nobody recorded.
   */
  axisBands: axisBandsSchema,
  stats: statsSchema,
});
export type CorpusSucceeded = z.infer<typeof corpusSucceededSchema>;

export const corpusFailedSchema = z.object({
  ...corpusRunIdentity,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  error: z.string(),
  retryable: z.boolean(),
});
export type CorpusFailed = z.infer<typeof corpusFailedSchema>;
