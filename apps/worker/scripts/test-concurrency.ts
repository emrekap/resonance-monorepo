/**
 * Proves two `analysis-results` jobs for the *same* analysis can run at once.
 *
 *   bun run test:concurrency
 *
 * The worker runs at concurrency 8, and `started` + `succeeded` for one analysis
 * routinely land together — the ML worker publishes them seconds apart, and any
 * restart drains a backlog holding both. Their transactions overlap on
 * `analyses`, `inference_runs` and `analysis_results`, so if two handlers ever
 * take those row locks in a different order Postgres kills one with 40P01 —
 * burning a retry on a cycle that will still be there when it comes back.
 *
 * Safe to run against the dev project: it creates its own QUEUED analyses under
 * an existing workspace/media asset and deletes them at the end — the cascade
 * takes the `inference_runs` and `analysis_results` rows with them.
 */
import type { Job } from 'bullmq';
import { prismaService } from '@repo/db';
import { AnalysisStatus } from '@repo/db/enums';
import { RESULT_JOB } from '@repo/queue';
import { handleResult } from '../src/results.ts';
import { MIN_HISTORY } from '../src/scoring.ts';

// Enough rounds that the later ones clear MIN_HISTORY and actually score,
// rather than only proving the writes do not deadlock.
const ROUNDS = Number(process.env.ROUNDS ?? Math.max(10, MIN_HISTORY + 3));

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** BullMQ only hands the processor a name and a payload; nothing else is read. */
function job(name: string, data: unknown): Job<unknown> {
  return { name, data } as unknown as Job<unknown>;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isDeadlock = (error: unknown) => /40P01|deadlock/i.test(reason(error));

/**
 * Bands that climb with the round, so each analysis out-ranks the last.
 *
 * The scoring path only engages once a workspace has {@link MIN_HISTORY} prior
 * succeeded analyses, and it reads that history from `raw_stats.bands` — so a
 * race that writes constant bands would exercise the writes without ever
 * exercising the ranking.
 */
function bandsFor(round: number) {
  const summary = (base: number) => ({ mean: base, std: 1 + base, peak: 2 + base });
  return {
    visual: summary(round),
    audio: summary(round + 0.5),
    language: summary(round + 0.25),
    emotional: summary(round + 0.75),
    memorability: summary(round + 0.1),
  };
}

const asset = await prismaService.mediaAsset.findFirst({
  select: { id: true, workspaceId: true },
  orderBy: { createdAt: 'desc' },
});

if (!asset) {
  console.error('no media_assets row to hang a throwaway analysis off — upload one first');
  process.exit(1);
}

// Connect before the race so the first round pays no handshake and both
// transactions actually start together.
await prismaService.$queryRaw`select 1`;

const created: string[] = [];
let deadlocks = 0;

/**
 * Races `started` against one terminal outcome for a fresh analysis.
 *
 * Both are dispatched in the same tick, which is what the eight-slot worker does
 * with a drained backlog — and is enough to interleave the two transactions
 * statement for statement.
 */
async function race(
  round: number,
  outcome: 'succeeded' | 'failed',
  on: { id: string; workspaceId: string },
): Promise<void> {
  const analysis = await prismaService.analysis.create({
    data: { workspaceId: on.workspaceId, mediaAssetId: on.id, status: AnalysisStatus.QUEUED },
    select: { id: true },
  });
  created.push(analysis.id);

  const startedAt = new Date().toISOString();
  const finishedAt = new Date(Date.now() + 1_000).toISOString();
  const identity = { analysisId: analysis.id, attempt: 1, queueJobId: analysis.id, device: 'cpu' };
  const label = `round ${round} (started × ${outcome})`;

  const terminal =
    outcome === 'succeeded'
      ? job(RESULT_JOB.succeeded, {
          ...identity,
          startedAt,
          finishedAt,
          durationMs: 1_000,
          // All five arrays, so `timelineColumns` accepts the row and the write
          // exercises the length constraint rather than falling back to
          // raw_stats. A two-segment timeline is the shortest that does.
          timeline: {
            startSec: [0, 1.49],
            attention: [0.1, 0.2],
            visual: [0.3, 0.4],
            audio: [0.5, 0.6],
            language: [0.7, 0.8],
          },
          durationSec: 2.98,
          transcript: [
            { startSec: 0, text: 'concurrency probe' },
            { startSec: 1.49, text: '' },
          ],
          axisBands: bandsFor(round),
          stats: {
            globalMean: 0,
            globalStd: 1,
            globalMin: -3,
            globalMax: 3,
            nTimesteps: 2,
            nVertices: 10,
          },
        })
      : job(RESULT_JOB.failed, {
          ...identity,
          startedAt,
          finishedAt,
          error: 'RuntimeError: concurrency probe',
          retryable: false,
        });

  const settled = await Promise.allSettled([
    handleResult(job(RESULT_JOB.started, { ...identity, startedAt })),
    handleResult(terminal),
  ]);

  for (const [index, result] of settled.entries()) {
    const which = index === 0 ? 'started' : outcome;
    if (result.status === 'rejected') {
      if (isDeadlock(result.reason)) deadlocks++;
      check(`${label}: ${which} committed`, false, reason(result.reason).slice(0, 120));
    } else {
      check(`${label}: ${which} committed`, true);
    }
  }

  // Both events landing matters as much as neither erroring: the terminal
  // outcome must win the status even when `started` is the one that arrives
  // late. `analyses.started_at` is deliberately not asserted — a `started` that
  // loses the race finds a finished analysis and correctly declines to touch it.
  const row = await prismaService.analysis.findUniqueOrThrow({
    where: { id: analysis.id },
    select: {
      status: true,
      completedAt: true,
      result: {
        select: {
          analysisId: true,
          rawStats: true,
          resonanceScore: true,
          percentileInChannel: true,
          timelineStartSec: true,
          timelineVisual: true,
          axisScores: { select: { axis: true, position: true } },
        },
      },
      inferenceRuns: { select: { finishedAt: true } },
    },
  });

  const expected = outcome === 'succeeded' ? AnalysisStatus.SUCCEEDED : AnalysisStatus.FAILED;
  check(`${label}: status ${expected}`, row.status === expected, row.status);
  check(`${label}: completedAt written`, !!row.completedAt);
  check(
    `${label}: result row ${outcome === 'succeeded' ? 'written' : 'absent'}`,
    outcome === 'succeeded' ? !!row.result : !row.result,
  );
  check(
    `${label}: one finished inference run`,
    row.inferenceRuns.length === 1 && !!row.inferenceRuns[0]?.finishedAt,
    `${row.inferenceRuns.length} run(s)`,
  );

  if (outcome !== 'succeeded') return;

  // The five arrays must land together — the length constraint rejects the row
  // otherwise, and it would do so on every retry.
  check(
    `${label}: timeline written`,
    row.result?.timelineStartSec.length === 2 && row.result.timelineVisual.length === 2,
    `${row.result?.timelineStartSec.length ?? 0} / ${row.result?.timelineVisual.length ?? 0}`,
  );

  // Every future percentile in this workspace is ranked against these.
  const bands = (row.result?.rawStats as { bands?: Record<string, unknown> } | null)?.bands;
  check(`${label}: raw_stats.bands persisted`, !!bands && Object.keys(bands).length === 5);

  // A redelivery must overwrite the five rows, never append a sixth.
  const axes = row.result?.axisScores ?? [];
  check(
    `${label}: axis rows are 5 or 0, never duplicated`,
    axes.length === 5 || axes.length === 0,
    `${axes.length} row(s)`,
  );
  if (axes.length === 5) {
    check(
      `${label}: axis positions are 0..4 exactly once`,
      new Set(axes.map((axis) => axis.position)).size === 5,
    );
  }

  // Scoring engages only above MIN_HISTORY; below it both must be null together,
  // never one without the other.
  const scored = row.result?.resonanceScore !== null;
  check(
    `${label}: score and percentile agree on presence`,
    scored === (row.result?.percentileInChannel !== null),
  );
  check(
    `${label}: axis rows present iff scored`,
    scored === (axes.length === 5),
    `scored=${scored} axes=${axes.length}`,
  );
}

console.log(
  `\nracing started × succeeded and started × failed, ${ROUNDS} rounds each` +
    ` (rounds 1..${MIN_HISTORY} build the history scoring needs)`,
);

try {
  for (let round = 1; round <= ROUNDS; round++) {
    await race(round, 'succeeded', asset);
    await race(round, 'failed', asset);
  }
} finally {
  await prismaService.analysis.deleteMany({ where: { id: { in: created } } });
  console.log(`\ncleaned up ${created.length} throwaway analyses`);
}

console.log(`\n${passed} passed, ${failures.length} failed (${deadlocks} deadlocks)`);
for (const failure of failures) console.log(`  ✗ ${failure}`);

await prismaService.$disconnect();
process.exit(failures.length === 0 ? 0 : 1);
