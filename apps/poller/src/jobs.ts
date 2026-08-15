import { UnrecoverableError, type Job } from 'bullmq';
import { z } from 'zod';

import { buildReadiness, renderReadiness } from './readiness.ts';
import { createYouTubeClient } from './youtube.ts';
import { pollChannel, POSTS_PER_CHANNEL } from './poll.ts';
import { prismaStore } from './store.ts';
import { prismaSweepStore, sweepText } from './sweep.ts';
import { readMaturation } from './maturation.ts';
import { loadSeeds } from './seeds.ts';
import { POLL_JOB } from './queues.ts';

/**
 * What each scheduled job does.
 *
 * **Where `runAt` comes from.** Every snapshot a run appends is stamped with
 * it, and `@@unique([postId, capturedAt])` is what makes an at-least-once retry
 * a no-op — so a retry has to compute the SAME `runAt` as the attempt it is
 * retrying.
 *
 * It is therefore quantised to the UTC day rather than read raw from the clock,
 * and deliberately NOT carried on the repeatable job's payload. BullMQ's
 * `upsertJobScheduler` uses the template's `data` verbatim for every occurrence
 * it materialises — the scheduled slot lands in `opts.prevMillis` and in the
 * generated job id, never in `data` — so a timestamp baked into the template at
 * registration would freeze, every snapshot after the first would collide on
 * the unique key and be skipped, and the poller would report success while
 * writing nothing.
 *
 * An explicit `runAt` is still honoured, for backfilling one specific day by
 * hand.
 */

export const pollJobDataSchema = z.object({ runAt: z.iso.datetime().nullish() });
export type PollJobData = z.infer<typeof pollJobDataSchema>;

/** Midnight UTC of `moment`'s day. Idempotent. */
export function utcDayStart(moment: Date): Date {
  return new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()));
}

/**
 * The run's timestamp: the payload's if it carries one, else today's UTC day.
 *
 * A retry runs within minutes of its original against a 24-hour bucket, so the
 * day boundary is never in play at the 03:00 UTC schedule.
 */
export function resolveRunAt(data: unknown, now: Date = new Date()): Date {
  const { runAt } = pollJobDataSchema.parse(data ?? {});
  return runAt ? new Date(runAt) : utcDayStart(now);
}

export async function runPoll(data: unknown): Promise<void> {
  const at = resolveRunAt(data);
  const seeds = await loadSeeds();
  const youtube = createYouTubeClient();
  const store = prismaStore();

  let snapshots = 0;
  for (const seed of seeds) {
    // One channel's failure must not cost the other 39 their observation for
    // the day — a hole in a time series cannot be backfilled.
    try {
      const outcome = await pollChannel({
        seed,
        youtube,
        store,
        runAt: at,
        postsPerChannel: POSTS_PER_CHANNEL,
      });
      snapshots += outcome.snapshotsWritten;
      if (outcome.skipped) console.warn(`[poll] ${seed.id} skipped: ${outcome.skipped}`);
    } catch (error) {
      console.error(`[poll] ${seed.id} failed:`, error);
    }
  }

  console.log(
    `[poll] ${at.toISOString()} — ${seeds.length} channels, ${snapshots} snapshots appended`,
  );
}

export async function runSweep(data: unknown): Promise<void> {
  // The sweep's cutoff is a 30-day window, so the day bucket is precise enough
  // and keeps a retry from nulling a different set than the attempt it retries.
  const result = await sweepText({ now: resolveRunAt(data), store: prismaSweepStore() });
  console.log(`[sweep] nulled text on ${result.posts} posts, ${result.channels} channels`);
}

export async function runReadiness(data: unknown): Promise<void> {
  const now = resolveRunAt(data);
  const maturation = await readMaturation();
  const readiness = await buildReadiness({ now, maturation });
  const markdown = renderReadiness(readiness);

  const dir = process.env.CORPUS_REPORT_DIR ?? './out';
  const path = `${dir}/readiness-${now.toISOString().slice(0, 10)}.md`;
  await Bun.write(path, markdown);

  console.log(
    `[readiness] N=${maturation.nDays} (phase ${maturation.phase}) · ` +
      `${readiness.totals.clearingFloor}/${readiness.totals.channels} channels clear the post floor · ` +
      `${readiness.totals.ccbyClearingFloor} clear it in CC-BY · wrote ${path}`,
  );
}

export async function handlePollJob(job: Job<unknown>): Promise<void> {
  switch (job.name) {
    case POLL_JOB.poll:
      return runPoll(job.data);
    case POLL_JOB.sweep:
      return runSweep(job.data);
    case POLL_JOB.readiness:
      return runReadiness(job.data);
    default:
      throw new UnrecoverableError(`unknown poller job "${job.name}"`);
  }
}
