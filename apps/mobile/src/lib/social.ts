import type { Provider } from '@supabase/supabase-js';
// Types come from the browser-safe Prisma entry — model + enum types with no
// PrismaClient behind them, so nothing server-side leaks into the app bundle.
import { Platform } from '@repo/db/browser';

/**
 * Social identity providers a user can sign in / sign up with.
 *
 * `provider` is the Supabase OAuth provider id, so adding Facebook later is a
 * one-line flip once it is enabled in the Supabase dashboard. Entries without
 * `available` render as "coming soon" so the screens already show the roadmap.
 */
export interface LoginProviderConfig {
  provider: Provider;
  label: string;
  /** A short glyph stand-in until brand icons land. */
  glyph: string;
  available: boolean;
}

export const LOGIN_PROVIDERS: LoginProviderConfig[] = [
  { provider: 'google', label: 'Continue with Google', glyph: 'G', available: true },
  { provider: 'facebook', label: 'Continue with Facebook', glyph: 'f', available: false },
];

/**
 * Content platforms a workspace can connect for data access — distinct from
 * login: signing in with Google proves who you are; connecting YouTube grants
 * the API offline access to channel analytics. A workspace can hold several
 * accounts per platform (`@@unique([workspaceId, platform, platformAccountId])`),
 * which is why the UI never treats "connected" as a boolean per platform.
 *
 * `param` is the URL segment `POST /connected-accounts/:platform/start` takes.
 */
export interface ConnectablePlatformConfig {
  platform: Platform;
  param: 'youtube' | 'instagram' | 'tiktok';
  label: string;
  blurb: string;
  glyph: string;
  available: boolean;
}

export const CONNECTABLE_PLATFORMS: ConnectablePlatformConfig[] = [
  {
    platform: Platform.YOUTUBE,
    param: 'youtube',
    label: 'YouTube',
    blurb: 'Channel analytics & retention curves',
    glyph: '▶',
    available: true,
  },
  {
    platform: Platform.INSTAGRAM,
    param: 'instagram',
    label: 'Instagram',
    blurb: 'Professional account insights',
    glyph: '◎',
    available: false,
  },
  {
    platform: Platform.TIKTOK,
    param: 'tiktok',
    label: 'TikTok',
    blurb: 'Account & video analytics',
    glyph: '♪',
    available: false,
  },
];

export const PLATFORM_LABELS: Record<Platform, string> = {
  [Platform.YOUTUBE]: 'YouTube',
  [Platform.INSTAGRAM]: 'Instagram',
  [Platform.TIKTOK]: 'TikTok',
};
