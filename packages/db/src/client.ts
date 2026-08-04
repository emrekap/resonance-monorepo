import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see packages/db/README.md`);
  return value;
}

/**
 * Connect on first use, not on import.
 *
 * The two clients hold *different* credentials on purpose, and a process should
 * only need the one it actually uses: `apps/api` runs the request path and must
 * never hold the BYPASSRLS password, the worker is the reverse. Constructing
 * both eagerly would force every importer of `@repo/db` to configure both URLs
 * — quietly handing the API the credential the role split exists to withhold.
 *
 * The proxy keeps the exported shape a plain `PrismaClient`, so callers (and
 * `withUser`) are unaware.
 */
function lazy(envVar: string): PrismaClient {
  let client: PrismaClient | undefined;
  const resolve = (): PrismaClient =>
    (client ??= new PrismaClient({
      adapter: new PrismaPg({ connectionString: required(envVar) }),
    }));

  return new Proxy({} as PrismaClient, {
    get(_target, property) {
      const value = Reflect.get(resolve(), property) as unknown;
      // `Function.bind` is typed to return `any`, which would leak untyped
      // values back through the proxy. The cast keeps the bound method typed.
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(resolve())
        : value;
    },
  });
}

/**
 * Request-path client. Connects as `app_user`, which has **no** BYPASSRLS and
 * does not own the tables — so every query it runs is subject to RLS.
 *
 * Do not query this directly for user data: go through `withUser()`, which sets
 * the JWT claim the policies read. Without that claim `auth.uid()` is null and
 * the policies correctly return nothing.
 */
export const prisma: PrismaClient = lazy('APP_USER_DATABASE_URL');

/**
 * Worker/queue client. Connects as `app_service` (BYPASSRLS) because writing an
 * ML result or running the purge sweep legitimately crosses user boundaries.
 *
 * Never reachable from a request handler — `apps/api` imports `prisma`, the
 * BullMQ worker imports this.
 */
export const prismaService: PrismaClient = lazy('APP_SERVICE_DATABASE_URL');
