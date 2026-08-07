import { UnrecoverableError, type Job } from 'bullmq';
import { prismaService, type Prisma, type Tx } from '@repo/db';
import { AnalysisStatus } from '@repo/db/enums';
import {
  RESULT_JOB,
  analysisFailedSchema,
  analysisStartedSchema,
  analysisSucceededSchema,
  axisBandsSchema,
  type AnalysisFailed,
  type AnalysisStarted,
  type AnalysisSucceeded,
  type AxisBands,
  type Timeline,
} from '@repo/queue';
import { generateRecommendations, insightsEnabled } from './insights';
import { scoreAnalysis } from './scoring';

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
  const bands = result.axisBands ?? null;

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

    // History is read *before* this analysis's own bands are written, or the
    // clip would be ranked against itself. The `not` on the id is belt and
    // braces for a redelivery, where the row already exists from attempt 1.
    const history = bands ? await workspaceHistory(tx, result.analysisId) : [];

    const scored = scoreAnalysis({
      bands: bands ?? EMPTY_BANDS,
      history,
      nSegments: result.timeline.startSec.length,
      hasSpeech: (result.transcript ?? []).some((entry) => entry.text.trim().length > 0),
    });

    const rawStats: Prisma.InputJsonObject = {
      ...result.stats,
      // The raw per-axis activations every future percentile in this workspace
      // is computed against. Kept here rather than in columns because they are
      // never queried individually — only read back as a set.
      ...(bands ? { bands: { ...bands } } : {}),
      // Keep the real per-segment attention curve even when it cannot go in the
      // timeline columns yet (see timelineColumns) — recomputing it means another
      // GPU run.
      ...(timeline ? {} : { timeline: { ...result.timeline } }),
    };

    await tx.analysisResult.upsert({
      where: { analysisId: result.analysisId },
      create: {
        analysisId: result.analysisId,
        rawStats,
        ...timelineData(timeline),
        resonanceScore: scored.resonanceScore,
        percentileInChannel: scored.percentileInChannel,
        confidence: scored.confidence,
      },
      update: {
        rawStats,
        ...timelineData(timeline),
        resonanceScore: scored.resonanceScore,
        percentileInChannel: scored.percentileInChannel,
        confidence: scored.confidence,
      },
    });

    // Upserted on (analysisId, axis) so a redelivery overwrites rather than
    // duplicating. No rows at all below MIN_HISTORY — see scoreAnalysis.
    for (const row of scored.axisRows) {
      await tx.analysisAxisScore.upsert({
        where: { analysisId_axis: { analysisId: result.analysisId, axis: row.axis } },
        create: { analysisId: result.analysisId, ...row },
        update: { score: row.score, confidence: row.confidence, position: row.position },
      });
    }

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

  // Everything a creator needs to read the result is committed above, and the
  // realtime channel has already pushed the status flip. The tips are the one
  // part of the screen allowed to arrive late — or not at all.
  await writeRecommendations(result, timeline);
}

/** Zeroed bands for a payload that predates the parcellation — scores to nulls anyway. */
const EMPTY_BANDS = {
  visual: 0,
  audio: 0,
  language: 0,
  emotional: 0,
  memorability: 0,
} as const;

/**
 * How many prior analyses a percentile is computed against.
 *
 * Bounded so a heavy workspace does not scan its whole history on every job,
 * and *recent* rather than random because a creator's style drifts — ranking
 * today's clip against work from a year ago answers a question nobody asked.
 */
const HISTORY_LIMIT = 200;

async function workspaceHistory(tx: Tx, analysisId: string): Promise<AxisBands[]> {
  const analysis = await tx.analysis.findUnique({
    where: { id: analysisId },
    select: { workspaceId: true },
  });
  if (!analysis) return [];

  const rows = await tx.analysisResult.findMany({
    where: {
      analysisId: { not: analysisId },
      analysis: { workspaceId: analysis.workspaceId, status: AnalysisStatus.SUCCEEDED },
    },
    select: { rawStats: true },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
  });

  // Rows written before the parcellation existed have no `bands` and are simply
  // absent from the ranking — which is also why this needs no backfill.
  return rows.flatMap((row) => {
    const parsed = axisBandsSchema.safeParse((row.rawStats as { bands?: unknown } | null)?.bands);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The insight stage: ask Claude for tips, then replace this analysis's rows.
 *
 * Never throws. A failure here must not fail the job — the analysis is already
 * SUCCEEDED and useful, and retrying would re-run the whole handler and re-bill
 * the call. The outcome is recorded on `raw_stats.insights` so a missing tips
 * section can be told apart from a model that had nothing to say.
 */
async function writeRecommendations(
  result: AnalysisSucceeded,
  timeline: TimelineColumns | null,
): Promise<void> {
  if (!insightsEnabled() || !timeline || !result.axisBands) return;

  try {
    // Read back rather than reuse the in-memory values: the scores this asks
    // about are the ones actually committed, and the media kind never crossed
    // the queue at all.
    const analysis = await prismaService.analysis.findUnique({
      where: { id: result.analysisId },
      select: {
        mediaAsset: { select: { kind: true } },
        result: {
          select: { percentileInChannel: true, axisScores: { orderBy: { position: 'asc' } } },
        },
      },
    });

    const recommendations = await generateRecommendations({
      modality: (analysis?.mediaAsset.kind ?? 'VIDEO').toLowerCase(),
      durationSec: result.durationSec ?? timeline.timelineStartSec.at(-1) ?? 0,
      timeline: result.timeline,
      transcript: result.transcript ?? [],
      axisRows: analysis?.result?.axisScores ?? [],
      percentileInChannel: analysis?.result?.percentileInChannel ?? null,
    });

    await prismaService.$transaction(async (tx) => {
      await lockAnalysis(tx, result.analysisId);
      // No natural key on this table, so replace rather than upsert — otherwise
      // a redelivered job appends a second copy of every tip.
      await tx.analysisRecommendation.deleteMany({ where: { analysisId: result.analysisId } });
      if (recommendations.length > 0) {
        await tx.analysisRecommendation.createMany({
          data: recommendations.map((item) => ({ analysisId: result.analysisId, ...item })),
        });
      }
      await mergeInsightStatus(tx, result.analysisId, {
        status: 'ok',
        count: recommendations.length,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${result.analysisId}] insight generation failed: ${message}`);
    try {
      await mergeInsightStatus(prismaService, result.analysisId, {
        status: 'failed',
        error: message.slice(0, 500),
      });
    } catch {
      // Recording *why* the tips are missing is strictly best-effort too.
    }
  }
}

/**
 * Merge a key into `raw_stats` without clobbering it.
 *
 * A whole-object write would drop the `bands` the first transaction stored, and
 * every future percentile in the workspace depends on them — so this reads,
 * merges and writes rather than overwriting.
 */
async function mergeInsightStatus(
  tx: Tx | typeof prismaService,
  analysisId: string,
  insights: Prisma.InputJsonObject,
): Promise<void> {
  const row = await tx.analysisResult.findUnique({
    where: { analysisId },
    select: { rawStats: true },
  });
  if (!row) return;

  const existing = (row.rawStats ?? {}) as Prisma.InputJsonObject;
  await tx.analysisResult.update({
    where: { analysisId },
    data: { rawStats: { ...existing, insights } },
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
