import { Platform } from '@repo/db/enums';

/**
 * URL segment ↔ Platform enum. The lowercase params are the public API
 * surface (`POST /connected-accounts/youtube/start`); the enum is what the
 * database speaks.
 */
export const PLATFORM_BY_PARAM = {
  youtube: Platform.YOUTUBE,
  instagram: Platform.INSTAGRAM,
  tiktok: Platform.TIKTOK,
} as const;

export type PlatformParam = keyof typeof PLATFORM_BY_PARAM;

export const PARAM_BY_PLATFORM = Object.fromEntries(
  Object.entries(PLATFORM_BY_PARAM).map(([param, platform]) => [platform, param]),
) as Record<Platform, PlatformParam>;

export interface PlatformTokens {
  accessToken: string;
  /** Null when the provider withheld it (e.g. Google on a repeat consent). */
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export interface PlatformIdentity {
  /** The provider-side account id — `connected_accounts.platform_account_id`. */
  platformAccountId: string;
  handle: string | null;
}

/**
 * One connectable platform's OAuth shape. Adding Instagram/TikTok later means
 * writing one of these and registering it below — the routes are generic.
 */
export interface PlatformProvider {
  authorizeUrl(opts: { state: string; redirectUri: string }): string;
  exchangeCode(opts: { code: string; redirectUri: string }): Promise<PlatformTokens>;
  fetchIdentity(accessToken: string): Promise<PlatformIdentity | null>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see apps/api/.env.example`);
  return value;
}

/**
 * YouTube connects through Google OAuth. Scopes are read-only analytics —
 * enough for post metrics and retention curves, nothing that can post.
 * `access_type=offline` + `prompt=consent` force a refresh token on every
 * grant, so a re-connect can always rotate the stored credential.
 */
const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

const youtube: PlatformProvider = {
  authorizeUrl({ state, redirectUri }) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', required('GOOGLE_CLIENT_ID'));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', YOUTUBE_SCOPES.join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    return url.toString();
  },

  async exchangeCode({ code, redirectUri }) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: required('GOOGLE_CLIENT_ID'),
        client_secret: required('GOOGLE_CLIENT_SECRET'),
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      scopes: body.scope?.split(' ') ?? YOUTUBE_SCOPES,
    };
  },

  async fetchIdentity(accessToken) {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      throw new Error(`youtube channels.list failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      items?: { id: string; snippet?: { title?: string; customUrl?: string } }[];
    };
    // A Google account with no YouTube channel has nothing to connect.
    const channel = body.items?.[0];
    if (!channel) return null;
    return {
      platformAccountId: channel.id,
      handle: channel.snippet?.customUrl ?? channel.snippet?.title ?? null,
    };
  },
};

const PROVIDERS: Partial<Record<Platform, PlatformProvider>> = {
  [Platform.YOUTUBE]: youtube,
  // INSTAGRAM / TIKTOK: routes answer 501 platform_not_configured until their
  // providers land here.
};

export function providerFor(platform: Platform): PlatformProvider | null {
  return PROVIDERS[platform] ?? null;
}

/** Where platform OAuth redirects land — must be registered in each provider's console. */
export function connectCallbackUrl(): string {
  const base = (process.env.API_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/connected-accounts/callback`;
}
