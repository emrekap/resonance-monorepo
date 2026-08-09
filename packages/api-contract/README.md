# @repo/api-contract

The typesafety seam between the **Bun API** and the **clients**.

Re-exports the Hono `AppType` (from [`apps/api`](../../apps/api)) and wraps `hc<AppType>` as
`createApiClient(baseUrl)`, so [`apps/mobile`](../../apps/mobile) and
[`apps/web`](../../apps/web) depend on a stable package rather than reaching into the app directly.

No codegen — this is pure TypeScript type sharing across the workspace (why the monorepo exists).

```ts
import { createApiClient } from '@repo/api-contract';

const api = createApiClient('http://localhost:3000');
const res = await api.health.$get(); // typed
const job = await api.analyze.$post({ json: { mediaAssetId } });
```

## Exports

| Export                 | What                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `createApiClient(...)` | `hc<AppType>` with the server's routes already applied                   |
| `ApiClient`            | the client's return type, for typing hooks and providers                 |
| `AppType`              | the raw Hono route type, re-exported for anything that needs it directly |

Wrap the client in TanStack Query on each consumer; this package stays transport-only.

## Two things that will bite

- **`AppType` reaches consumers as a compiled `.d.ts`**, not raw source — `apps/api`'s `build` emits
  `dist/app.d.ts`, and its `package.json` `exports` maps `types → dist` while `default → src`. Source
  would leak Bun/Node globals (`crypto`, `process`, …) into the Expo/Next typecheck under the wrong
  lib. So **after changing routes, rebuild** (`turbo run build`, or let `typecheck`'s `^build` do it),
  and a fresh clone needs `bun run build` once before editors can resolve `AppType`.
- **Routes must stay method-chained** and be mounted with `.route()` in `apps/api/src/app.ts`. Break
  the chain and the RPC types here collapse to `unknown` — silently, with no error at this end.
