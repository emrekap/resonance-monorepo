import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
// The leaf enums module, never the `@repo/db` barrel: `status` and `kind` reach
// `dist/app.d.ts`, and the barrel would drag `client.ts` into the Expo typecheck.
import { AnalysisStatus, MediaKind } from '@repo/db/enums';
import type { AuthEnv } from '../../middleware/auth';
import { pageQuery, paginated, repeatable } from '../../lib/pagination';
import { resolveWorkspaceId } from '../../lib/workspace';

const query = pageQuery(['createdAt', 'completedAt', 'resonanceScore'], 'createdAt')
  .extend({
    /** Omit for the caller's personal workspace. */
    workspaceId: z.uuid().optional(),
    /** Repeatable: `?status=QUEUED&status=PROCESSING` is the "running" filter. */
    status: repeatable(z.enum(AnalysisStatus)),
    kind: repeatable(z.enum(MediaKind)),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
  })
  .refine((q) => !q.createdAfter || !q.createdBefore || q.createdAfter <= q.createdBefore, {
    message: 'createdAfter must be on or before createdBefore',
    path: ['createdAfter'],
  });

/**
 * `GET /analyze` — the caller's analyses, paginated, filtered and sorted.
 *
 * Scoped to one workspace like every other list: RLS has already narrowed
 * `analyses` to workspaces the caller belongs to, and the explicit
 * `workspaceId` narrows further to the one asked for. A workspace the caller
 * is not a member of resolves to null and answers 404 rather than confirming
 * it exists.
 *
 * `findMany` and `count` share a `where` and run in the same transaction, so
 * the `total` cannot describe a different set of rows than the page it ships
 * with. Sequential rather than concurrent: an interactive transaction is one
 * connection.
 */
export const listAnalyses = new Hono<AuthEnv>().get('/', zValidator('query', query), async (c) => {
  const {
    workspaceId: requested,
    status,
    kind,
    createdAfter,
    createdBefore,
    limit,
    offset,
    sort,
    order,
  } = c.req.valid('query');
  const { id: profileId } = c.get('user');

  const found = await c.var.db(async (tx) => {
    const workspaceId = await resolveWorkspaceId(tx, profileId, requested);
    if (!workspaceId) return null;

    // An omitted filter contributes nothing, rather than a clause that matches
    // everything — Prisma treats `undefined` as absent, so the shapes agree.
    const where = {
      workspaceId,
      status: status ? { in: status } : undefined,
      mediaAsset: kind ? { kind: { in: kind } } : undefined,
      createdAt:
        createdAfter || createdBefore ? { gte: createdAfter, lte: createdBefore } : undefined,
    };

    const rows = await tx.analysis.findMany({
      where,
      // Always a pair. Under offset paging the second key is load-bearing:
      // `completedAt` is null for every unfinished row and `resonanceScore` is
      // null for every row a workspace made before its fifth (the score is a
      // rank, and `apps/worker` withholds it until there is a history to rank
      // against), so without a deterministic tiebreak Postgres may order equal
      // rows differently between two requests and page 2 repeats one row while
      // skipping another. `id` is a UUIDv7, so `id desc` is also a sane
      // creation-order fallback.
      orderBy:
        sort === 'resonanceScore'
          ? [{ result: { resonanceScore: { sort: order, nulls: 'last' } } }, { id: 'desc' }]
          : sort === 'completedAt'
            ? [{ completedAt: { sort: order, nulls: 'last' } }, { id: 'desc' }]
            : [{ createdAt: order }, { id: 'desc' }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        status: true,
        error: true,
        createdAt: true,
        completedAt: true,
        // `byteSize` is deliberately absent: a Prisma BigInt throws on JSON
        // serialisation. No media URL either — a Storage object needs a signed
        // URL per row, which is one HTTP round trip each for something no row
        // renders.
        mediaAsset: {
          select: { id: true, kind: true, fileName: true, mimeType: true, durationSec: true },
        },
        result: {
          select: { resonanceScore: true, percentileInChannel: true, confidence: true },
        },
      },
    });

    const total = await tx.analysis.count({ where });
    return { rows, total };
  });

  if (!found) return c.json({ error: 'workspace_not_found' as const }, 404);

  const items = found.rows.map(({ mediaAsset, ...analysis }) => ({
    ...analysis,
    media: mediaAsset,
  }));

  // The explicit 200 keeps `res.status === 404` narrowing on the client.
  return c.json(paginated(items, { limit, offset }, found.total), 200);
});
