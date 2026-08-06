# Analysis status via Supabase Realtime — replacing the polls

**Date:** 2026-08-05
**Scope:** `packages/db` (one migration), `apps/mobile`
**Status:** design approved, ready for implementation planning

## Problem

Two screens watch an analysis change status, and both do it by asking the API over and over:

- `apps/mobile/src/hooks/use-analyses.ts` — `refetchInterval` of 5s while any loaded row is
  `QUEUED` or `PROCESSING`.
- `apps/mobile/src/app/(app)/analysis/[id].tsx` — `refetchInterval` of 2.5s on the same condition.

Inference is seconds-to-minutes, so the polls mostly return an unchanged row. The cost is not the
bandwidth, it is the shape: latency to a visible status change averages half the interval, the
History tab re-runs a filtered, sorted, counted query every 5s for as long as one job is in flight,
and every new screen that wants live status has to re-derive its own interval.

Postgres already knows the moment the status flips — `apps/worker` writes it. Realtime is the
transport that already exists between that write and the client.

## Goals

1. `analyses` status changes reach the mobile clients as a push, not a poll.
2. Both existing screens (History list, single-analysis detail) stay correct with the polls gone.
3. The new database privilege is the narrowest one that makes Realtime work.

## Non-goals

- **Rendering row data from the Realtime payload.** See "Decision: signal, not payload".
- **`analysis_results` / `media_assets` subscriptions.** The analysis row is the only thing whose
  change a screen reacts to; the rest arrives with the refetch.
- **Realtime in `apps/api` or `apps/worker`.** Server-side consumers have the queue.
- **`apps/web`.** Not scaffolded.
- **Presence, Broadcast, or a shared realtime provider abstraction.** One channel, one table.

## Decision: signal, not payload

The `postgres_changes` payload invalidates a TanStack query. It never patches a row.

An analysis row cannot render a list item on its own. `resonanceScore`,
`percentileInChannel` and `confidence` live in `analysis_results`; `fileName`, `kind`, `mimeType`
and `durationSec` live in `media_assets`. `GET /analyze` joins all three
(`apps/api/src/routes/analyze/list.ts`). A payload patch would either show a row with a missing
score or force the client to duplicate that join shape and keep it in sync with the route by hand —
which is the drift `@repo/api-contract` exists to prevent.

So the API stays the single source of row shape, and Realtime only answers _when_ to ask again.

This is safe because of an ordering guarantee already in the worker: `apps/worker/src/results.ts`
upserts `analysis_results` and flips `analyses.status` to `SUCCEEDED` inside one
`prismaService.$transaction`. Both rows commit together, so a `SUCCEEDED` event can never arrive
before the score it implies is readable.

## Decision: postgres_changes with a column-scoped grant

### Why a grant is needed at all

§6 of `20260802191500_security_rls` revoked every table privilege from `anon` and `authenticated`:

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
```

That is deliberate — clients read through `apps/api`, never PostgREST. Realtime cannot honour it.
`realtime.apply_rls` (a platform function, readable in the project) decides what a subscriber sees
using `pg_catalog.has_column_privilege(working_role, entity_, ...)`, and `working_role` is the role
in the caller's JWT. With no privilege, every column is `is_selectable = false` and the subscriber
receives nothing.

### Why column-scoped rather than the whole table

`apply_rls` uses `has_column_privilege` exclusively — it never calls `has_table_privilege`. So a
column-level grant is precisely what it understands, and the grant can be narrowed to what the
signal needs:

```sql
GRANT SELECT (id, workspace_id, media_asset_id, status, created_at, started_at, completed_at)
  ON public.analyses TO authenticated;
```

Reading the function, three constraints fall out of that list:

- **`id` is mandatory.** `apply_rls` short-circuits to `Error 401: Unauthorized` for any non-DELETE
  event where `sum(c.is_selectable) <> count(1)` over the primary-key columns. Omit `id` and every
  event is dropped, silently from the client's side.
- **`workspace_id` is mandatory.** It is what the `analyses_select` policy is rooted at, and it is
  the column the RLS probe (`select exists(select 1 from public.analyses where id = ...)`, run with
  `role` and `request.jwt.claims` set to the subscriber's) resolves membership through.
  `private.is_workspace_member(uuid)` is `SECURITY DEFINER` with `EXECUTE` already granted to
  `authenticated`.
- **Everything else is optional, so it is excluded.** `error`, `credits_charged`,
  `model_version_id` and `requested_by_id` stay unreadable. `apply_rls` builds the payload's
  `record` from `is_selectable` columns only, so they never leave the database.

### What this costs

`analyses` becomes readable over PostgREST (`GET /rest/v1/analyses`) to any signed-in user — seven
columns, still row-scoped by the unchanged `analyses_select` policy against forced RLS. This is a
real widening of the surface CLAUDE.md keeps closed, accepted knowingly and bounded to the seven
columns. The alternative that avoids it entirely — a trigger calling `realtime.broadcast_changes()`
into a `workspace:<id>` topic with an RLS policy on `realtime.messages` — was considered and
rejected for this change: it needs a trigger, a second policy, and a new API surface to tell the
client its `workspaceId`, which `GET /analyze` does not currently return.

### Publication and replica identity

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.analyses;
```

`supabase_realtime` exists, is owned by `postgres` (so a Prisma migration can alter it), has
`puballtables = false`, and currently lists no tables.

Replica identity stays `DEFAULT`. `FULL` only populates `old_record`, and `apply_rls` filters
`old_record` down to the primary key whenever RLS is enabled anyway. Nothing here reads it.

## Part 1 — the migration: `packages/db/prisma/migrations/20260805140000_realtime_analyses/`

The two statements above, with the reasoning compressed into a header comment — chiefly _why_ a
migration is handing `authenticated` a privilege the security migration took away, and that `id`
and `workspace_id` are load-bearing rather than convenience.

Prisma stays the schema owner: this is a Prisma migration applied by `db:deploy`, not a change
made through the dashboard or the Supabase MCP.

No `schema.prisma` change — grants and publications are not modelled by Prisma.

## Part 2 — the subscription: `apps/mobile/src/hooks/use-analysis-realtime.ts`

One hook, mounted once in `app/(app)/_layout.tsx`.

At the layout rather than per-screen for two reasons: navigating between History and
`analysis/[id]` would otherwise tear down and rebuild a websocket on every push, and a run started
from Home should update the History tab that is already mounted behind it.

```ts
export function useAnalysisRealtime(): void;
```

Behaviour:

- **Gated on the session.** No session, no channel. Keyed on the user id so a sign-out tears the
  channel down and a different sign-in builds a new one.
- **Subscribes** to `postgres_changes`, `{ event: '*', schema: 'public', table: 'analyses' }`, with
  no `filter`. RLS already restricts delivery to the caller's workspaces; a client-side
  `workspace_id` filter would need a workspace id the client does not have, and would add nothing.
- **On each event**, invalidates two query keys: `['analyses']` (every filter variant of the
  infinite list — `filters` is part of that key) and `['analysis', <id>]` from `payload.new.id`.
- **Cleans up** with `supabase.removeChannel(channel)`.

No manual `realtime.setAuth`. `@supabase/supabase-js` 2.111 wires the access token to the socket
itself — `_handleTokenChanged` calls `realtime.setAuth(token)` on `SIGNED_IN`, `INITIAL_SESSION`
and `TOKEN_REFRESHED`, and clears it on `SIGNED_OUT`. The hourly token refresh therefore re-auths
the existing socket without a resubscribe.

### Resume invalidation

The same hook registers an `AppState` listener that invalidates both key roots once on `active`.

A backgrounded React Native app's websocket drops, and events that fire while it is asleep are not
replayed. With the polls gone, nothing else would notice. This is not a poll — it fires on resume
only — and it is what keeps "removed polling entirely" from meaning "stale after every
backgrounding".

### The pure part: `apps/mobile/src/lib/query-keys.ts`

The mapping from an event to the query keys it invalidates is pure, and it cannot live in the hook
file: `bun test` would have to import `react-native` (`AppState`) and `@/lib/supabase`, and the
latter throws at import time when the Expo env vars are absent. The existing tests
(`design/theme.test.ts`, `design/tokens.test.ts`) only pass because they import pure modules.

So it goes in a module that imports nothing:

```ts
export function analysesKey(filters?: unknown): QueryKey; // ['analyses'] | ['analyses', filters]
export function analysisKey(id: string): QueryKey; // ['analysis', id]
export function invalidationKeys(id: string | undefined): QueryKey[];
```

Centralising the keys is the point, not a side effect. `use-analyses.ts` and `analysis/[id].tsx`
currently spell their keys inline; if the realtime hook spelled them a fourth time, renaming one
would silently stop realtime working with no type error to catch it. Both existing call sites adopt
the helpers, so the keys have one definition.

`bun test` then covers `invalidationKeys` directly, the way the repo already tests pure logic
(`apps/api/src/lib/pagination.test.ts`), without pretending a websocket can be unit-tested.

## Part 3 — removing the polls

`apps/mobile/src/hooks/use-analyses.ts`

- Drop `refetchInterval`.
- Drop the now-unused `RUNNING` constant (it existed only for that predicate).
- Rewrite the doc comment: it currently ends by describing the 5s poll as the mechanism that makes
  a run "visibly progress in this list".

`apps/mobile/src/app/(app)/analysis/[id].tsx`

- Drop `refetchInterval`.
- **Keep** `RUNNING` — it still drives the spinner and the `running` flag.
- Rewrite the header comment, which currently asserts "polling _is_ the contract (see the queue
  design in CLAUDE.md), not a stand-in for a socket." That is now the opposite of what the file
  does.

`AnalysisStatus` imports stay in both files for the remaining uses.

## Part 4 — documentation

- **`packages/db/README.md:75-76`** — this is a **correction, not an addition**. The file currently
  states that "`anon` and `authenticated` hold no grants in `public`, so PostgREST cannot reach
  these tables regardless of policies." After this migration that sentence is false. It must be
  rewritten to name the one exception, its seven columns, and why Realtime requires it.
- **`CLAUDE.md`** — the analysis-path diagram's `client polls GET /analyze/:jobId` annotation, and
  the "Current state" section: the Realtime dependency and the widened `authenticated` grant belong
  in the record next to the RLS claims.
- **`apps/mobile/README.md`** — four places describe the polls: the `analysis/[id].tsx` and
  `use-analyses.ts` annotations in the file tree (lines 19 and 28), the flow narrative at line 80,
  and the "The list polls itself" bullet at line 95.

## Verification

Runnable here:

- `turbo run typecheck` — clean.
- `turbo run lint` — clean.
- `cd apps/mobile && bun test` — existing tests plus the new `invalidationKeys` unit.

Requires the database:

- `cd packages/db && bun run db:deploy` applies **both** the already-pending
  `20260805120000_media_asset_file_name` and this migration. `GET /analyze` does not answer until
  the first one lands.
- Post-deploy check that the grant and publication took:
  `select * from information_schema.column_privileges where table_name = 'analyses' and grantee = 'authenticated';`
  and `select * from pg_publication_tables where pubname = 'supabase_realtime';`

Cannot be verified in this environment, and will not be claimed as verified:

- That an event actually reaches a device. That needs Expo on a device or simulator, a live GPU
  worker, and a real analysis — the same gate the whole upload→analyze flow is already behind.

## Open risks

- **RLS probe cost per event.** `apply_rls` runs `select exists(select 1 from public.analyses where
id = ...)` once per subscriber per changed row, plus the `is_workspace_member` lookup inside the
  policy. At tens-to-hundreds of analyses per workspace this is noise; it is worth remembering if
  `analyses` ever becomes a high-write table.
- **Invalidation bursts.** `QUEUED → PROCESSING → SUCCEEDED` is three events, each invalidating
  every loaded page of the infinite query. TanStack dedupes concurrent identical fetches and the
  event rate is one job's worth, so no debounce is added — deliberately, not by oversight. If a
  future bulk operation flips many rows at once, a debounce is the fix.
- **Column list drift.** If a screen later needs `error` live rather than on refetch, the grant has
  to grow. That is a migration, not a client change, and the column list should stay minimal until
  something concretely needs more.
