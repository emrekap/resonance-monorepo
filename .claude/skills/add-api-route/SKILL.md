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

## 1. Create/extend the route module (`apps/api/src/routes/<name>.ts`)

Export a **method-chained** Hono instance (chaining is what makes the types inferrable). Validate
input with `@hono/zod-validator` + `zod`; read validated data via `c.req.valid(...)`; return typed
JSON with `c.json(...)`.

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const body = z.object({ name: z.string().min(1) });

export const widgets = new Hono()
  .post('/', zValidator('json', body), (c) => {
    const { name } = c.req.valid('json');
    return c.json({ id: crypto.randomUUID(), name }, 201);
  })
  .get('/:id', (c) => c.json({ id: c.req.param('id') }));
```

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

- **Never break the `.route()` / handler chain** — types collapse to `unknown`.
- **Rebuild after route changes** — `dist/` is gitignored; a stale d.ts = stale client types.
- **No heavy/GPU work in a route** — enqueue a job (Redis/BullMQ) for the `apps/ml` worker and return
  a `jobId`; the client polls.
- **No ad-hoc DB access in routes** — go through Prisma (`@repo/db`); Prisma is the single schema owner.
- **Re-index after the route lands** — a stale graph hides the endpoint from future `search_graph`
  and `trace_path` calls, exactly like a stale d.ts hides the types.

## Verify (hermetic — no server needed)

```ts
import app from './src/app';
const r = await app.request('/widgets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'x' }),
});
console.log(r.status, await r.json());
```
