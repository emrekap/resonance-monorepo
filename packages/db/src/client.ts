import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see packages/db/README.md`);
  return value;
}

function create(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Request-path client. Connects as `app_user`, which has **no** BYPASSRLS and
 * does not own the tables — so every query it runs is subject to RLS.
 *
 * Do not query this directly for user data: go through `withUser()`, which sets
 * the JWT claim the policies read. Without that claim `auth.uid()` is null and
 * the policies correctly return nothing.
 */
export const prisma: PrismaClient = create(required('APP_USER_DATABASE_URL'));

/**
 * Worker/queue client. Connects as `app_service` (BYPASSRLS) because writing an
 * ML result or running the purge sweep legitimately crosses user boundaries.
 *
 * Never reachable from a request handler — `apps/api` imports `prisma`, the
 * BullMQ worker imports this.
 */
export const prismaService: PrismaClient = create(required('APP_SERVICE_DATABASE_URL'));
