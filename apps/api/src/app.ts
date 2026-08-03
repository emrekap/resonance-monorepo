import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { health } from './routes/health';
import { analyze } from './routes/analyze';
import { connectedAccounts } from './routes/connected-accounts';
import { media } from './routes/media';

/**
 * The Resonance app backend (BFF).
 *
 * Routes are method-chained and mounted with `.route()` so their types compose
 * into `AppType` — that is what makes the Hono RPC client (`hc<AppType>`) fully
 * typed on the Expo and Next clients, with no codegen. Keep routes chained.
 */
const app = new Hono()
  .use('*', logger())
  .route('/health', health)
  .route('/analyze', analyze)
  .route('/connected-accounts', connectedAccounts)
  .route('/media', media);

export type AppType = typeof app;
export default app;
