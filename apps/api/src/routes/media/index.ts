import { Hono } from 'hono';
import { requireAuth, type AuthEnv } from '../../middleware/auth';
import { createMediaAsset } from './create';

/**
 * The `/media` domain — registering uploads. The bytes themselves go from the
 * client straight to Supabase Storage; see `create.ts` for the handshake.
 */
export const media = new Hono<AuthEnv>().use('*', requireAuth).route('/', createMediaAsset);
