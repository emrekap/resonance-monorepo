// TEMPORARY diagnostic — a --hot worker on an isolated queue, to see whether a
// module reload is what panics the Prisma query compiler. Delete after.
import { Worker } from 'bullmq';
import { createRedisConnection } from '@repo/queue';
import { handleResult } from '../src/results.ts';

const worker = new Worker('probe-results', handleResult, {
  connection: createRedisConnection(),
  prefix: 'resonance-probe',
  concurrency: 8,
});

worker.on('completed', (job) => console.log(`PROBE ok   ${job.name} ${job.id}`));
worker.on('failed', (job, error) => console.log(`PROBE FAIL ${job?.name} ${job?.id}: ${error.message}`));

console.log('probe worker up');
