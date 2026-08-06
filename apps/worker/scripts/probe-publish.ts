// TEMPORARY diagnostic — publishes one analysis.failed to the probe queue.
// Delete after.
import { Queue } from 'bullmq';
import { prismaService } from '@repo/db';
import { AnalysisStatus } from '@repo/db/enums';
import { RESULT_JOB, createRedisConnection } from '@repo/queue';

const label = process.argv[2] ?? 'probe';

const asset = await prismaService.mediaAsset.findFirstOrThrow({
  select: { id: true, workspaceId: true },
  orderBy: { createdAt: 'desc' },
});

const analysis = await prismaService.analysis.create({
  data: { workspaceId: asset.workspaceId, mediaAssetId: asset.id, status: AnalysisStatus.QUEUED },
  select: { id: true },
});

const connection = createRedisConnection();
const queue = new Queue('probe-results', { connection, prefix: 'resonance-probe' });
const now = new Date().toISOString();

await queue.add(
  RESULT_JOB.failed,
  {
    analysisId: analysis.id,
    attempt: 2,
    queueJobId: analysis.id,
    device: 'cpu',
    startedAt: now,
    finishedAt: now,
    error: 'RuntimeError: probe',
    retryable: false,
  },
  { jobId: `${analysis.id}:2:${RESULT_JOB.failed}` },
);

console.log(`published ${label} for ${analysis.id}`);

await queue.close();
connection.disconnect();
await prismaService.$disconnect();
