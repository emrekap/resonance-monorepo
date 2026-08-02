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

Mount it per-route (`new Hono<AuthEnv>().use('*', requireAuth)`) so public endpoints like `/health`
stay public.

**Never import `prismaService` here.** That is the BYPASSRLS role and it belongs to the queue
worker. `@repo/db` connects lazily, so this process only needs `APP_USER_DATABASE_URL`.

### Keep `@repo/db` types out of responses

`AppType` is consumed by the Expo and Next typechecks. Returning a Prisma type — even an enum —
makes those tsconfigs resolve the generated client and its Bun/Node globals. Map DB enums to plain
literals at the route boundary: see `JOB_STATUS` in [`src/routes/analyze.ts`](src/routes/analyze.ts),
where `satisfies Record<AnalysisStatus, string>` fails the build if the Postgres enum gains a value.

## Env

Copy `.env.example` to `.env`. Bun loads it from this directory, so `APP_USER_DATABASE_URL` lives
here as well as in `packages/db/.env`.

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
