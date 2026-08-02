# apps/api

**Bun + Hono** — the app backend / BFF for the mobile & web clients.

Responsibilities: auth, users, social OAuth (YouTube/TikTok/IG), business logic, persistence via
Prisma ([`@repo/db`](../../packages/db)), and **orchestrating ML jobs** (enqueue to Redis/BullMQ,
the Python worker consumes them).

Typesafety: define routes with validators, **method-chain them**, and export `type AppType = typeof routes`.
That type is re-exported from [`@repo/api-contract`](../../packages/api-contract) for the clients.
Use `@hono/zod-openapi` so we also emit an OpenAPI spec (for the future public/agency API tier).

Calls into the Python ML service through the typed [`@repo/ml-client`](../../packages/ml-client).

_Scaffold placeholder — `bun init` + Hono go here._
