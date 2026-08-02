import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

interface Job {
  jobId: string;
  status: JobStatus;
  mediaUrl: string;
  modality: 'video' | 'audio';
  createdAt: number;
  result: { score: number } | null;
}

// TODO: replace with a real queue (BullMQ/Redis) + persistence (Prisma / @repo/db).
// In-memory placeholder so the RPC surface is real and typed today.
const jobs = new Map<string, Job>();

const analyzeBody = z.object({
  mediaUrl: z.string().url(),
  modality: z.enum(['video', 'audio']).default('video'),
});

/**
 * Analyze endpoints. In production `POST /analyze` enqueues a job that the
 * Python ML worker (apps/ml) consumes; the client polls `GET /analyze/:jobId`.
 */
export const analyze = new Hono()
  .post('/', zValidator('json', analyzeBody), (c) => {
    const { mediaUrl, modality } = c.req.valid('json');
    const job: Job = {
      jobId: crypto.randomUUID(),
      status: 'queued',
      mediaUrl,
      modality,
      createdAt: Date.now(),
      result: null,
    };
    jobs.set(job.jobId, job);
    // TODO: enqueue -> apps/ml worker fills `result`.
    return c.json({ jobId: job.jobId, status: job.status }, 202);
  })
  .get('/:jobId', (c) => {
    const job = jobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'job_not_found' as const }, 404);
    return c.json(job);
  });
