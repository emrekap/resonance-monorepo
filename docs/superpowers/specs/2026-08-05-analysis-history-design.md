# Analysis history — list endpoint + mobile screen

**Date:** 2026-08-05
**Scope:** `apps/api`, `apps/mobile`, `packages/db` (one column)
**Status:** design approved, ready for implementation planning

## Problem

Analyses are write-only from a client's point of view. `POST /analyze` hands back a `jobId`,
`GET /analyze/:id` polls that one job, and nothing lists them. The id lives only in the router
history, so a creator who closes the app has no way back to a result they paid GPU time for.

`apps/mobile` therefore has no history surface at all: Home starts a run, `analysis/[id]` watches
it, and the run then disappears from the product.

Nothing in the monorepo paginates yet, so the first list route also decides how every later one
does it.

## Goals

1. `GET /analyze` — a workspace-scoped list with pagination, filters and sort.
2. Pagination that is **generic**: a helper the next list route reuses without redesigning it.
3. A mobile **History** tab that exercises all three, so the API is proven by a real consumer.

## Non-goals

- **Cursor/keyset pagination.** See "Decision: offset, not cursor".
- **Media URLs or thumbnails in list items.** A Storage asset needs a signed URL per row — N HTTP
  round trips per page for something no row can render (there is no thumbnail column).
- **A date-range control on mobile.** The API accepts one; the mobile UI does not expose it until a
  screen needs it. A date-range picker is disproportionate UI for a list this size.
- **Deleting or cancelling an analysis from the list.** No delete route exists; out of scope.
- **`apps/web`.** Not scaffolded.

## Decision: offset, not cursor

`?limit&offset` with a `total`, rather than an opaque cursor.

Keyset pagination is stabler under concurrent inserts and skips the `COUNT`, but it pays for that
with one composite-cursor encoding **per sort column** — and one of this route's sort keys is
`resonanceScore`, a nullable float on a _related_ table. Offset paging works with any `orderBy`
Prisma can express, hands the UI a real total, and keeps the shared helper about thirty lines.

Volume makes the trade cheap: an analysis is a GPU job someone waits minutes for, so a workspace
holds tens to hundreds of rows, not millions. `COUNT` over a `workspace_id`-indexed predicate at
that size is noise.

What would flip this decision: a list that grows unbounded per workspace (post metrics, credit
transactions at scale) or a screen where insert-drift is visible enough to duplicate rows on
screen. The helper's shape leaves room — a `cursorQuery()` sibling can be added later without
touching `pageQuery()`'s callers.

## Part 1 — the generic helper: `apps/api/src/lib/pagination.ts`

Route-agnostic. Knows nothing about analyses.

```ts
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Query fragment for a paginated route. Sort keys are the route's allowlist. */
export function pageQuery<const K extends readonly [string, ...string[]]>(
  sortKeys: K,
  defaultSort: K[number],
  defaultOrder: 'asc' | 'desc' = 'desc',
); // → z.object({ limit, offset, sort, order })

/** Wrap a page of rows with its metadata. */
export function paginated<T>(items: T[], page: { limit: number; offset: number }, total: number);
// → { items, page: { limit, offset, total, hasMore } }

/** `?status=A&status=B` → ['A','B']; `?status=A` → ['A']; absent → undefined. */
export function repeatable<T extends z.ZodType>(item: T);
```

| Param    | Rule                                        |
| -------- | ------------------------------------------- |
| `limit`  | int, 1…`MAX_LIMIT`, default `DEFAULT_LIMIT` |
| `offset` | int, ≥ 0, default 0                         |
| `sort`   | `z.enum(sortKeys)`, default `defaultSort`   |
| `order`  | `'asc' \| 'desc'`, default `defaultOrder`   |

Three things carry a reason:

**Sort keys arrive as an enum, not a string.** No arbitrary column name reaches Prisma, and each
route's keys land in `AppType` as a literal union, so a typo in the mobile client is a type error
rather than a 400 at runtime.

**`hasMore` is `offset + items.length < total`,** not `offset + limit`. The last page reports
honestly when it comes back short.

**`repeatable` exists because of Hono's query semantics.** Hono's validator gives a `string` for one
occurrence of a param and a `string[]` for several, so a schema accepting only arrays 400s on
`?status=SUCCEEDED`. `repeatable` normalises both to an array before the item schema runs. Every
future list route with a multi-value filter needs the same thing, so it ships beside pagination
rather than inside the analyze route.

Query params are strings on the wire, so `limit`/`offset` coerce. Note the consequence for the RPC
boundary: a coerced number's _input_ type is loose, so the client sends `{ limit: '20' }`. The keys
stay typed; only the value type widens.

## Part 2 — the route: `apps/api/src/routes/analyze/list.ts`

Mounted as `GET /` on the existing analyze domain (`api.analyze.$get()`), per the one-file-per-route
convention. `index.ts` gains `.route('/', listAnalyses)` before the `:id` route.

### Query

```ts
const query = pageQuery(['createdAt', 'completedAt', 'resonanceScore'], 'createdAt')
  .extend({
    workspaceId: z.uuid().optional(), // omit → the caller's personal workspace
    status: repeatable(z.enum(AnalysisStatus)),
    kind: repeatable(z.enum(MediaKind)),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
  })
  .refine((q) => !(q.createdAfter && q.createdBefore) || q.createdAfter <= q.createdBefore, {
    message: 'createdAfter must be on or before createdBefore',
  });
```

Enums come from `@repo/db/enums` — the leaf module, never the `@repo/db` barrel, because `status`
and `kind` reach `dist/app.d.ts` and the barrel drags `client.ts` into the Expo typecheck.

The inverted date range is refused with a 400 rather than answered with a silently empty page.

### Where clause

| Param                          | Prisma                                    |
| ------------------------------ | ----------------------------------------- |
| always                         | `workspaceId` (from `resolveWorkspaceId`) |
| `status`                       | `status: { in: status }`                  |
| `kind`                         | `mediaAsset: { kind: { in: kind } }`      |
| `createdAfter`/`createdBefore` | `createdAt: { gte, lte }`                 |

Omitted filters contribute nothing (`undefined`), not a clause that matches everything.

`resolveWorkspaceId` returns null → **404 `workspace_not_found`**, identical to
`connected-accounts/list.ts`: naming a workspace would confirm it exists to a non-member. The
explicit `workspaceId` is belt-and-braces over RLS, which has already narrowed `analyses` to
workspaces the caller belongs to.

### Order

Always a **pair** — the chosen key, then `{ id: 'desc' }`.

The tiebreak is load-bearing under offset paging: `completedAt` is null for every unfinished row and
`resonanceScore` is null for every row today, so without a deterministic second key Postgres may
order equal rows differently between two requests and page 2 will repeat one row while skipping
another. `id` is a UUIDv7, so `id desc` is also a sane creation-order fallback.

| `sort`           | `orderBy[0]`                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `createdAt`      | `{ createdAt: order }`                                           |
| `completedAt`    | `{ completedAt: { sort: order, nulls: 'last' } }`                |
| `resonanceScore` | `{ result: { resonanceScore: { sort: order, nulls: 'last' } } }` |

`nulls: 'last'` keeps queued work from sitting above finished work regardless of direction. The
relation-nested variant is the one to verify against Postgres first — see "Open risks".

Build the `orderBy` inline in the `findMany` call so Prisma types it contextually; do **not** import
`Prisma` types from the `@repo/db` barrel into a route file.

### Response

`findMany` and `count` run on the same `where`, inside the **one** `c.var.db` transaction, so the
total cannot disagree with the page it describes. Two sequential awaits, not `Promise.all` — the
interactive transaction is a single connection.

```ts
{
  items: [{
    id, status, createdAt, completedAt, error,
    media:  { id, kind, fileName, mimeType, durationSec },
    result: { resonanceScore, percentileInChannel, confidence } | null,
  }],
  page: { limit, offset, total, hasMore },
}
```

`status` is the state and `result.resonanceScore` the overall score the mobile row renders. `result`
is null for any row that has not finished. `byteSize` is deliberately absent — it is a Prisma
`BigInt` and would throw on JSON serialisation.

`items`, not `analyses`: the shape comes from the shared helper, so every list route answers the
same way and one client hook can consume all of them. This deviates from `{ accounts }` in
`connected-accounts/list.ts`; that route stays as it is rather than being churned.

The success branch returns an explicit `200` so `res.status === 404` still narrows on the client.

## Part 3 — `media_assets.file_name` (`packages/db`)

Rows need a human-readable title. Nothing in the data has one: `media_assets` has no name column and
`POST /media` discards the `fileName` the mobile picker already captures.

Via the `add-db-model` skill:

- Prisma: `fileName String? @map("file_name")` on `MediaAsset`.
- Migration `<timestamp>_media_asset_file_name`. **No RLS change** — policies are per-table and
  already rooted at `workspace_id`; a new column inherits them.
- No backfill. Existing rows stay null and the UI falls back (below).
- `POST /media` accepts `fileName: z.string().min(1).max(255).optional()` and stores it. The mobile
  uploader passes `media.fileName` through `registerMedia`, which already has it in `PickedMedia`.

Nullable, not required: `POST /analyze` can register an external `mediaUrl` asset that has no
filename, and every row written before this migration has none.

## Part 4 — mobile: the History tab

| File                              | Role                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| `src/app/(app)/history.tsx`       | The screen — filter bar + FlatList                          |
| `src/hooks/use-analyses.ts`       | `useInfiniteQuery` wrapper; the only place params are built |
| `src/components/analysis-row.tsx` | One row, pressable → `/analysis/[id]`                       |
| `src/components/ui/chip.tsx`      | New primitive: selectable pill                              |

### Navigation

A third tab in `(app)/_layout.tsx`, between Home and Accounts, icon `time-outline`. It is a primary
destination — checking on runs is at least as frequent as starting one — and Home's analyze flow
still pushes straight to `/analysis/[id]`, so the two do not compete.

### `Chip` primitive

`Badge` is display-only: no press handler, no selected state. `Chip` adds `selected` and `onPress`
over the same pill geometry (`radius.pill`, `space.md`/`space.xs`), selected state using
`accentSubtle` + `onAccentSubtle` and unselected `surface` + `border`, with
`accessibilityRole="button"` and `accessibilityState={{ selected }}`. Exported from
`components/ui/index.ts`. `DESIGN.md` needs no regeneration — it is generated from `tokens.ts`, and
this adds no token.

### `useAnalyses(filters)`

```ts
useInfiniteQuery({
  queryKey: ['analyses', filters],
  initialPageParam: 0,
  queryFn: ({ pageParam }) => api.analyze.$get({ query: { limit, offset: pageParam, ...filters } }),
  getNextPageParam: (last) => (last.page.hasMore ? last.page.offset + last.page.limit : undefined),
  refetchInterval: (q) => (anyRowRunning(q.state.data) ? 5000 : false),
});
```

The filter object **is** the query key, so flipping a chip refetches from offset 0 while TanStack
keeps the previous list mounted — no empty flash between filter states.

`refetchInterval` returns 5s while any loaded row is `QUEUED` or `PROCESSING` and `false` otherwise.
Same polling contract as `analysis/[id].tsx`, and it means a run started on Home visibly progresses
in the list. Non-200 throws with a message the screen renders; a 404 means the workspace resolution
failed, which is a different message from a transport failure.

### Filter bar

Pinned above the list — it does not scroll away, because a filtered list that hides its own filters
is how a user ends up believing their analyses are gone.

- **Status:** `All / Done / Running / Failed`. `Running` sends `QUEUED` **and** `PROCESSING` as
  repeated params — the case `repeatable()` exists for. Four chips cover five enum values;
  `CANCELLED` is reachable only via `All`, which is honest for a status nothing produces yet.
- **Kind:** `Video / Audio / Image`.
- **Sort:** a pill on the right opening `ActionSheetIOS` on iOS and an `Alert` with three buttons on
  Android (no new dependency). Tapping the already-active key flips `order`; the pill's label shows
  the active key and direction.

Filter state is `useState` in the screen — deliberately not persisted or URL-encoded. Nothing links
into a filtered history, and a tab that reopens on "All" is the predictable behaviour.

### List

`<Screen padded={false}>` wrapping a `FlatList`; `Screen`'s `scroll` mode is a `ScrollView` and
cannot host a virtualised list, so the FlatList carries its own `contentContainerStyle` gutter and
gap.

- `onEndReached` (threshold 0.5) → `fetchNextPage()`, guarded on `hasNextPage && !isFetchingNextPage`
- `ListFooterComponent`: `ActivityIndicator` while `isFetchingNextPage`
- `refreshControl`: `RefreshControl` on `isRefetching` → `refetch()`
- `ListEmptyComponent`: two cases, distinguished — _no analyses at all_ routes back to Home to start
  one; _no matches for these filters_ offers to clear them. Same component, different copy.
- Error state: a `Card` with the message and a retry `Button`, matching `analysis/[id].tsx`.

### Row

```
 87   reel-final-v2.mp4        2h  ›
      Video · 0:42 · Done
```

Leading slot is the score — `result.resonanceScore` rounded, or a status dot when there is none
(`Score` is the hero display component and is far too large for a row). Title is `fileName`, falling
back to the kind label when null (external assets, and every row predating Part 3). Subtitle is
kind · duration · status, and **duration is null on every row today** — nothing writes
`media_assets.duration_sec` yet — so the subtitle composes from present parts rather than assuming
all three. Trailing is a relative timestamp plus a chevron. Whole row is a `Pressable` to
`/analysis/[id]`, with an `accessibilityLabel` naming title, status and score, since the visual
hierarchy carries meaning a screen reader would otherwise read as three loose fragments.

Status colours reuse the theme's `success`/`warning`/`danger`/`textSecondary`, as
`accounts.tsx` does for connection status.

## Verification

Runnable, in order:

1. `bun test` in `apps/api` — `src/lib/pagination.test.ts` covers the helper: defaults applied,
   `limit` clamped at `MAX_LIMIT`, `offset` rejecting negatives, `repeatable` on absent / single /
   repeated params, and `hasMore` false on a short last page. Needs a `"test": "bun test"` script
   added to `apps/api/package.json` (it has none today).
2. `turbo run build` — the new route reaches `dist/app.d.ts`.
3. `turbo run typecheck` — mobile resolves `api.analyze.$get` with the literal sort/status unions.
4. `turbo run lint`.
5. `bun test` in `apps/mobile` — existing suite still green.

Not covered by automation, and stated plainly rather than implied:

- **No DB-backed test of the route.** There is no test harness against Postgres in this repo yet, so
  the `where`/`orderBy` mapping is verified by running it — API up, a workspace with a few analyses,
  each filter and sort exercised by hand.
- **The `resonanceScore` sort is the one to check first** against a live database (Open risk 1).
- **The mobile screen is verified on a device/simulator**, not in a test: filter switching, paging
  past 20 rows, pull-to-refresh, the running-row poll, and both empty states.

## Implementation order

1. `pagination.ts` + its test — no dependencies, and it defines the contract everything else uses.
2. `list.ts` + mount in `index.ts` + README route table; `turbo run build`.
3. `media_assets.file_name`: Prisma field, migration, `POST /media`, `registerMedia`.
4. `Chip` primitive.
5. `use-analyses.ts`.
6. `analysis-row.tsx`.
7. `history.tsx` + the tab entry in `(app)/_layout.tsx`.
8. Re-index the codebase graph; update the "Current state" section of `CLAUDE.md`.

Steps 1–3 are independently useful and land before any mobile work depends on them.

## Open risks

1. **Prisma's nested `nulls: 'last'`.** `{ result: { resonanceScore: { sort, nulls } } }` orders
   through a to-one relation; the `nulls` option is documented for nullable scalars and the
   relation-nested form needs confirming on Prisma 7. Fallback: order by the scalar without the
   `nulls` option (Postgres defaults nulls first on `desc`), or drop `resonanceScore` from the sort
   allowlist until the calibration that populates it ships. Every score is null today, so this sort
   is currently a no-op the tiebreak resolves — which makes it low-stakes to get wrong, and worth
   verifying before it matters.
2. **Coerced param types at the RPC boundary.** `z.coerce.number()` widens the client's input type
   for `limit`/`offset`. If it degrades the generated `AppType` further than expected, swap to
   `z.string().regex(...).transform(Number)`, which keeps the wire type honestly `string`.
3. **Offset drift during polling.** A run completing between page loads shifts rows by one under a
   `createdAt` sort. With a 5s poll the visible symptom is a row appearing twice until the next
   refetch. Accepted; the `id` tiebreak bounds it, and pull-to-refresh resets to offset 0.
4. **`CANCELLED` has no producer.** Nothing sets that status today, so the `All` chip is its only
   route to the screen. Left as is rather than building a filter for a state that cannot occur.
