import { Queue, Worker } from 'bullmq';
import { prismaService } from '@repo/db';
import { QUEUE_PREFIX, createRedisConnection, redisUrl } from '@repo/queue';

import { handlePollJob } from './jobs.ts';
import { POLL_JOB, POLL_QUEUE, SCHEDULES } from './queues.ts';
import { loadSeeds } from './seeds.ts';

/**
 * `@repo/poller` — the corpus collector.
 *
 * Its own process for two reasons (spec §4a). It writes `corpus` tables through
 * `prismaService`, the BYPASSRLS credential `apps/api` must never hold — the
 * same reasoning that made `apps/worker` a separate process rather than a
 * second entrypoint. And it has a different lifecycle from both: cron-shaped
 * rather than request- or queue-shaped, and it must keep running on a schedule
 * whether or not anyone is using the product.
 */

const connection = createRedisConnection();

const queue = new Queue(POLL_QUEUE, { connection, prefix: QUEUE_PREFIX });

/**
 * Register the repeatable jobs.
 *
 * `jobId` is fixed per schedule so a restart re-registers rather than adding a
 * second scheduler — the failure mode that turns a daily poll into two daily
 * polls, each appending a snapshot the other's unique key then rejects.
 */
async function schedule(): Promise<void> {
  for (const [name, pattern] of [
    [POLL_JOB.poll, SCHEDULES.poll],
    [POLL_JOB.sweep, SCHEDULES.sweep],
    [POLL_JOB.readiness, SCHEDULES.readiness],
  ] as const) {
    await queue.upsertJobScheduler(
      name,
      { pattern, tz: 'UTC' },
      {
        name,
        // No `runAt` here, deliberately. BullMQ reuses this template's `data`
        // verbatim for every occurrence — the scheduled slot goes into
        // `opts.prevMillis` and the job id, never into `data` — so a timestamp
        // baked in at registration would freeze and every later snapshot would
        // collide on `@@unique([postId, capturedAt])` and be skipped silently.
        // `resolveRunAt` derives it per run instead. See `jobs.ts`.
        data: {},
        opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
      },
    );
  }
}

const worker = new Worker(POLL_QUEUE, handlePollJob, {
  connection,
  prefix: QUEUE_PREFIX,
  // One at a time. These jobs walk the whole frame and hold a YouTube quota
  // budget; two concurrent polls would double the request rate for no gain.
  concurrency: 1,
  // A full poll of ~40 channels is minutes of sequential HTTP.
  lockDuration: 30 * 60 * 1000,
  removeOnComplete: { age: 30 * 24 * 3_600, count: 200 },
  removeOnFail: { age: 30 * 24 * 3_600 },
});

worker.on('failed', (job, error) => {
  console.error(`[poller] ${job?.name ?? 'job'} ${job?.id ?? '?'} failed:`, error.message);
});

worker.on('error', (error) => {
  console.error('[poller] worker error:', error);
});

// Fail at boot, loudly, rather than polling an empty frame in silence. A poller
// that runs against `channels: []` looks healthy in every dashboard and
// collects nothing.
const seeds = await loadSeeds();
await schedule();

console.log(
  `📡 resonance-poller — ${seeds.length} seeded channels, ` +
    `consuming "${QUEUE_PREFIX}:${POLL_QUEUE}" on ${redisUrl()}`,
);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`\n[poller] ${signal} — draining…`);
  try {
    await worker.close();
    await queue.close();
    await prismaService.$disconnect();
    await connection.quit();
  } catch (error) {
    console.error('[poller] unclean shutdown:', error);
    process.exitCode = 1;
  }
  process.exit();
}

function onSignal(signal: NodeJS.Signals): void {
  shutdown(signal).catch((error: unknown) => {
    console.error('[poller] shutdown failed:', error);
    process.exit(1);
  });
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
