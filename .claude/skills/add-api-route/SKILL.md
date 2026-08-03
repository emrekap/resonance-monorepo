---
name: add-api-route
description: Add or modify a typesafe Hono route in the Resonance monorepo's apps/api and expose it through the RPC client. Use when adding or changing API endpoints so route types flow correctly into AppType and the hc<AppType> client on Expo/Next.
---

# Add a typesafe API route (`apps/api`)

Follow these steps so the route stays end-to-end typesafe through Hono RPC.

## 0. Orient with the codebase index (before grepping)

The repo is indexed in **codebase-memory-mcp** as project
`Users-emre-Desktop-files-resonance-monorepo`. Use it to see what already exists so you extend the
chain instead of duplicating it:

```
search_graph(project, label: "Route")                  # every endpoint, api + ml
search_graph(project, query: "analyze route handler")  # find a specific one
get_code_snippet(project, qualified_name: "…apps.api.src.app")   # current chain in app.ts
trace_path(project, function_name: "<handler>", mode: "cross_service")  # api → ml hops
```

Then `Read` the files you're about to change — the graph is a snapshot, not the live bytes.

## 1. A directory per domain, a file per route

```text
routes/health.ts              # flat: one route, no validation, no DB
routes/analyze/
  index.ts                    # composes the domain + mounts requireAuth
  create.ts                   # POST /analyze
  get.ts                      # GET  /analyze/:jobId
lib/                          # only what more than one route needs
```

Every route file exports its **own method-chained `Hono`** — chaining is what makes the types
inferrable — and the domain's `index.ts` composes them with plain `.route()`, the same call `app.ts`
uses to mount the domain. No factory, no handler registry: `route()` merges each sub-app's schema
upward into `AppType`.

```ts
// routes/widgets/create.ts — schema, validation and Prisma all live here
const body = z.object({ name: z.string().min(1) });

export const createWidget = new Hono<AuthEnv>().post('/', zValidator('json', body), async (c) => {
  const { name } = c.req.valid('json');
  const { id: profileId } = c.get('user');

  const widget = await c.var.db((tx) => tx.widget.create({ data: { name, profileId } }));
  return c.json({ id: widget.id, name: widget.name }, 201);
});
```

```ts
// routes/widgets/index.ts — one .route() per file
export const widgets = new Hono<AuthEnv>()
  .use('*', requireAuth)
  .route('/', createWidget)
  .route('/', getWidget);
```

Keep route-local schemas and queries in the route's own file. Promote to `lib/` **only** when a
second route needs the same thing — a helper with one caller belongs next to that caller.

A one-route domain with no validation and no DB stays a flat file (`routes/health.ts`). Don't
pre-split it.

## 2. Mount it in `apps/api/src/app.ts`

Add to the **same chain** via `.route()` — do not create a separate app instance:

<!-- prettier-ignore -->
```ts
const app = new Hono()
  .use('*', logger())
  .route('/health', health)
  .route('/widgets', widgets); // ← add here
export type AppType = typeof app;
```

## 3. Rebuild the `AppType` boundary

Routes reach consumers via a compiled `.d.ts`, not source:

```bash
bunx turbo run build      # emits apps/api/dist/app.d.ts
bunx turbo run typecheck  # verifies AppType flows to @repo/api-contract
```

Then refresh the code graph so the new endpoint is discoverable:

```
index_repository(repo_path: "/Users/emre/Desktop/files/resonance-monorepo")
```

## 4. Use it from a client (`@repo/api-contract`)

```ts
import { createApiClient } from '@repo/api-contract';
const api = createApiClient('http://localhost:3000');
const res = await api.widgets.$post({ json: { name: 'x' } }); // fully typed
```

## Rules / gotchas

- **Never break the chain.** Keep `.post()/.get()` chained off `new Hono()` and compose with
  `.route()`; a handler assigned to a bare variable and registered separately loses
  `c.req.valid()` inference and collapses `AppType` to `unknown`.
- **Rebuild after route changes** — `dist/` is gitignored; a stale d.ts = stale client types.
- **No `@repo/db` types in a response.** `AppType` is consumed by the Expo and Next typechecks, so a
  Prisma type — even an enum — makes those tsconfigs resolve the generated client and its Bun/Node
  globals. It fails `@repo/api-contract`'s typecheck immediately. Map DB enums through
  `src/lib/wire.ts` (`as const satisfies Record<TheEnum, string>`, which fails the build if the
  Postgres enum drifts). After building, `grep '@repo/db' apps/api/dist/app.d.ts` must be empty.
- **Give success responses an explicit status** (`c.json(data, 200)`). Without it Hono types the
  branch as `ContentfulStatusCode`, which overlaps the error statuses, and `if (res.status === 404)`
  stops narrowing on the client.
- **`requireAuth` goes on the domain's `index.ts`**, not globally, so `/health` stays public.
  Query through `c.var.db` (= `withUser` bound to the caller) and let RLS scope the rows — do not
  re-implement the policy as a `where` clause.
- **No heavy/GPU work in a route** — enqueue a job (Redis/BullMQ) for the `apps/ml` worker and return
  a `jobId`; the client polls.
- **Select columns explicitly** for anything returned to a client. `include` drags in `BigInt`
  columns (`JSON.stringify` throws) and dev telemetry like `analysis_results.raw_stats`.
- **One transaction per request.** Open `c.var.db(...)` once and do all the writes inside it.
- **Re-index after the route lands** — a stale graph hides the endpoint from future `search_graph`
  and `trace_path` calls, exactly like a stale d.ts hides the types.

## Verify (hermetic — no server needed)

`app.request()` exercises the whole stack with no listening server:

```ts
import app from './src/app';
const r = await app.request('/widgets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'x' }),
});
console.log(r.status, await r.json());
```

For an authenticated route this needs a real access token — mint one through the Supabase admin API
(create user → sign in with password). Two throwaway users is also the only way to _prove_ the RLS
boundary rather than assume it: user B must get a 404, not a filtered list.
