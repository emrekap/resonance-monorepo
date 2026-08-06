import { z } from 'zod';

/**
 * Offset pagination, shared by every list route.
 *
 * Offset rather than a keyset cursor because a cursor needs one composite
 * encoding *per sort column*, and these routes sort on nullable columns of
 * related tables (`analysis_results.resonance_score`). Offset works with any
 * `orderBy` Prisma can express and hands the client a real `total`. The rows
 * behind it are GPU jobs someone waited minutes for, so a workspace holds tens
 * to hundreds of them — a `COUNT` over a workspace-indexed predicate is noise
 * at that size. A list that grows unbounded per workspace would want a
 * `cursorQuery()` sibling instead; adding one does not disturb this.
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * The `limit` / `offset` / `sort` / `order` fragment of a route's query schema.
 * `.extend()` the result with the route's own filters.
 *
 * `sortKeys` is an allowlist, not a free string: no caller-supplied column name
 * reaches Prisma, and the keys land in `AppType` as a literal union, so a typo
 * in the mobile client is a type error rather than a 400 discovered at runtime.
 *
 * An over-large `limit` is refused rather than clamped — a client asking for
 * 500 rows should learn it cannot have them, not silently receive 100 and
 * conclude that was the whole page.
 */
export function pageQuery<const K extends readonly [string, ...string[]]>(
  sortKeys: K,
  defaultSort: K[number],
  defaultOrder: 'asc' | 'desc' = 'desc',
) {
  return z.object({
    // Query params arrive as strings, hence the coercion. `.default()`
    // short-circuits before it, so an absent param is the default, not NaN.
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
    sort: z.enum(sortKeys).default(defaultSort),
    order: z.enum(['asc', 'desc']).default(defaultOrder),
  });
}

/**
 * A filter that may be given more than once: `?status=QUEUED&status=FAILED`.
 *
 * Hono's validator reports one occurrence as a bare string and several as an
 * array, so a schema accepting only arrays 400s on the single-value case —
 * which is the common one. This normalises both to an array before `item`
 * runs. An explicitly empty repetition is refused: it can only be a client
 * bug, and answering it with "no filter" would quietly return everything.
 */
export function repeatable<T extends z.ZodType>(item: T) {
  return z
    .preprocess(
      // `Array.isArray` narrows `unknown` to `any[]`; the cast keeps the
      // callback's return honest without widening what the item schema sees.
      (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : [value]),
      z.array(item).nonempty(),
    )
    .optional();
}

/**
 * Wrap a page of rows with the metadata a client needs to ask for the next one.
 *
 * `hasMore` counts what actually came back rather than assuming a full `limit`,
 * so a short last page reports honestly instead of promising one more empty
 * request.
 */
export function paginated<T>(items: T[], page: { limit: number; offset: number }, total: number) {
  return {
    items,
    page: {
      limit: page.limit,
      offset: page.offset,
      total,
      hasMore: page.offset + items.length < total,
    },
  };
}
