# Resonance Monorepo

AI that predicts how well creator/brand content (image / video / audio) will **resonate & engage**,
built on Meta's **TRIBE v2** brain-encoding model. This monorepo holds the product: mobile + web
clients, a Bun/Hono app backend, and a Python ML inference service.

> Product & ML design docs (model design, per-platform data contract, validation spec, investor
> one-pager) live in [`docs/`](docs/).

## Architecture — polyglot split

Two workloads with opposite shapes → two runtimes with a clean boundary:

- **TS/Bun app layer** (`apps/api`) — many small, I/O-bound requests (auth, CRUD, social OAuth,
  serving clients). Owns Postgres via Prisma. Orchestrates ML jobs. Scales cheap on CPU.
- **Python ML layer** (`apps/ml`) — few heavy, long, GPU-bound inference jobs (TRIBE:
  video → whisperx → torch). Runs as a queue worker. Scales on GPU, independently.
- **Between them: a Redis/BullMQ queue** — inference is seconds→minutes, so never block a client
  request. Client → api enqueues → ml worker consumes → writes result → client polls.

## Layout

```
apps/    mobile (Expo RN) · web (Next.js, later) · api (Bun+Hono BFF) · ml (Python FastAPI)
packages/ db (Prisma) · api-contract (Hono RPC client) · tsconfig (@repo/tsconfig) · ml-client (TS client from ML OpenAPI)
infra/   docker · queue · deploy
```

## Code discovery — query the index FIRST

This repo is indexed in **codebase-memory-mcp** as project
**`Users-emre-Desktop-files-resonance-monorepo`** — pass that as `project` on every call. The graph
spans **both halves of the polyglot split** (TS in `apps/api` + `packages/*`, Python in `apps/ml`),
so it answers cross-language questions grep structurally cannot.

**Before** reaching for Grep/Glob to find code, use:

| Need                                               | Tool                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Find a function / class / route                    | `search_graph` — `query` for natural language, `name_pattern` for regex, `label: "Route"` for endpoints |
| Read a symbol's source                             | `get_code_snippet` with the `qualified_name` returned by `search_graph`                                 |
| Callers, callees, impact, data flow                | `trace_path` — `mode: calls` / `data_flow`                                                              |
| An `api` → `ml` hop across the HTTP/queue boundary | `trace_path` with `mode: "cross_service"`                                                               |
| Packages, routes, entry points, layout             | `get_architecture`                                                                                      |
| Text search, deduped into containing functions     | `search_code` (graph-augmented grep)                                                                    |
| Multi-hop / aggregate questions                    | `query_graph` (Cypher)                                                                                  |

Qualified names are project-prefixed, e.g.
`Users-emre-Desktop-files-resonance-monorepo.apps.ml.manage_space.main`.

Keep using Grep/Glob/Read directly for **non-code** files (Markdown, JSON, configs, `.env.example`,
lockfiles) — those aren't graph nodes. And **always `Read` a file before editing it**: the index
finds code, it does not replace seeing the current bytes.

**Keep it fresh.** The graph is a snapshot, not a live view — it can lag the working tree. After
adding, renaming, or moving code (new route, new package, refactor), re-index:

```
index_repository(repo_path: "/Users/emre/Desktop/files/resonance-monorepo")
```

`index_status` reports readiness and the indexed commit; `detect_changes` shows what moved since a
ref. If the graph and a `Read` ever disagree, the file wins.

## Stack decisions (and the WHY)

- **Bun + Hono**, typesafety via **Hono RPC** (`hc<AppType>`). **NO tRPC** — Hono RPC covers the
  same ground; a second RPC system would be redundant.
- **Prisma + Postgres**, the **single schema owner**. The Python ML service NEVER writes app tables
  (no second ORM → no schema drift). Heavy training data (features) → object storage, not the DB.
- **`@hono/zod-openapi`** for routes (planned) → Zod validation + typed client + an OpenAPI spec,
  needed for the future brand/agency public API AND to generate `@repo/ml-client`.
- **Clients** (Expo + Next) both consume `@repo/api-contract` + TanStack Query.

## Typesafety model — IMPORTANT RULES

- Routes in `apps/api` MUST be **method-chained** and mounted with `.route()` so their types compose
  into `AppType` (`src/app.ts`). Break the chain → RPC types collapse to `unknown`.
- `AppType` reaches consumers as a **compiled `.d.ts` boundary** (`apps/api` `build` →
  `dist/app.d.ts`), NOT raw source — otherwise Bun/Node globals (`crypto`, `process`, …) leak into
  the mobile/web/contract typecheck under the wrong lib. `package.json` `exports` maps
  `types → dist`, `default → src` (Bun still runs source).
- Therefore **after changing routes, rebuild** (`turbo run build`, or it runs via `typecheck`'s
  `^build` dep). `dist/` is gitignored → a fresh clone needs `bun run build` once for editors to
  resolve `AppType`.
- `packages/api-contract` re-exports `AppType` + `createApiClient(baseUrl)` = `hc<AppType>`.

## Commands

```bash
bun install                 # install + link workspaces
turbo run build             # emit apps/api AppType d.ts
turbo run typecheck         # typecheck all (builds first via ^build)
turbo run dev               # run dev tasks
cd apps/api && bun run dev  # API → http://localhost:3000/health
bun run format              # prettier
```

`apps/ml` is a **Python island** (no `package.json`, so Bun/Turbo ignore it by design) — run it via
`apps/ml/README.md` (venv + uvicorn) or its Docker/`manage_space.py`.

## tsconfig (`@repo/tsconfig`)

Extend the right base: `apps/api` → `@repo/tsconfig/bun.json`; `apps/web` → `nextjs.json`;
`apps/mobile` → `["@repo/tsconfig/react-native.json", "expo/tsconfig.base"]` (expo **last** so its
RN options win). All are type-check only (`noEmit`); the one exception is `apps/api`'s
`tsconfig.build.json`, which emits the `AppType` d.ts boundary.

## Current state

**Done:** root workspace (Bun + Turbo), `@repo/tsconfig`, `apps/api` (`/health`, `/analyze` with Zod

- `AppType` d.ts), `packages/api-contract` (RPC client), `apps/ml` (Python service copied from
  `../tribev2-api`), `packages/db` (Prisma 7 schema + migrations on Supabase Postgres, 23 tables,
  RLS enforced and verified — see [`packages/db/README.md`](packages/db/README.md)).
  **TODO:** wire `apps/api` to `@repo/db` (replace the in-memory job `Map` in `routes/analyze.ts`,
  add Supabase JWT middleware → `withUser`); Redis/BullMQ queue in api; refactor `apps/ml` to a queue worker; generate `@repo/ml-client`
  from the ml OpenAPI; `packages/db` (Prisma: users, connected accounts, posts, jobs, results);
  scaffold `apps/mobile` + `apps/web`.

## Conventions

- Package scope `@repo/*`, `private`, `type: module`.
- **Looking for code?** Query the codebase index first (see _Code discovery_ above) — then `Read`.
- **Adding/editing an API route?** Use the `add-api-route` skill (`.claude/skills/`).
- **Adding a package or app?** Use the `add-package` skill (`.claude/skills/`).
- **Adding/changing a DB model?** Use the `add-db-model` skill (`.claude/skills/`) — snake_case
  `@@map`/`@map`, `<name>_enum` for enum types, and every new table needs RLS enabled + forced with
  a policy rooted at `workspace_id` or `profile_id`.
- After structural changes, **re-index** so the graph doesn't go stale.
- Commit / push only when asked.
