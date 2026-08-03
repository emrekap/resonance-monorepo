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
export type * from './generated/models.ts';

/**
 * Enums are deliberately NOT re-exported here — import them from
 * `@repo/db/enums`, which is the same generated objects one module deeper.
 *
 * This is load-bearing, not style. An enum that reaches a route response also
 * reaches `apps/api/dist/app.d.ts`, and declaration emit does not keep the
 * specifier the source wrote: it recomputes one from the symbol's declaration
 * file and picks the *shortest* that resolves. While `export * from
 * './generated/enums.ts'` lived here, `@repo/db` won that race over
 * `@repo/db/enums` — so the boundary named the barrel, the Expo/Next typecheck
 * followed it into `client.ts`, and fell over on this file's own `.ts`-extension
 * imports (TS5097; they need `allowImportingTsExtensions`, which only the Bun
 * tsconfig sets).
 *
 * Deleting the re-export leaves `@repo/db/enums` as the only specifier that
 * resolves to the enums, so emit has to use it — and that path is a leaf module
 * that imports nothing. The rule is enforced by construction: you cannot reach
 * an enum through the barrel, so you cannot leak the barrel through an enum.
 */
