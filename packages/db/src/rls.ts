import { prisma } from './client.ts';
import type { Prisma } from './generated/client.ts';

/** A Prisma client scoped to one transaction (no nested `$transaction`). */
export type Tx = Prisma.TransactionClient;

/**
 * Run `fn` as `userId`, with row-level security enforced by Postgres.
 *
 * The `prisma` client connects as `app_user` — a role with no BYPASSRLS that
 * does not own the tables — so RLS policies genuinely bind to it. The policies
 * read `auth.uid()`, which on Supabase resolves from the `request.jwt.claims`
 * setting; this sets that claim for the duration of the transaction.
 *
 * `set_config(..., true)` makes the setting **transaction-local**: it is rolled
 * back at commit, so a claim can never leak onto the next request that reuses
 * the same pooled connection. That is the whole reason this is a transaction
 * rather than a plain `$executeRaw` before the query.
 *
 * ```ts
 * const analyses = await withUser(userId, (tx) =>
 *   tx.analysis.findMany({ where: { workspaceId } }),
 * );
 * ```
 *
 * A forgotten `where` clause here returns the user's own rows, not everyone's.
 */
export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select set_config('request.jwt.claims', ${claims}, true)`;
    return fn(tx);
  });
}

/**
 * Like `withUser`, but for an unauthenticated request. Sets no claim, so
 * `auth.uid()` is null and every policy denies — useful for asserting that a
 * public code path really cannot read user data.
 */
export function withAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select set_config('request.jwt.claims', '', true)`;
    return fn(tx);
  });
}
