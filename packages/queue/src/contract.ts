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
 * `startSec` and `attention` are what TRIBE gives us directly. The three
 * modality bands need a Yeo-7 parcellation of the ~20 k fsaverage5 vertices
 * (see `docs/resonance-model-design.md` §1a), which does not exist yet — so
 * they are optional, and `apps/worker` writes the timeline only when all five
 * arrays are present. That is not politeness: `analysis_results` carries
 * `analysis_results_timeline_len_chk`, which requires the five arrays to be
 * equal-length or all empty, so a partial timeline would be rejected by
 * Postgres. Nothing here changes when the parcellation lands.
 */
export const timelineSchema = z.object({
  startSec: z.array(z.number()),
  attention: z.array(z.number()),
  visual: z.array(z.number()).nullish(),
  audio: z.array(z.number()).nullish(),
  language: z.array(z.number()).nullish(),
});
export type Timeline = z.infer<typeof timelineSchema>;

export const analysisSucceededSchema = z.object({
  ...runIdentity,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.int().min(0),
  timeline: timelineSchema,
  /**
   * Dev telemetry only — lands in `analysis_results.raw_stats`, never rendered
   * to a creator. `globalMean` is near zero by construction (the model predicts
   * z-scored fMRI), so it measures nothing about the content.
   */
  stats: z.object({
    globalMean: z.number(),
    globalStd: z.number(),
    globalMin: z.number(),
    globalMax: z.number(),
    nTimesteps: z.int().min(0),
    nVertices: z.int().min(0),
  }),
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
