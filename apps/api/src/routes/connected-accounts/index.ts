import { Hono } from 'hono';
import { requireAuth, type AuthEnv } from '../../middleware/auth';
import { connectCallback } from './callback';
import { disconnectAccount } from './disconnect';
import { listConnectedAccounts } from './list';
import { startConnect } from './start';

/**
 * The `/connected-accounts` domain — platform OAuth for data access. Distinct
 * from login: Supabase owns who the user is; this owns which YouTube/Instagram/
 * TikTok accounts a workspace can read analytics from (several per platform).
 *
 * `/callback` is registered BEFORE `requireAuth` on purpose: it is the
 * provider's browser redirect, carries no bearer token, and authenticates via
 * the signed state instead. Everything below the middleware is JWT-gated as
 * usual.
 */
export const connectedAccounts = new Hono<AuthEnv>()
  .route('/', connectCallback)
  .use('*', requireAuth)
  .route('/', listConnectedAccounts)
  .route('/', startConnect)
  .route('/', disconnectAccount);
