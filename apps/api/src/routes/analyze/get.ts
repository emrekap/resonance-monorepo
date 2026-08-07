import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth';
import { externalUrl } from '../../lib/media';

const param = z.object({ id: z.uuid() });

/**
 * `GET /analyze/:jobId` — the client's poll.
 *
 * There is no ownership filter here, deliberately. `c.var.db` runs the query
 * inside `withUser()`, so `analyses_select` has already narrowed the visible
 * rows to the caller's workspaces: another workspace's job reads back as null
 * and answers 404. Adding a `where workspaceId` would duplicate the policy in
 * application code, which is the failure mode the role split exists to prevent.
 *
 * Validating the param as a uuid is not cosmetic either — an unparseable id
 * would otherwise reach Postgres and come back a 500 instead of a 400.
 */
export const getAnalysisById = new Hono<AuthEnv>().get(
  '/:id',
  zValidator('param', param),
  async (c) => {
    const { id } = c.req.valid('param');

    const analysis = await c.var.db((tx) =>
      tx.analysis.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          workspaceId: true,
          error: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          mediaAsset: { select: { id: true, kind: true, storageBucket: true, storagePath: true } },
          result: {
            select: {
              resonanceScore: true,
              percentileInChannel: true,
              confidence: true,
              // The five parallel arrays are always read whole — the length
              // constraint on the table guarantees they agree, so the client can
              // zip them by index without checking.
              timelineStartSec: true,
              timelineAttention: true,
              timelineVisual: true,
              timelineAudio: true,
              timelineLanguage: true,
              // Ordered here rather than on the client: `position` and `priority`
              // exist precisely so the reading order is the server's decision.
              axisScores: {
                select: { axis: true, score: true, confidence: true },
                orderBy: { position: 'asc' },
              },
              recommendations: {
                select: {
                  kind: true,
                  message: true,
                  targetStartSec: true,
                  targetStopSec: true,
                },
                orderBy: { priority: 'asc' },
              },
            },
          },
        },
      }),
    );

    if (!analysis) return c.json({ error: 'job_not_found' as const }, 404);

    // The explicit 200 matters to callers: without it Hono types this branch as
    // `ContentfulStatusCode`, which overlaps 404, and `if (res.status === 404)`
    // stops narrowing on the client.
    return c.json(
      {
        jobId: analysis.id,
        status: analysis.status,
        workspaceId: analysis.workspaceId,
        error: analysis.error,
        createdAt: analysis.createdAt,
        startedAt: analysis.startedAt,
        completedAt: analysis.completedAt,
        media: {
          id: analysis.mediaAsset.id,
          kind: analysis.mediaAsset.kind,
          url: externalUrl(analysis.mediaAsset),
        },
        result: analysis.result,
      },
      200,
    );
  },
);
