---
name: add-api-route
description: Add or modify a typesafe Hono route in the Resonance monorepo's apps/api and expose it through the RPC client. Use when adding or changing API endpoints so route types flow correctly into AppType and the hc<AppType> client on Expo/Next.
---

# Add a typesafe API route (`apps/api`)

Follow these steps so the route stays end-to-end typesafe through Hono RPC.

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