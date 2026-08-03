import { Hono } from 'hono';
import { requireAuth, type AuthEnv } from '../../middleware/auth';
import { createAnalysis } from './create';
import { getAnalysisById } from './get';

/**
 * The `/analyze` domain.
 *
 * One file per route, composed with plain `.route()` — the same mechanism
 * `app.ts` uses to mount this. Each route file exports its own method-chained
 * `Hono`, so nothing here is special-cased: `route()` merges the sub-app's
 * schema into this one's, and this one's into `AppType`.
 *
 * `requireAuth` is mounted here rather than globally so `/health` stays public.
 * It runs before anything mounted below it, and the route files declare
 * `Hono<AuthEnv>` so `c.var.db` and `c.get('user')` are typed on the other side.
 */
export const analyze = new Hono<AuthEnv>()
  .use('*', requireAuth)
  .route('/', createAnalysis)
  .route('/', getAnalysisById);
