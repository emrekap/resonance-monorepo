# Analysis Realtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two `refetchInterval` polls in `apps/mobile` with a Supabase Realtime
subscription on `public.analyses`, so status changes arrive as a push.

**Architecture:** A Prisma migration adds `analyses` to the `supabase_realtime` publication and
grants `authenticated` a seven-column `SELECT` (the minimum `realtime.apply_rls` needs to deliver
anything). One hook, mounted once in the `(app)` layout, subscribes to `postgres_changes` and
invalidates TanStack queries — the payload is a refetch signal, never row data, because a list row
also needs `analysis_results` and `media_assets` that only `GET /analyze` joins.

**Tech Stack:** Prisma 7 / Supabase Postgres, Expo SDK 57 + expo-router, `@supabase/supabase-js`
2.111, TanStack Query v5, `bun test`.

**Design spec:** [`docs/superpowers/specs/2026-08-05-analysis-realtime-design.md`](../specs/2026-08-05-analysis-realtime-design.md)

## Global Constraints

- **Do not commit unless Emre asks.** `CLAUDE.md`: "Commit / push only when asked." The commit
  steps below are written out ready to run; they are gated on an explicit request.
- **Prisma is the single schema owner.** This migration ships as a file under
  `packages/db/prisma/migrations/` applied by `db:deploy` — never via the dashboard or the Supabase
  MCP `apply_migration`.
- **Prettier:** `singleQuote`, `semi`, `trailingComma: all`, `printWidth: 100`, `tabWidth: 2`.
- **Import enums from `@repo/db/browser`** in mobile code, never the `@repo/db` barrel.
- **The grant's column list is exact:** `id, workspace_id, media_asset_id, status, created_at,
started_at, completed_at`. `id` and `workspace_id` are load-bearing (see Task 1).
- **Migration directory name:** `20260805140000_realtime_analyses`.

---

### Task 1: The migration and the claim it falsifies

**Files:**

- Create: `packages/db/prisma/migrations/20260805140000_realtime_analyses/migration.sql`
- Modify: `packages/db/README.md:75-76`

**Interfaces:**

- Consumes: nothing.
- Produces: `authenticated` holds column-scoped `SELECT` on `public.analyses`; `public.analyses` is
  a member of publication `supabase_realtime`. Task 2's subscription receives nothing without both.

No `schema.prisma` edit — Prisma does not model grants or publications.

- [ ] **Step 1: Write the migration**

Create `packages/db/prisma/migrations/20260805140000_realtime_analyses/migration.sql`:

```sql
-- Realtime on public.analyses.
--
-- apps/mobile replaces its status polls (the History list and analysis/[id])
-- with a Postgres Changes subscription. Two things have to be true for that,
-- and the first one walks back part of `20260802191500_security_rls` §6.
--
-- §6 revoked every table privilege from `anon` and `authenticated` on purpose:
-- clients read through apps/api, never PostgREST. Realtime cannot honour that.
-- `realtime.apply_rls` decides what a subscriber sees using
-- `pg_catalog.has_column_privilege(<the JWT's role>, ...)`, so a role holding
-- no privilege receives nothing — silently, from the client's side.
--
-- It calls `has_column_privilege` exclusively and never `has_table_privilege`,
-- which is what makes a column-scoped grant work. The list below is the
-- narrowest set that delivers an event:
--
--   * `id` is mandatory. apply_rls short-circuits to "Error 401: Unauthorized"
--     for any non-DELETE event whose primary key is not selectable.
--   * `workspace_id` is mandatory. It is what `analyses_select` is rooted at,
--     and what the RLS probe resolves membership through.
--   * the rest is what a client needs to decide a cached row is stale.
--
-- Deliberately excluded: `error`, `credits_charged`, `model_version_id`,
-- `requested_by_id`. apply_rls builds the payload from selectable columns only,
-- so those never leave the database. The payload is a signal to refetch through
-- apps/api — which still returns them under its own authz — not a row.
--
-- The cost, stated plainly: `analyses` becomes readable over PostgREST to any
-- signed-in user, bounded to these seven columns and still row-scoped by the
-- unchanged `analyses_select` policy against forced RLS.

GRANT SELECT (id, workspace_id, media_asset_id, status, created_at, started_at, completed_at)
  ON public.analyses TO authenticated;

-- Replica identity stays DEFAULT. `full` only populates `old_record`, which
-- apply_rls truncates to the primary key whenever RLS is enabled anyway.
ALTER PUBLICATION supabase_realtime ADD TABLE public.analyses;
```

- [ ] **Step 2: Correct `packages/db/README.md`**

Lines 75-76 currently read:

```markdown
only; all table I/O goes through the Hono API. `anon` and `authenticated` hold no grants in
`public`, so PostgREST cannot reach these tables regardless of policies.
```

That is false after Step 1. Replace the second sentence with the exception and its reason — keep it
to roughly the same length, and name the seven columns rather than gesturing at "some columns":

```markdown
only; all table I/O goes through the Hono API. `anon` holds no grants in `public`, and
`authenticated` holds exactly one: `SELECT (id, workspace_id, media_asset_id, status, created_at,
started_at, completed_at)` on `analyses`, added in `20260805140000_realtime_analyses` because
Supabase Realtime delivers a row only to a role with column privileges on it. So PostgREST can
reach those seven columns of `analyses`, row-scoped by `analyses_select` against forced RLS, and
nothing else.
```

- [ ] **Step 3: Apply it**

This applies the already-pending `20260805120000_media_asset_file_name` too — that is expected and
is the gate `GET /analyze` has been waiting on.

Run: `cd packages/db && bun run db:deploy`
Expected: both migrations reported as applied.

- [ ] **Step 4: Verify the grant and the publication landed**

Run (via the Supabase MCP `execute_sql`, or `psql`):

```sql
select column_name, privilege_type
from information_schema.column_privileges
where table_name = 'analyses' and grantee = 'authenticated'
order by column_name;

select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime';
```

Expected: exactly seven `SELECT` rows — `completed_at`, `created_at`, `id`, `media_asset_id`,
`started_at`, `status`, `workspace_id` — and one publication row, `public` / `analyses`.

If the seven rows are missing `id`, stop: every event will be dropped as 401.

- [ ] **Step 5: Confirm RLS is still forced**

The grant must not have disturbed the policy that scopes rows.

Run:

```sql
select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.analyses'::regclass;
```

Expected: `true`, `true`.

- [ ] **Step 6: Commit** (only if asked — see Global Constraints)

```bash
git add packages/db/prisma/migrations/20260805140000_realtime_analyses packages/db/README.md
git commit -m "feat(db): enable realtime on analyses with a column-scoped grant"
```

---

### Task 2: Query keys and the realtime hook

**Files:**

- Create: `apps/mobile/src/lib/query-keys.ts`
- Create: `apps/mobile/src/lib/query-keys.test.ts`
- Create: `apps/mobile/src/hooks/use-analysis-realtime.ts`

**Interfaces:**

- Consumes: Task 1's grant and publication (nothing arrives without them); `useSession()` from
  `@/providers/session-provider`, which returns `{ session: Session | null; isLoading: boolean;
signOut: () => Promise<void> }`; `supabase` from `@/lib/supabase`.
- Produces:
  - `analysesKey(filters?: unknown): QueryKey` — `['analyses']` with no argument, `['analyses',
filters]` with one.
  - `analysisKey(id: string): QueryKey` — `['analysis', id]`.
  - `invalidationKeys(id: string | undefined): QueryKey[]`.
  - `useAnalysisRealtime(): void` — Task 3 mounts this.

`query-keys.ts` must import **nothing** but the `QueryKey` type. That is what makes it testable
under `bun test`: importing the hook instead would pull in `react-native` and `@/lib/supabase`, and
the latter throws at module load when `EXPO_PUBLIC_SUPABASE_URL` is unset.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/lib/query-keys.test.ts`:

```ts
/// <reference types="bun-types/test" />
import { describe, expect, test } from 'bun:test';

import { analysesKey, analysisKey, invalidationKeys } from './query-keys';

describe('analysesKey', () => {
  test('is one element when unfiltered, so it prefix-matches every filtered key', () => {
    expect(analysesKey()).toEqual(['analyses']);
  });

  test('carries the filters when given them', () => {
    const filters = { sort: 'createdAt', order: 'desc' };
    expect(analysesKey(filters)).toEqual(['analyses', filters]);
  });
});

describe('analysisKey', () => {
  test('names the row it belongs to', () => {
    expect(analysisKey('a3f1')).toEqual(['analysis', 'a3f1']);
  });
});

describe('invalidationKeys', () => {
  test('invalidates the list and the row when the event carries an id', () => {
    expect(invalidationKeys('a3f1')).toEqual([['analyses'], ['analysis', 'a3f1']]);
  });

  test('invalidates only the list when it does not — a DELETE payload has no new row', () => {
    expect(invalidationKeys(undefined)).toEqual([['analyses']]);
  });

  test('the list key stays a prefix, never a filtered key', () => {
    // useAnalyses keys on ['analyses', filters]; TanStack invalidates by
    // prefix, so a two-element key here would miss every mounted filter.
    expect(invalidationKeys('a3f1')[0]).toEqual(['analyses']);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/mobile && bun test src/lib/query-keys.test.ts`
Expected: FAIL — cannot resolve `./query-keys`.

- [ ] **Step 3: Write `query-keys.ts`**

Create `apps/mobile/src/lib/query-keys.ts`:

```ts
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

/** One analysis, as `analysis/[id]` polls it. */
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/mobile && bun test src/lib/query-keys.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the hook**

Create `apps/mobile/src/hooks/use-analysis-realtime.ts`:

```ts
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { invalidationKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/providers/session-provider';

/**
 * Push, not poll: `analyses` status changes arrive over Supabase Realtime and
 * invalidate the queries that render them.
 *
 * The payload is only ever a signal. A list row needs `analysis_results` and
 * `media_assets` too — `GET /analyze` joins all three — so the row shape stays
 * the API's to define and this hook only answers *when* to ask again. That is
 * safe because apps/worker commits the result row and the SUCCEEDED status in
 * one transaction (`apps/worker/src/results.ts`), so the score is always
 * readable by the time the event lands.
 *
 * Mounted once, in the `(app)` layout: a per-screen subscription would tear
 * down and rebuild a websocket on every push between History and a detail
 * screen, and a run started from Home should reach the History tab already
 * mounted behind it.
 */
export function useAnalysisRealtime(): void {
  const queryClient = useQueryClient();
  const { session } = useSession();
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;

    const invalidate = (id?: string) => {
      for (const queryKey of invalidationKeys(id)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };

    // No `filter`: RLS already restricts delivery to the caller's workspaces,
    // and a `workspace_id` filter would need an id this client never learns.
    // No `setAuth` either — supabase-js pushes the token to the socket on
    // SIGNED_IN / INITIAL_SESSION / TOKEN_REFRESHED, so the hourly refresh
    // re-auths this channel without resubscribing.
    const channel = supabase
      .channel('analyses')
      .on<{ id: string }>(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'analyses' },
        (payload) => invalidate('id' in payload.new ? payload.new.id : undefined),
      )
      .subscribe();

    // A backgrounded app's socket drops and the events it missed are not
    // replayed. This is not a poll — it fires on resume only — but without it
    // "no more polling" would read as "stale after every backgrounding".
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') invalidate();
    });

    return () => {
      appState.remove();
      void supabase.removeChannel(channel);
    };
    // Keyed on `userId`, not `session`: the session object's identity changes
    // on every token refresh, which would rebuild a working channel hourly.
  }, [userId, queryClient]);
}
```

- [ ] **Step 6: Typecheck and lint**

Run: `cd /Users/emre/Desktop/files/resonance-monorepo && turbo run typecheck lint --filter=mobile`
Expected: both clean.

If `payload.new` does not narrow under `'id' in payload.new`, the cause is the
`RealtimePostgresChangesPayload<T>` union — DELETE's variant types `new` as `{}`. The `in` check is
the intended narrowing; do not replace it with an `as` cast.

- [ ] **Step 7: Commit** (only if asked)

```bash
git add apps/mobile/src/lib/query-keys.ts apps/mobile/src/lib/query-keys.test.ts \
        apps/mobile/src/hooks/use-analysis-realtime.ts
git commit -m "feat(mobile): subscribe to analyses changes over Supabase Realtime"
```

---

### Task 3: Mount it, delete the polls, fix the docs that describe them

**Files:**

- Modify: `apps/mobile/src/app/(app)/_layout.tsx`
- Modify: `apps/mobile/src/hooks/use-analyses.ts:18-19,55-67`
- Modify: `apps/mobile/src/app/(app)/analysis/[id].tsx:20-44`
- Modify: `apps/mobile/README.md:19,28,29-33,80,95-96`
- Modify: `CLAUDE.md:29,186-191`

**Interfaces:**

- Consumes: `useAnalysisRealtime()` from Task 2, `analysesKey` / `analysisKey` from Task 2.
- Produces: no polling anywhere in `apps/mobile`.

Docs live in this task, not a fourth one: they are false the moment the polls come out, and a
reviewer should see the code and the corrected prose together.

- [ ] **Step 1: Mount the hook in the `(app)` layout**

In `apps/mobile/src/app/(app)/_layout.tsx`, add the import and call it at the top of `AppLayout`:

```tsx
import { useAnalysisRealtime } from '@/hooks/use-analysis-realtime';

export default function AppLayout() {
  const theme = useTheme();

  // One subscription for the whole signed-in shell — see the hook for why it
  // lives here rather than in the screens that consume it.
  useAnalysisRealtime();
```

Leave the rest of the component untouched.

- [ ] **Step 2: Take the poll out of `use-analyses.ts`**

Delete the `RUNNING` constant and its comment (lines 18-19) — it exists only for the poll — and the
`refetchInterval` option, so the `useInfiniteQuery` call ends at `getNextPageParam`. Also drop the
now-unused `AnalysisStatus` value import, keeping the `MediaKind` type import:

```ts
import type { AnalysisStatus, MediaKind } from '@repo/db/browser';
```

Note `AnalysisStatus` stays as a **type** — `AnalysisFilters.status` is typed `AnalysisStatus[]`.

Replace the last paragraph of the `useAnalyses` doc comment (the one starting "The poll mirrors
`analysis/[id].tsx`") with:

```ts
 * Nothing here polls. `useAnalysisRealtime`, mounted in the `(app)` layout,
 * invalidates this key when an analysis row changes, so a run started on Home
 * progresses in this list without a pull-to-refresh.
```

Adopt the shared key while here:

```ts
import { analysesKey } from '@/lib/query-keys';
// ...
    queryKey: analysesKey(filters),
```

- [ ] **Step 3: Take the poll out of `analysis/[id].tsx`**

Delete the `refetchInterval` option from the `useQuery` call, so it ends at `queryFn`. **Keep** the
`RUNNING` constant — line 46's `running` flag still uses it to drive the spinner.

Adopt the shared key:

```ts
import { analysisKey } from '@/lib/query-keys';
// ...
    queryKey: analysisKey(id),
```

Replace the component's header comment, which currently asserts the opposite of what the file now
does:

```tsx
/**
 * The screen behind `POST /analyze`. Inference is seconds-to-minutes on a GPU
 * worker, so the status arrives as a push: `useAnalysisRealtime` (mounted in
 * the `(app)` layout) invalidates this query when the row changes. Before that
 * it polled every 2.5s.
 */
```

- [ ] **Step 4: Run the full mobile check**

Run: `cd /Users/emre/Desktop/files/resonance-monorepo && turbo run typecheck lint --filter=mobile && cd apps/mobile && bun test`
Expected: typecheck clean, lint clean, all tests pass.

A lint error about an unused `AnalysisStatus` or `RUNNING` means Step 2 or 3 removed one too few or
one too many — fix rather than suppress.

- [ ] **Step 5: Correct `apps/mobile/README.md`**

Five edits. Line 19, in the file tree — replace:

```text
      analysis/[id].tsx   #   Poll GET /analyze/:id until the job settles
```

with:

```text
      analysis/[id].tsx   #   GET /analyze/:id, refreshed by realtime
```

Line 28 — replace:

```text
    use-analyses.ts       # GET /analyze paged (useInfiniteQuery), polls while any row runs
```

with these two lines (the new hook belongs in the tree):

```text
    use-analyses.ts       # GET /analyze paged (useInfiniteQuery)
    use-analysis-realtime.ts # analyses changes → query invalidation, mounted in (app)/_layout
```

In the `lib/` block that follows (lines 29-33), add after `media.ts`:

```text
    query-keys.ts         # the TanStack keys, in one place so realtime can invalidate them
```

Line 80 — replace:

```text
   `analysis/[id]`, which polls every 2.5s until the status settles.
```

with:

```text
   `analysis/[id]`, which refreshes when Realtime reports the row changed.
```

Lines 95-96 — replace the bullet:

```markdown
- **The list polls itself** every 5s while any loaded row is queued or processing, and stops when
  none is — the same contract `analysis/[id]` uses, so a run started on Home progresses here live.
```

with:

```markdown
- **Nothing polls.** `use-analysis-realtime.ts`, mounted once in `(app)/_layout.tsx`, subscribes to
  `postgres_changes` on `public.analyses` and invalidates `['analyses']` — a signal, not a row
  patch, since a list row also needs `analysis_results` and `media_assets` that only `GET /analyze`
  joins. It re-invalidates on app resume too: a backgrounded socket drops and misses events.
```

- [ ] **Step 6: Correct `CLAUDE.md`**

Three edits. Line 29, the analysis-path diagram — replace:

```text
analyses · analysis_results · inference_runs        client polls GET /analyze/:jobId
```

with:

```text
analyses · analysis_results · inference_runs        client reads GET /analyze/:jobId (realtime-refreshed)
```

Lines 186-191, the tail of the **History + pagination** paragraph. Task 1 applied the migration, so
the gate no longer exists and that text is now false. Replace:

```markdown
with infinite scroll, pinned status/kind chips, a sort menu, and a 5s self-poll while any row is
still running. `media_assets.file_name` was added so rows have a name to show.
**The gate:** migration `20260805120000_media_asset_file_name` is written but **not applied** —
`GET /analyze` selects that column, so run `cd packages/db && bun run db:deploy` before the route
will answer. Nothing here has run against a live database or device yet.
```

with:

```markdown
with infinite scroll, pinned status/kind chips, and a sort menu. `media_assets.file_name` was added
so rows have a name to show. Both its migration and the realtime one below are applied. Nothing
here has run against a device yet.

**Realtime (done, unobserved):** mobile no longer polls for analysis status. `analyses` is a member
of the `supabase_realtime` publication, and `authenticated` holds a seven-column `SELECT` on it
(`20260805140000_realtime_analyses`) — the one exception to "clients hold no grants in `public`",
because `realtime.apply_rls` delivers a row only to a role with column privileges on it. Rows stay
scoped by `analyses_select` against forced RLS. `use-analysis-realtime.ts` mounts one channel in
the `(app)` layout and invalidates TanStack keys; the payload is never rendered. Typechecked,
linted and unit-tested — **no event has been observed reaching a device.**
```

- [ ] **Step 7: Format**

Run: `cd /Users/emre/Desktop/files/resonance-monorepo && bun run format`
Expected: clean, or reformats only the files touched here.

- [ ] **Step 8: Commit** (only if asked)

```bash
git add apps/mobile CLAUDE.md
git commit -m "feat(mobile): drop status polling in favour of realtime"
```

---

## Verification

After Task 3, the whole change is checkable with:

```bash
cd /Users/emre/Desktop/files/resonance-monorepo
turbo run typecheck lint
cd apps/mobile && bun test
```

Plus the SQL checks in Task 1 Steps 4-5.

**What this does not prove, and must not be reported as proven:** that an event reaches a device.
That needs Expo on a device or simulator, a live GPU worker and a real analysis — the same gate the
whole upload→analyze flow already sits behind. Report the change as typechecked, linted,
unit-tested and migrated; nothing more.

A grep that should come back empty when the work is done:

```bash
grep -rn "refetchInterval" apps/mobile/src
```
