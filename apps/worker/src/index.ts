import { Worker } from 'bullmq';
import { prismaService } from '@repo/db';
import { ANALYSIS_RESULTS_QUEUE, QUEUE_PREFIX, createRedisConnection, redisUrl } from '@repo/queue';
import { insightsEnabled } from './insights';
import { handleResult } from './results';

/**
 * `@repo/worker` — the queue consumer that persists ML output.
 *
 * Deliberately its own process: it connects as `app_service` (BYPASSRLS), the
 * credential `apps/api` must never hold. It also scales on a different axis —
 * the API scales with request volume, this scales with GPU throughput, which is
 * a fraction of it.
 */

const connection = createRedisConnection();

const worker = new Worker(ANALYSIS_RESULTS_QUEUE, handleResult, {
  connection,
  prefix: QUEUE_PREFIX,
  // These jobs are short database writes, not GPU work, so a few in flight is
  // free. Every handler is idempotent and order-independent, and each one takes
  // the `analyses` row lock first — which is what makes >1 safe here, since two
  // events for the *same* analysis routinely arrive together (see
  // `lockAnalysis` in results.ts).
  concurrency: 8,
  // Retention only. The retry policy lives on the job, so it is set by the
  // producer — `RESULT_ATTEMPTS` in apps/ml/worker.py.
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
});

worker.on('failed', (job, error) => {
  console.error(`[results] ${job?.name ?? 'job'} ${job?.id ?? '?'} failed:`, error.message);
});

worker.on('error', (error) => {
  // Connection-level problems. BullMQ reconnects on its own; log so a Redis
  // that is down does not look like a queue that is merely idle.
  console.error('[results] worker error:', error);
});

/**
 * The HOST only, never the URL: `REDIS_URL` carries a password, and a boot
 * banner is the easiest place in a codebase to leak one into a terminal or a
 * log aggregator. (Observed happening before this guard existed.)
 */
function redisHost(): string {
  try {
    return new URL(redisUrl()).host;
  } catch {
    return '<unparseable REDIS_URL>';
  }
}

console.log(
  `👷 resonance-worker consuming "${QUEUE_PREFIX}:${ANALYSIS_RESULTS_QUEUE}" on ${redisHost()}`,
);

// Said once at boot rather than per job: without a key every analysis still
// gets its score, axes and timeline, and only the "do this" notes are missing.
// A per-job warning would bury that in the log; silence would make a
// permanently empty section look like a bug in the model.
if (!insightsEnabled()) {
  console.warn(
    '[results] ANTHROPIC_API_KEY is unset — analyses will be scored but will carry no recommendations.',
  );
}

/**
 * Drain before exiting. `worker.close()` waits for in-flight handlers to finish
 * so a deploy cannot tear down a process midway through the transaction that
 * marks an analysis SUCCEEDED — the job would go back to the queue and be
 * retried, but the log would show a stall nobody could explain.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`\n[results] ${signal} — draining…`);
  try {
    await worker.close();
    await prismaService.$disconnect();
    await connection.quit();
  } catch (error) {
    console.error('[results] unclean shutdown:', error);
    process.exitCode = 1;
  }
  process.exit();
}

// `process.on` wants a void-returning handler. Handing it an async function
// leaves the drain unawaited and its rejections unhandled, so the promise is
// terminated here instead — a shutdown that fails should say so and exit
// non-zero, not vanish.
function onSignal(signal: NodeJS.Signals): void {
  shutdown(signal).catch((error: unknown) => {
    console.error('[results] shutdown failed:', error);
    process.exit(1);
  });
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
