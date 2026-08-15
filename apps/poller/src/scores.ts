import { UnrecoverableError, type Job } from 'bullmq';
import { prismaService } from '@repo/db';
import {
  CORPUS_RESULT_JOB,
  corpusFailedSchema,
  corpusSucceededSchema,
  type CorpusSucceeded,
} from '@repo/queue';
import { composite } from '@repo/scoring';

/**
 * The `corpus-results` consumer: turns what `apps/ml` reports into
 * `corpus.scores`.
 *
 * The mirror image of `apps/worker/src/results.ts`, and deliberately much
 * smaller. There is no status column to advance, no `inference_runs` row, no
 * percentile and no insights step — a corpus row is raw upstream output plus
 * the one reduction the product also performs.
 */

export interface ScoreRow {
  postId: string;
  clipId: string;
  attempt: number;
  timelineStartSec: number[];
  timelineAttention: number[];
  timelineVisual: number[];
  timelineAudio: number[];
  timelineLanguage: number[];
  axisBands: CorpusSucceeded['axisBands'];
  transcript: CorpusSucceeded['transcript'];
  composite: number;
  device: string | null;
  durationMs: number;
}

export function scoreRow(result: CorpusSucceeded): ScoreRow {
  const { startSec, attention, visual, audio, language } = result.timeline;
  const curves = [startSec, attention, visual ?? [], audio ?? [], language ?? []];

  if (new Set(curves.map((c) => c.length)).size > 1) {
    // `apps/ml` already truncates a ragged timeline to the shortest curve,
    // where the reason for the mismatch is known. One arriving here means
    // something else produced it, and a retry will not fix that.
    throw new UnrecoverableError(
      `corpus ${result.corpusPostId}: timeline arrays disagree in length ` +
        `(${curves.map((c) => c.length).join(', ')})`,
    );
  }

  return {
    postId: result.corpusPostId,
    clipId: result.clipId,
    attempt: result.attempt,
    timelineStartSec: startSec,
    timelineAttention: attention,
    timelineVisual: visual ?? [],
    timelineAudio: audio ?? [],
    timelineLanguage: language ?? [],
    axisBands: result.axisBands,
    transcript: result.transcript ?? null,
    // The product's own reduction, imported rather than restated.
    composite: composite(result.axisBands),
    device: result.device ?? null,
    durationMs: result.durationMs,
  };
}

async function onSucceeded(result: CorpusSucceeded): Promise<void> {
  const row = scoreRow(result);
  // `@@unique([postId, attempt])` makes the write idempotent under
  // at-least-once delivery, the same way `inference_runs` does on the app side.
  await prismaService.corpusScore.upsert({
    where: { postId_attempt: { postId: row.postId, attempt: row.attempt } },
    create: {
      postId: row.postId,
      clipId: row.clipId,
      attempt: row.attempt,
      timelineStartSec: row.timelineStartSec,
      timelineAttention: row.timelineAttention,
      timelineVisual: row.timelineVisual,
      timelineAudio: row.timelineAudio,
      timelineLanguage: row.timelineLanguage,
      axisBands: row.axisBands,
      transcript: row.transcript ?? undefined,
      composite: row.composite,
      device: row.device,
      durationMs: row.durationMs,
    },
    update: {
      composite: row.composite,
      axisBands: row.axisBands,
      device: row.device,
      durationMs: row.durationMs,
    },
  });
}

export async function handleCorpusResult(job: Job<unknown>): Promise<void> {
  switch (job.name) {
    case CORPUS_RESULT_JOB.succeeded:
      return onSucceeded(corpusSucceededSchema.parse(job.data));
    case CORPUS_RESULT_JOB.failed: {
      const failure = corpusFailedSchema.parse(job.data);
      // Nothing to persist: a corpus post with no score simply has no row, and
      // the extract's own N tells the story. Logged so a systematically failing
      // backfill is visible rather than merely small.
      console.error(
        `[corpus] ${failure.corpusPostId} attempt ${failure.attempt} failed` +
          `${failure.retryable ? ' (will retry)' : ''}: ${failure.error}`,
      );
      return;
    }
    default:
      throw new UnrecoverableError(`unknown corpus result job "${job.name}"`);
  }
}
