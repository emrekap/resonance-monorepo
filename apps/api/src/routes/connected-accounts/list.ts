import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth';
import { resolveWorkspaceId } from '../../lib/workspace';

const query = z.object({
  /** Omit for the caller's personal workspace. */
  workspaceId: z.uuid().optional(),
});

/**
 * `GET /connected-accounts` — the workspace's platform connections.
 *
 * Several accounts per platform are expected (`@@unique` is on
 * `[workspaceId, platform, platformAccountId]`), so this is a flat list, not a
 * per-platform map. Token columns are never selected — they leave the DB only
 * for platform API calls, never for a client.
 */
export const listConnectedAccounts = new Hono<AuthEnv>().get(
  '/',
  zValidator('query', query),
  async (c) => {
    const { workspaceId: requested } = c.req.valid('query');
    const { id: profileId } = c.get('user');

    const accounts = await c.var.db(async (tx) => {
      const workspaceId = await resolveWorkspaceId(tx, profileId, requested);
      if (!workspaceId) return null;

      return tx.connectedAccount.findMany({
        where: { workspaceId },
        orderBy: { connectedAt: 'desc' },
        select: {
          id: true,
          platform: true,
          handle: true,
          status: true,
          scopes: true,
          connectedAt: true,
          lastSyncedAt: true,
        },
      });
    });

    if (!accounts) return c.json({ error: 'workspace_not_found' as const }, 404);
    return c.json({ accounts }, 200);
  },
);
