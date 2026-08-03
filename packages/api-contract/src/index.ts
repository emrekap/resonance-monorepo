import { hc } from 'hono/client';
import type { AppType } from '@repo/api';

// Re-export the server's route type so clients depend on this package, not the app.
export type { AppType };

/**
 * Typed Hono RPC client for the Resonance API.
 *
 * Expo (apps/mobile) and Next (apps/web) call this — the types flow from the
 * server's `AppType`, so requests and responses are checked at compile time
 * with no codegen. Wrap the returned client in TanStack Query on each client.
 *
 * @example
 *   const api = createApiClient('http://localhost:3000');
 *   const res = await api.health.$get();          // typed
 *   const job = await api.analyze.$post({ json: { mediaUrl } });
 */
export function createApiClient(...args: Parameters<typeof hc<AppType>>) {
  return hc<AppType>(...args);
}

export type ApiClient = ReturnType<typeof createApiClient>;

// const api = createApiClient('http://localhost:3000');
