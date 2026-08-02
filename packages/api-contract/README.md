# packages/api-contract

The typesafety seam between the **Bun API** and the **clients**.

Re-exports the Hono `AppType` (from [`apps/api`](../../apps/api)) plus shared Zod schemas, so
[`apps/mobile`](../../apps/mobile) and [`apps/web`](../../apps/web) depend on a stable package rather
than reaching into the app directly. Clients build a typed client with `hc<AppType>(BASE_URL)`.

No codegen — this is pure TypeScript type sharing across the workspace (why the monorepo exists).

_Scaffold placeholder._
