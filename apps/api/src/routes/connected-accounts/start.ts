import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth';
import { mintConnectState } from '../../lib/oauth';
import { connectCallbackUrl, PLATFORM_BY_PARAM, providerFor } from '../../lib/platforms';
import { resolveWorkspaceId } from '../../lib/workspace';

const param = z.object({
  platform: z.enum(['youtube', 'instagram', 'tiktok']),
});

const body = z.object({
  /** Omit for the caller's personal workspace. */
  workspaceId: z.uuid().optional(),
  /** App deep link the callback sends the browser back to (resonance://…, exp://…). */
  returnTo: z.url(),
});

/**
 * `POST /connected-accounts/:platform/start` — mint the provider authorize URL.
 *
 * The client opens the URL in a browser; consent ends at the API's `/callback`,
 * which is a bare redirect with no auth header — so everything the callback
 * must know (caller, workspace, platform, where to bounce the browser) is
 * HMAC-signed into `state` here, while the request still has a verified JWT.
 * Expiry is 10 minutes: the state authorizes one consent hop, nothing more.
 */
export const startConnect = new Hono<AuthEnv>().post(
  '/:platform/start',
  zValidator('param', param),
  zValidator('json', body),
  async (c) => {
    const platform = PLATFORM_BY_PARAM[c.req.valid('param').platform];
    const { workspaceId: requested, returnTo } = c.req.valid('json');
    const { id: profileId } = c.get('user');

    const provider = providerFor(platform);
    if (!provider) return c.json({ error: 'platform_not_configured' as const }, 501);

    const workspaceId = await c.var.db((tx) => resolveWorkspaceId(tx, profileId, requested));
    if (!workspaceId) return c.json({ error: 'workspace_not_found' as const }, 404);

    const { signed } = mintConnectState({ profileId, workspaceId, platform, returnTo });
    const url = provider.authorizeUrl({ state: signed, redirectUri: connectCallbackUrl() });

    return c.json({ url }, 200);
  },
);
