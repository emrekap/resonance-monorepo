/**
 * Run one scheduled job by hand, right now.
 *
 * `bun run dev` starts the scheduler, which registers the three repeatable jobs
 * and then waits for their cron slots — 03:00 UTC for the poll, 04:00 for the
 * sweep, 05:00 Monday for the readiness report. That is correct for a deployed
 * process and useless for a local one: it looks like nothing is happening,
 * because nothing is.
 *
 * This runs a job's handler directly instead:
 *
 *     bun run poll
 *     bun run sweep
 *     bun run readiness
 *     bun run poll -- --run-at 2026-08-15T00:00:00.000Z    # backfill one day
 *
 * **No Redis needed.** Only the scheduler touches the queue; the handlers
 * themselves talk to YouTube and Postgres and nothing else. So this works with
 * `REDIS_URL` unset or pointing at nothing.
 *
 * It DOES write to whatever `APP_SERVICE_DATABASE_URL` names, which for this
 * project is a real hosted Supabase — there is no local Postgres. The banner
 * below prints the host it is about to write to for exactly that reason. Re-
 * running the same job on the same UTC day is a genuine no-op (`capturedAt` is
 * quantised to the day and snapshot appends use `skipDuplicates`), so repeating
 * this is safe; polling a channel you did not mean to add is what is not.
 */

import { prismaService } from '@repo/db';

import { runPoll, runReadiness, runSweep } from '../src/jobs.ts';

const JOBS = {
  poll: runPoll,
  sweep: runSweep,
  readiness: runReadiness,
} as const;

type JobName = keyof typeof JOBS;

const NAMES = Object.keys(JOBS) as JobName[];

function isJobName(value: string | undefined): value is JobName {
  return value !== undefined && Object.hasOwn(JOBS, value);
}

function fail(message: string): never {
  console.error(`${message}\n`);
  console.error(`usage: bun run scripts/run-job.ts <${NAMES.join('|')}> [--run-at <iso-8601>]`);
  process.exit(2);
}

/**
 * The database host, with no credentials in it.
 *
 * Never interpolates the URL itself: `APP_SERVICE_DATABASE_URL` carries a
 * password, and a banner is the easiest place in a codebase to leak one into a
 * terminal someone screenshots.
 */
function databaseHost(): string {
  const url = process.env.APP_SERVICE_DATABASE_URL;
  if (!url) return '<APP_SERVICE_DATABASE_URL unset>';
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable APP_SERVICE_DATABASE_URL>';
  }
}

const argv = process.argv.slice(2);
const [name, ...rest] = argv;

if (!isJobName(name)) {
  fail(name === undefined ? 'no job named.' : `unknown job "${name}".`);
}

let runAt: string | undefined;
for (let i = 0; i < rest.length; i += 1) {
  const flag = rest[i];
  if (flag === '--run-at') {
    runAt = rest[i + 1];
    if (runAt === undefined) fail('--run-at needs an ISO-8601 timestamp.');
    i += 1;
  } else {
    fail(`unexpected argument "${flag ?? ''}".`);
  }
}

// Left to `pollJobDataSchema` in jobs.ts rather than validated here: that is
// the one place the payload shape is defined, and a second opinion about it
// here is how the two drift.
const data = runAt === undefined ? {} : { runAt };

console.log(
  `[run-job] ${name} → ${databaseHost()}${runAt === undefined ? '' : ` (runAt ${runAt})`}`,
);

try {
  await JOBS[name](data);
} catch (error) {
  console.error(`[run-job] ${name} failed:`, error);
  process.exitCode = 1;
} finally {
  // Without this the Prisma pool keeps the event loop alive and the process
  // hangs after the work is done.
  await prismaService.$disconnect();
}
