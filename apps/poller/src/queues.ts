/**
 * The poller's own scheduling queue.
 *
 * Deliberately NOT in `@repo/queue`: nothing outside this process produces to
 * it or consumes from it, so it is not a contract with anyone. The corpus
 * queues that DO cross a process boundary (`corpus` / `corpus-results`, to and
 * from `apps/ml`) live in `@repo/queue` with the analysis pair.
 *
 * BullMQ repeatable jobs rather than `setInterval` or an ECS scheduled task:
 * they survive restarts, deduplicate across replicas, and are visible in the
 * bull-board already running in `infra/docker/`. Redis is already a dependency,
 * so this adds no infrastructure (spec §4a).
 */

export const POLL_QUEUE = 'corpus-poll';

export const POLL_JOB = {
  poll: 'corpus.poll',
  sweep: 'corpus.sweep',
  readiness: 'corpus.readiness',
} as const;

export type PollJobName = (typeof POLL_JOB)[keyof typeof POLL_JOB];

/**
 * UTC cron expressions.
 *
 * The sweep runs an hour AFTER the poll so a row the poll just refreshed is
 * never swept in the same night — the two would otherwise race on
 * `textRefreshedAt` and null text the poller had just re-read.
 */
export const SCHEDULES = {
  poll: '0 3 * * *',
  sweep: '0 4 * * *',
  readiness: '0 5 * * 1',
} as const;
