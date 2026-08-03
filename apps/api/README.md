# apps/api

**Bun + Hono** — the app backend / BFF for the mobile & web clients.

Responsibilities: auth, users, social OAuth (YouTube/TikTok/IG), business logic, persistence via
Prisma ([`@repo/db`](../../packages/db)), and **orchestrating ML jobs** (enqueue to Redis/BullMQ,
the Python worker consumes them).

Typesafety: define routes with validators, **method-chain them**, and export `type AppType = typeof routes`.
That type is re-exported from [`@repo/api-contract`](../../packages/api-contract) for the clients.
Use `@hono/zod-openapi` so we also emit an OpenAPI spec (for the future public/agency API tier).

Calls into the Python ML service through the typed [`@repo/ml-client`](../../packages/ml-client).

---

## Layout

**A directory per domain, a file per route.**

```text
src/
  app.ts              # mounts the domains — AppType is `typeof app`
  middleware/auth.ts  # Supabase JWT -> c.var.db
  lib/                # small shared helpers, no layer
    queue.ts          # the `analysis` producer (BullMQ)
    media.ts  workspace.ts
  routes/
    health.ts         # flat: one route, no validation, no DB
    analyze/
      index.ts        # composes the domain + mounts requireAuth
      create.ts       # POST /analyze
      get.ts          # GET  /analyze/:jobId
```

Each route file exports its own method-chained `Hono`, and the domain's `index.ts` composes them
with plain `.route()` — the same call `app.ts` uses to mount the domain. There is no factory, no
handler registry and no special mechanism: `route()` merges each sub-app's schema upward into
`AppType`. Route-local schemas, validation and Prisma calls all live in the route's own file, which
is short enough to read in one go.

`lib/` is for genuinely shared helpers, not a service layer. Anything only one route needs stays in
that route's file.

Adding a route = new file + one `.route()` line. Adding a domain = new directory + one `.route()`
line in `app.ts`.

## Auth — one door in

[`src/middleware/auth.ts`](src/middleware/auth.ts) verifies the
`Authorization: Bearer <supabase access token>` header and is the **only** place a user id enters
the system. Supabase signs access tokens with an asymmetric key (ES256) and publishes the public
half at the project JWKS endpoint, so signatures are checked locally — no GoTrue round trip per
request, and the API holds no JWT secret. The key set is cached and refetched only on an unknown
`kid` (rotation).

It puts two things on the context:

```ts
c.get('user'); // { id, email, role } — id is auth.users.id === profiles.id
c.var.db; // withUser() already bound to that id
```

`c.var.db` is the important one. Because the user id is baked in rather than passed as an argument,
a handler cannot run a query as somebody else, and **row visibility is enforced by Postgres**:

```ts
// Reads back null for anyone else's job — no `where workspaceId` needed.
const job = await c.var.db((tx) => tx.analysis.findUnique({ where: { id } }));
```

Mount it on the domain's `index.ts` (`new Hono<AuthEnv>().use('*', requireAuth)`) so public endpoints
like `/health` stay public. It runs before everything mounted below it, and route files declare
`Hono<AuthEnv>` so both variables stay typed on the other side.

**Never import `prismaService` here.** That is the BYPASSRLS role and it belongs to the queue
worker. `@repo/db` connects lazily, so this process only needs `APP_USER_DATABASE_URL`.

### Enums in responses come from `@repo/db/enums`

`AppType` is consumed by the Expo and Next typechecks, so anything a response names ends up in
_their_ program. The **barrel** `@repo/db` is not safe there: it pulls in `client.ts` and `rls.ts`,
whose `.ts`-extension imports need `allowImportingTsExtensions` — a flag only
`@repo/tsconfig/bun.json` sets. A client typecheck that follows it dies on TS5097.

Prisma 7's generated enums are a different story. `src/generated/enums.ts` is a **leaf module that
imports nothing** — plain `as const` objects — and it typechecks clean under both client tsconfigs
(verified against `react-native.json` and `nextjs.json`, and it still passes with `skipLibCheck`
off). So routes return the Prisma enum directly; there is no hand-maintained wire mapping and
nothing to keep in sync.

The one non-obvious part is **which specifier** ends up in `dist/app.d.ts`. Declaration emit does
not keep the one you wrote — it recomputes a specifier from the symbol's declaration file and picks
the shortest that resolves. So `@repo/db` re-exporting the enums was enough to poison the boundary
even when the route imported from `@repo/db/enums`. That re-export is gone
([`packages/db/src/index.ts`](../../packages/db/src/index.ts) says why), which leaves
`@repo/db/enums` the only route to them and makes the rule hold by construction.

Import enums from `@repo/db/enums`; keep `@repo/db` for `withUser`, `prismaService`, `Tx` and
`Prisma`. After building, this must come back empty — note the trailing `'`, which matches the
barrel but not the subpath:

```bash
grep "@repo/db'" apps/api/dist/app.d.ts
```

`@repo/db/browser` is the same deal one level up — enums _plus_ model types, also verified clean —
if a client ever needs the model shapes.

Also **give success responses an explicit status** (`c.json(data, 200)`). Without it Hono types the
branch as `ContentfulStatusCode`, which overlaps 404, and `if (res.status === 404)` stops narrowing
on the client.

## Queue — this process only produces

`POST /analyze` records the analysis, then publishes to the `analysis` queue via
[`src/lib/queue.ts`](src/lib/queue.ts). It consumes nothing:

```text
apps/api  ──▶  [analysis]  ──▶  apps/ml   ──▶  [analysis-results]  ──▶  apps/worker  ──▶  Postgres
```

Contract, queue names and connection factory: [`@repo/queue`](../../packages/queue).

Three things about that route worth not rediscovering:

- **The enqueue is outside the transaction.** Publishing a job id that a rollback then erases would
  hand the worker an analysis row that does not exist.
- **The BullMQ job id _is_ the analysis id.** A client retrying a POST it never saw the response to
  cannot queue the same GPU run twice — BullMQ ignores an `add` for an id that already exists.
- **If Redis is down the analysis is closed as FAILED** and the route answers 503, rather than
  leaving a row that says QUEUED forever and a client polling it.

`apps/worker` is a **separate process** on purpose: it writes as `app_service` (BYPASSRLS), and that
credential must never live where HTTP is served. That is why there is no worker entrypoint here.

## Env

Copy `.env.example` to `.env`. Bun loads it from this directory, so `APP_USER_DATABASE_URL` lives
here as well as in `packages/db/.env`.

`REDIS_URL` is needed for `POST /analyze` — `docker compose -f infra/docker/docker-compose.yml up -d`.
`@repo/queue` connects lazily, so a test that only drives `/health` or `GET /analyze/:id` does not
need Redis running.

## Verify

`app.request()` exercises the whole stack with no listening server. Anything under `/analyze` needs
a real access token — mint one through the Supabase admin API (create user → sign in), which is also
the only way to _prove_ the RLS boundary instead of assuming it:

```ts
const res = await app.request('/analyze', {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ mediaUrl: 'https://…/clip.mp4', modality: 'video' }),
});
```
