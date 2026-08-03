import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { withUser } from '@repo/db';
import { ConnectionStatus } from '@repo/db/enums';
import { sealToken, verifyConnectState } from '../../lib/oauth';
import { connectCallbackUrl, PARAM_BY_PLATFORM, providerFor } from '../../lib/platforms';
import { resolveWorkspaceId } from '../../lib/workspace';

const query = z.object({
  state: z.string(),
  code: z.string().optional(),
  error: z.string().optional(),
});

/** Bounce the browser back into the app with the outcome in the query string. */
function appRedirect(returnTo: string, params: Record<string, string>): string {
  const url = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * `GET /connected-accounts/callback` — where the platform's consent screen
 * sends the browser. Deliberately mounted before `requireAuth`: there is no
 * Authorization header on a redirect, so the caller's identity comes from the
 * HMAC-signed `state` minted by `/…/start`, and the write runs under that
 * user's RLS scope via `withUser` — the callback cannot reach rows the user
 * could not.
 *
 * Every failure after state verification redirects into the app with
 * `?error=…` rather than dead-ending a browser tab on a JSON body.
 */
export const connectCallback = new Hono().get(
  '/callback',
  zValidator('query', query),
  async (c) => {
    const { state: rawState, code, error } = c.req.valid('query');

    // No verified state → no trusted returnTo → answering JSON beats becoming
    // an open redirector for whoever forged the parameter.
    const state = verifyConnectState(rawState);
    if (!state) return c.json({ error: 'invalid_state' as const }, 400);

    const param = PARAM_BY_PLATFORM[state.platform];
    if (error) return c.redirect(appRedirect(state.returnTo, { error, platform: param }));
    if (!code) {
      return c.redirect(appRedirect(state.returnTo, { error: 'missing_code', platform: param }));
    }

    const provider = providerFor(state.platform);
    if (!provider) {
      return c.redirect(
        appRedirect(state.returnTo, { error: 'platform_not_configured', platform: param }),
      );
    }

    let identity;
    let tokens;
    try {
      tokens = await provider.exchangeCode({ code, redirectUri: connectCallbackUrl() });
      identity = await provider.fetchIdentity(tokens.accessToken);
    } catch (cause) {
      console.error(`connect callback failed for ${state.platform}:`, cause);
      return c.redirect(appRedirect(state.returnTo, { error: 'exchange_failed', platform: param }));
    }
    if (!identity) {
      return c.redirect(
        appRedirect(state.returnTo, { error: 'no_account_found', platform: param }),
      );
    }

    const account = await withUser(state.profileId, async (tx) => {
      // The state is minted, not minted-and-frozen truth: membership could have
      // been revoked inside its 10-minute life, so resolve it again under RLS.
      const workspaceId = await resolveWorkspaceId(tx, state.profileId, state.workspaceId);
      if (!workspaceId) return null;

      const shared = {
        handle: identity.handle,
        scopes: tokens.scopes,
        accessToken: sealToken(tokens.accessToken),
        tokenExpiresAt: tokens.expiresAt,
        status: ConnectionStatus.ACTIVE,
        disconnectedAt: null,
        purgeAfter: null,
      };

      return tx.connectedAccount.upsert({
        where: {
          workspaceId_platform_platformAccountId: {
            workspaceId,
            platform: state.platform,
            platformAccountId: identity.platformAccountId,
          },
        },
        create: {
          workspaceId,
          connectedById: state.profileId,
          platform: state.platform,
          platformAccountId: identity.platformAccountId,
          ...shared,
          refreshToken: tokens.refreshToken ? sealToken(tokens.refreshToken) : null,
        },
        // On re-connect, keep an existing refresh token unless the provider
        // handed out a new one — Google only returns it on a fresh grant.
        update: {
          ...shared,
          ...(tokens.refreshToken ? { refreshToken: sealToken(tokens.refreshToken) } : {}),
        },
        select: { id: true },
      });
    });

    if (!account) {
      return c.redirect(
        appRedirect(state.returnTo, { error: 'workspace_not_found', platform: param }),
      );
    }

    return c.redirect(appRedirect(state.returnTo, { connected: param }));
  },
);
