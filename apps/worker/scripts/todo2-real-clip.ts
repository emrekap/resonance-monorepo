/**
 * End-to-end smoke: one clip through the whole analysis path, no client needed.
 *
 *     enqueue → [analysis] → apps/ml worker.py (GPU) → [analysis-results]
 *             → apps/worker → analyses / analysis_results / axis scores
 *
 * Seeds a REAL `media_assets` + `analyses` pair in the caller's most recent
 * workspace (BYPASSRLS via prismaService — the same credential apps/worker
 * holds), enqueues the job, then watches the analysis row until a running
 * apps/worker has persisted the outcome, and prints what landed: the five
 * timeline array lengths, axis-score rows with their confidence labels,
 * `inference_runs`, and the recommendation count. First run 2026-08-15 closed
 * CLAUDE.md's "run a real clip through ml → worker → Postgres" TODO.
 *
 * Needs two things running: a GPU worker consuming `[analysis]` (the HF Space,
 * or `ML_BACKEND=synthetic python worker.py` for a GPU-less smoke) and a local
 * results consumer (`cd apps/worker && bun run dev`). Then:
 *
 *     bun run scripts/todo2-real-clip.ts <media-url>
 *
 * The media URL must be plainly fetchable by the ml worker (no auth headers).
 * Rows it seeds are real rows in your workspace — the analysis shows up in the
 * app's History like any other, which is the point of a smoke test.
 */

import { Queue } from 'bullmq';

import { prismaService } from '@repo/db';
import { AnalysisStatus, MediaKind, MediaSource, MediaStatus } from '@repo/db/enums';
import { ANALYSIS_QUEUE, ANALYZE_JOB, QUEUE_PREFIX, createRedisConnection } from '@repo/queue';

const mediaUrl = process.argv[2];
if (!mediaUrl) {
  console.error('usage: bun run scripts/todo2-real-clip.ts <media-url>');
  process.exit(2);
}

const TIMEOUT_MS = 25 * 60 * 1000;

// The most recent workspace with a member — the caller's own. Printed before
// anything is written so a surprise here is visible immediately.
const membership = await prismaService.workspaceMember.findFirst({
  orderBy: { joinedAt: 'desc' },
  include: { workspace: true },
});
if (!membership) {
  console.error('no workspace with a member exists — sign into the app once first');
  process.exit(1);
}
console.log(`[seed] workspace "${membership.workspace.name}" (${membership.workspaceId})`);

const asset = await prismaService.mediaAsset.create({
  data: {
    workspaceId: membership.workspaceId,
    uploadedById: membership.profileId,
    kind: MediaKind.VIDEO,
    source: MediaSource.UPLOAD,
    status: MediaStatus.READY,
    storagePath: `smoke/todo2-${Date.now()}.mp4`,
    fileName: 'todo2-real-clip.mp4',
    mimeType: 'video/mp4',
  },
});
const analysis = await prismaService.analysis.create({
  data: {
    workspaceId: membership.workspaceId,
    mediaAssetId: asset.id,
    requestedById: membership.profileId,
    status: AnalysisStatus.QUEUED,
  },
});
console.log(`[seed] analysis ${analysis.id} (QUEUED), asset ${asset.id}`);

const connection = createRedisConnection();
const queue = new Queue(ANALYSIS_QUEUE, { connection, prefix: QUEUE_PREFIX });
await queue.add(
  ANALYZE_JOB,
  {
    analysisId: analysis.id,
    workspaceId: membership.workspaceId,
    modality: 'video',
    media: { assetId: asset.id, url: mediaUrl },
  },
  { jobId: analysis.id, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
);
console.log(`[enqueue] ${mediaUrl}`);

const started = Date.now();
let status: string = analysis.status;
while (Date.now() - started < TIMEOUT_MS) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const row = await prismaService.analysis.findUnique({
    where: { id: analysis.id },
    select: { status: true, error: true },
  });
  if (row && row.status !== status) {
    status = row.status;
    console.log(`[status] ${status}${row.error ? ` — ${row.error}` : ''}`);
  }
  if (status === 'SUCCEEDED' || status === 'FAILED') break;
}

// Insights commit AFTER the status flips SUCCEEDED (writeRecommendations runs
// once the scoring transaction is done), so reading immediately reports
// `recommendations: 0` spuriously — the first run of this script did exactly
// that. Give the Anthropic call a moment and read `raw_stats.insight` to know
// whether it settled.
if (status === 'SUCCEEDED') {
  for (let i = 0; i < 12; i += 1) {
    const row = await prismaService.analysisResult.findUnique({
      where: { analysisId: analysis.id },
      select: { rawStats: true },
    });
    if ((row?.rawStats as { insight?: unknown } | null)?.insight) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

// What actually landed — the point of the exercise: the five timeline arrays
// in `analysis_results` are the headline.
const result = await prismaService.analysisResult.findUnique({
  where: { analysisId: analysis.id },
});
const axisScores = await prismaService.analysisAxisScore.findMany({
  where: { analysisId: analysis.id },
  orderBy: { position: 'asc' },
});
const runs = await prismaService.inferenceRun.findMany({
  where: { analysisId: analysis.id },
  select: { attempt: true, device: true, durationMs: true, error: true },
});
const recommendations = await prismaService.analysisRecommendation.count({
  where: { analysisId: analysis.id },
});

console.log('\n=== what landed in Postgres');
console.log(`analyses.status ............ ${status}`);
console.log(`inference_runs ............. ${JSON.stringify(runs)}`);
if (result) {
  const lengths = {
    startSec: result.timelineStartSec.length,
    attention: result.timelineAttention.length,
    visual: result.timelineVisual.length,
    audio: result.timelineAudio.length,
    language: result.timelineLanguage.length,
  };
  console.log(`timeline array lengths ..... ${JSON.stringify(lengths)}`);
  console.log(`resonance_score ............ ${result.resonanceScore}`);
  console.log(`percentile_in_channel ...... ${result.percentileInChannel}`);
  console.log(`raw_stats .................. ${JSON.stringify(result.rawStats)}`);
  console.log(
    `axis score rows ............ ${axisScores.length} ${JSON.stringify(axisScores.map((row) => `${row.axis}:${row.confidence}`))}`,
  );
  console.log(`recommendations ............ ${recommendations}`);
} else {
  console.log('analysis_results ........... NO ROW');
}

await queue.close();
connection.disconnect();
await prismaService.$disconnect();
process.exit(status === 'SUCCEEDED' && result ? 0 : 1);
