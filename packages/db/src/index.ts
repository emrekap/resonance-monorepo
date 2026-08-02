/**
 * `@repo/db` — the single owner of the Resonance app schema.
 *
 * Request path  → `withUser(userId, tx => …)`  (RLS enforced by Postgres)
 * Worker path   → `prismaService`              (BYPASSRLS, crosses users)
 *
 * See packages/db/README.md for the role model and the naming conventions.
 */
export { prisma, prismaService } from './client.ts';
export { withUser, withAnon, type Tx } from './rls.ts';

export { Prisma } from './generated/client.ts';
export type { PrismaClient } from './generated/client.ts';
export * from './generated/enums.ts';
export type * from './generated/models.ts';
