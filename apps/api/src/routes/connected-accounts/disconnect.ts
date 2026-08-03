import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ConnectionStatus } from '@repo/db/enums';
import type { AuthEnv } from '../../middleware/auth';

const param = z.object({ id: z.uuid() });

/** Platform ToS require deletion after disconnect; 30 days is the tightest window. */
const PURGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `DELETE /connected-accounts/:id` — sever a connection.
 *
 * Tokens are dropped immediately; the row survives as DISCONNECTED so channels
 * and historical analyses keep their anchor, and `purgeAfter` hands the rest of
 * the platform data to the purge sweep (which also files the
 * `data_deletion_requests` audit row — not this route's job).
 */
export const disconnectAccount = new Hono<AuthEnv>().delete(
  '/:id',
  zValidator('param', param),
  async (c) => {
    const { id } = c.req.valid('param');

    const result = await c.var.db(async (tx) => {
      // RLS scopes the lookup, so an id in someone else's workspace reads as
      // nonexistent — same 404 as a random uuid, nothing to enumerate.
      const existing = await tx.connectedAccount.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) return null;

      return tx.connectedAccount.update({
        where: { id },
        data: {
          status: ConnectionStatus.DISCONNECTED,
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          disconnectedAt: new Date(),
          purgeAfter: new Date(Date.now() + PURGE_WINDOW_MS),
        },
        select: { id: true, status: true },
      });
    });

    if (!result) return c.json({ error: 'not_found' as const }, 404);
    return c.json(result, 200);
  },
);
