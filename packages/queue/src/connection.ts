import { Redis, type RedisOptions } from 'ioredis';
import type { DefaultJobOptions } from 'bullmq';

/**
 * Where Redis lives. `infra/docker/docker-compose.yml` serves the local one.
 *
 * Read at call time, not at import time, so a process that never touches the
 * queue (a test driving `app.request()`, say) does not need the variable set.
 */
export function redisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
}

/**
 * A Redis client wired the way BullMQ needs it.
 *
 * `maxRetriesPerRequest: null` is **required** for anything that runs a Worker:
 * workers block on `BZPOPMIN` for seconds at a time, and ioredis' default retry
 * cap counts that as a stalled request and throws. BullMQ refuses to start a
 * Worker on a connection without it. Producers do not strictly need it, but a
 * single factory keeps the two from drifting.
 *
 * The caller owns the returned client — BullMQ does not close connections it
 * did not create, so shut it down alongside the Queue/Worker.
 */
export function createRedisConnection(options: RedisOptions = {}): Redis {
  return new Redis(redisUrl(), {
    maxRetriesPerRequest: null,
    // A worker that outlives a Redis restart is worth more than one that exits
    // fast, and jobs are durable in Redis regardless.
    retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
    ...options,
  });
}

/**
 * Retention defaults for both queues.
 *
 * Completed jobs are kept briefly (enough to inspect a run in bull-board),
 * failures for a week — a failed job is the only place the ML stack trace
 * survives, since `analyses.error` only gets the one-line message.
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};
