import type { AnalysisStatus, MediaKind } from '@repo/db/browser';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { analysesKey } from '@/lib/query-keys';

/** Matches the API's own default; sent explicitly so the paging math is local. */
export const PAGE_SIZE = 20;

export type AnalysisSort = 'createdAt' | 'completedAt' | 'resonanceScore';

export interface AnalysisFilters {
  status?: AnalysisStatus[];
  kind?: MediaKind[];
  sort: AnalysisSort;
  order: 'asc' | 'desc';
}

async function fetchAnalyses(filters: AnalysisFilters, offset: number) {
  const res = await api.analyze.$get({
    query: {
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort: filters.sort,
      order: filters.order,
      // Omitted rather than sent empty: the API refuses an empty repetition,
      // which is the right answer to a client bug but not to "no filter".
      ...(filters.status?.length ? { status: filters.status } : {}),
      ...(filters.kind?.length ? { kind: filters.kind } : {}),
    },
  });

  if (res.status === 404) throw new Error('Could not find your workspace.');
  if (res.status !== 200) throw new Error('Could not load your analyses.');
  return res.json();
}

/** One row of the list, as the API defines it. */
export type Analysis = Awaited<ReturnType<typeof fetchAnalyses>>['items'][number];

/**
 * `GET /analyze`, paged.
 *
 * `filters` **is** the query key, so flipping a chip refetches from offset 0
 * while TanStack keeps the previous list mounted — no empty flash between
 * filter states. The next offset comes from the page the server just described
 * (`offset + limit`), not from a count kept here.
 *
 * Nothing here polls. `useAnalysisRealtime`, mounted in the `(app)` layout,
 * invalidates this key when an analysis row changes, so a run started on Home
 * progresses in this list without a pull-to-refresh.
 */
export function useAnalyses(filters: AnalysisFilters) {
  return useInfiniteQuery({
    queryKey: analysesKey(filters),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchAnalyses(filters, pageParam),
    getNextPageParam: (last) =>
      last.page.hasMore ? last.page.offset + last.page.limit : undefined,
    // What actually keeps the previous rows on screen. Without it a new key
    // means `isPending`, and the screen swaps the whole list for a spinner on
    // every chip tap.
    placeholderData: keepPreviousData,
  });
}
