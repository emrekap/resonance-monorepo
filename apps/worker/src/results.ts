import { UnrecoverableError, type Job } from 'bullmq';
import { prismaService, type Prisma, type Tx } from '@repo/db';
import { AnalysisStatus } from '@repo/db/enums';
import {
  RESULT_JOB,
  analysisFailedSchema,
  analysisStartedSchema,
  analysisSucceededSchema,
  type AnalysisFailed,
  type AnalysisStarted,
  type AnalysisSucceeded,
  type Timeline,
} from '@repo/queue';

/**
 * The `analysis-results` consumer: turns what `apps/ml` reports into rows.
 *
 * This is the *only* process that writes ML output, and it does so through
 * `prismaService` — the `app_service` role, which has BYPASSRLS because writing
 * a result for a user it is not acting as legitimately crosses the tenant
 * boundary. That credential is why this is a separate process from `apps/api`
 * rather than a second entrypoint inside it.
 *
 * Every handler is idempotent. BullMQ is at-least-once, so the same outcome can
 * arrive twice — and out of order relative to its own `started`.
 */

/**
 * Takes the one row every handler for this analysis must queue behind.
 *
 * The three handlers write overlapping sets of rows — `analyses`,
 * `inference_runs`, `analysis_results` — and the worker runs eight at a time, so
 * `started` and its `succeeded`/`failed` regularly overlap: they are published
 * seconds apart, and any restart drains a backlog holding both. Two
 * transactions touching the same rows in opposite order is a deadlock, and
 * Postgres resolves it by killing one (40P01). The producer does give these
 * jobs a few attempts, but spending them re-entering a lock cycle the code
 * created is not a policy — and a backlog large enough to deadlock twice is
 * exactly the moment the retries are needed for something else.
 *
 * Locking the parent first gives all three the same, single ordering point, so
 * the loser waits a few milliseconds instead of dying. `FOR NO KEY UPDATE` is
 * the lock the `analyses` UPDATE below would take anyway, and it deliberately
 * does not conflict with the `FOR KEY SHARE` that inserting a child row needs.
 *
 * Statement order inside the handlers is then free to change without
 * reintroducing the bug — which is why this is a lock and not a convention
 * about which write goes first.
 */
async function lockAnalysis(tx: Tx, analysisId: string): Promise<void> {
  await tx.$executeRaw`select id from public.analyses where id = ${analysisId}::uuid for no key update`;
}

/** BullMQ hands the processor a job whose `data` is still untrusted JSON. */
export async function handleResult(job: Job<unknown>): Promise<void> {
  switch (job.name) {
    case RESULT_JOB.started:
      return onStarted(analysisStartedSchema.parse(job.data));
    case RESULT_JOB.succeeded:
      return onSucceeded(analysisSucceededSchema.parse(job.data));
    case RESULT_JOB.failed:
      return onFailed(analysisFailedSchema.parse(job.data));
    default:
      // A name this build does not know will not start working on retry.
      throw new UnrecoverableError(`unknown result job "${job.name}"`);
  }
}

async function onStarted(result: AnalysisStarted): Promise<void> {
  const startedAt = new Date(result.startedAt);

  await prismaService.$transaction(async (tx) => {
    await lockAnalysis(tx, result.analysisId);

    // `updateMany` with `status: QUEUED` rather than `update`, so a `started`
    // that arrives after its own `succeeded` — reordered by two workers or a
    // retry — cannot walk a finished analysis back to PROCESSING.
    await tx.analysis.updateMany({
      where: { id: result.analysisId, status: AnalysisStatus.QUEUED },
      data: { status: AnalysisStatus.PROCESSING, startedAt },
    });

    await tx.inferenceRun.upsert({
      where: { analysisId_attempt: { analysisId: result.analysisId, attempt: result.attempt } },
      create: {
        analysisId: result.analysisId,
        attempt: result.attempt,
        queueJobId: result.queueJobId,
        device: result.device,
        startedAt,
      },
      update: { queueJobId: result.queueJobId, device: result.device, startedAt },
    });
  });
}

async function onSucceeded(result: AnalysisSucceeded): Promise<void> {
  const startedAt = new Date(result.startedAt);
  const finishedAt = new Date(result.finishedAt);
  const timeline = timelineColumns(result.timeline);

  const rawStats: Prisma.InputJsonObject = {
    ...result.stats,
    // Keep the real per-segment attention curve even when it cannot go in the
    // timeline columns yet (see timelineColumns) — recomputing it means another
    // GPU run.
    ...(timeline ? {} : { timeline: { ...result.timeline } }),
  };

  await prismaService.$transaction(async (tx) => {
    await lockAnalysis(tx, result.analysisId);

    await tx.inferenceRun.upsert({
      where: { analysisId_attempt: { analysisId: result.analysisId, attempt: result.attempt } },
      create: {
        analysisId: result.analysisId,
        attempt: result.attempt,
        queueJobId: result.queueJobId,
        device: result.device,
        durationMs: result.durationMs,
        startedAt,
        finishedAt,
      },
      update: {
        queueJobId: result.queueJobId,
        device: result.device,
        durationMs: result.durationMs,
        startedAt,
        finishedAt,
        error: null,
      },
    });

    // `resonanceScore`, `percentileInChannel` and `confidence` stay null on
    // purpose: the absolute 0–100 only ships once calibration is validated
    // (docs/resonance-model-design.md), and nothing in this pipeline computes
    // it yet. A placeholder number would read as a real one.
    await tx.analysisResult.upsert({
      where: { analysisId: result.analysisId },
      create: { analysisId: result.analysisId, rawStats, ...timelineData(timeline) },
      update: { rawStats, ...timelineData(timeline) },
    });

    await tx.analysis.update({
      where: { id: result.analysisId },
      data: {
        status: AnalysisStatus.SUCCEEDED,
        error: null,
        startedAt,
        completedAt: finishedAt,
      },
    });
  });
}

async function onFailed(result: AnalysisFailed): Promise<void> {
  const startedAt = new Date(result.startedAt);
  const finishedAt = new Date(result.finishedAt);

  await prismaService.$transaction(async (tx) => {
    await lockAnalysis(tx, result.analysisId);

    await tx.inferenceRun.upsert({
      where: { analysisId_attempt: { analysisId: result.analysisId, attempt: result.attempt } },
      create: {
        analysisId: result.analysisId,
        attempt: result.attempt,
        queueJobId: result.queueJobId,
        device: result.device,
        error: result.error,
        startedAt,
        finishedAt,
      },
      update: { device: result.device, error: result.error, startedAt, finishedAt },
    });

    // A retryable miss is an `inference_runs` row and nothing else: the analysis
    // stays PROCESSING because the queue is about to try again, and showing a
    // creator "failed" for an attempt that succeeds 30 seconds later is worse
    // than showing them "still working".
    if (result.retryable) return;

    await tx.analysis.update({
      where: { id: result.analysisId },
      data: { status: AnalysisStatus.FAILED, error: result.error, completedAt: finishedAt },
    });
  });
}

type TimelineColumns = {
  timelineStartSec: number[];
  timelineAttention: number[];
  timelineVisual: number[];
  timelineAudio: number[];
  timelineLanguage: number[];
};

/**
 * The five parallel arrays, or null when the modality bands are missing.
 *
 * `analysis_results_timeline_len_chk` requires all five to be equal-length or
 * all empty, so a timeline with only `startSec`/`attention` cannot be stored —
 * it would be rejected by Postgres, not silently truncated. The bands need a
 * Yeo-7 parcellation of the fsaverage5 vertices, which `apps/ml` does not do
 * yet; until it does, the curve rides along in `raw_stats`.
 */
function timelineColumns(timeline: Timeline): TimelineColumns | null {
  const { startSec, attention, visual, audio, language } = timeline;
  if (!visual || !audio || !language) return null;

  const lengths = [startSec, attention, visual, audio, language].map((a) => a.length);
  if (new Set(lengths).size > 1) {
    // Postgres would reject this too, but as a constraint violation on every
    // retry. A contract bug does not fix itself, so fail the job for good.
    throw new UnrecoverableError(`timeline arrays have mismatched lengths: ${lengths.join(',')}`);
  }

  return {
    timelineStartSec: startSec,
    timelineAttention: attention,
    timelineVisual: visual,
    timelineAudio: audio,
    timelineLanguage: language,
  };
}

/** Spread-safe: writes nothing at all when there is no complete timeline. */
function timelineData(columns: TimelineColumns | null): Partial<TimelineColumns> {
  return columns ?? {};
}
