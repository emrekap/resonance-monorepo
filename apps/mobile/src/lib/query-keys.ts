import type { QueryKey } from '@tanstack/react-query';

/**
 * Every TanStack key the app uses, in one place.
 *
 * Centralised because `use-analysis-realtime` has to invalidate exactly the
 * keys `use-analyses` and `analysis/[id]` register under, and a mismatch is
 * invisible: no type error, no failing test, just realtime quietly not
 * refreshing anything.
 */

/**
 * The analyses list. One element unfiltered, because TanStack invalidates by
 * prefix — `['analyses']` matches every mounted `['analyses', filters]`.
 */
export function analysesKey(filters?: unknown): QueryKey {
  return filters === undefined ? ['analyses'] : ['analyses', filters];
}

/** One analysis, as `analysis/[id]` reads it. */
export function analysisKey(id: string): QueryKey {
  return ['analysis', id];
}

/**
 * What a change to analysis `id` makes stale.
 *
 * `id` is absent on DELETE — that payload carries the primary key in `old`, not
 * `new` — and the list refetch covers that case on its own.
 */
export function invalidationKeys(id: string | undefined): QueryKey[] {
  return id === undefined ? [analysesKey()] : [analysesKey(), analysisKey(id)];
}
