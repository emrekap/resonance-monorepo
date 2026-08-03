import { Queue } from 'bullmq';
import {
  ANALYSIS_QUEUE,
  ANALYZE_JOB,
  DEFAULT_JOB_OPTIONS,
  QUEUE_PREFIX,
  createRedisConnection,
  type AnalysisJob,
} from '@repo/queue';

/**
 * The producer side of the `analysis` queue.
 *
 * `apps/api` only ever writes here. It does not consume anything: the Python
 * worker takes these jobs, and `apps/worker` — a separate process, because it
 * holds the BYPASSRLS credential this one must not — consumes the results.
 */

let queue: Queue<AnalysisJob> | undefined;

/**
 * Connect on first enqueue, not on import — the same reason `@repo/db` is lazy.
 * Importing `app.ts` in a test that never hits `/analyze` should not open a
 * socket to a Redis that may not be running.
 */
function analysisQueue(): Queue<AnalysisJob> {
  return (queue ??= new Queue<AnalysisJob>(ANALYSIS_QUEUE, {
    connection: createRedisConnection(),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      // GPU inference fails for transient reasons (a cold Space, a flaky
      // download) far more often than for bad input, so retry — but with a
      // wide backoff, since an immediate retry just re-hits whatever is down.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  }));
}

/**
 * Hand an analysis to the ML worker.
 *
 * `jobId` is the analysis id, which makes this idempotent: BullMQ silently
 * ignores an `add` whose id already exists, so a client that retries a POST it
 * never saw the response to cannot queue the same GPU job twice.
 *
 * Throws if Redis is unreachable — the caller must decide what the half-written
 * analysis row becomes, and `POST /analyze` marks it FAILED rather than leaving
 * a row that says QUEUED forever.
 */
export async function enqueueAnalysis(job: AnalysisJob): Promise<void> {
  await analysisQueue().add(ANALYZE_JOB, job, { jobId: job.analysisId });
}

/** Release the connection. For tests and graceful shutdown; a no-op if unused. */
export async function closeAnalysisQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
