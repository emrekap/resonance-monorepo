# resonance-monorepo

Monorepo for **Resonance** — AI content-resonance prediction for creators & brands, built on the
TRIBE v2 brain-encoding model.

## Architecture (polyglot split)

Two workloads with opposite shapes, so two runtimes with a clean boundary:

- **TypeScript / Bun app layer** — many small, I/O-bound requests (auth, CRUD, social OAuth, serving
  the mobile & web clients). Owns the DB (Prisma) and orchestrates ML jobs. Scales cheaply on CPU.
- **Python ML layer** — few heavy, long, GPU-bound inference jobs (video decode → whisperx → TRIBE).
  Runs as a queue worker. Scales independently on GPU (and to zero when idle).

```
mobile / web ──(Hono RPC, fully typed)──▶ Bun API ──enqueue──▶ Redis/BullMQ ──▶ Python GPU worker
                                             │                                        │
                                             ▼ Prisma                                 ▼ returns preds
                                          Postgres ◀────────── writes result ─────────┘
                                                              videos → object storage
```

## Layout

```
resonance-monorepo/
├── apps/
│   ├── mobile/         Expo / React Native
│   ├── web/            Next.js (later)
│   ├── api/            Bun + Hono (RPC) + Prisma — app backend / BFF
│   └── ml/             Python FastAPI — TRIBE inference worker (migrated from ../tribev2-api)
├── packages/
│   ├── db/             Prisma schema + generated client — single source of truth
│   ├── api-contract/   Re-exports the Hono `AppType` for client typesafety
│   └── ml-client/      Typed TS client generated from ml's OpenAPI spec
└── infra/              Docker, deploy, queue config
```

## Stack decisions

- **App API:** Bun + **Hono**, using **Hono RPC** (`hc<AppType>`) for end-to-end typesafety — **no
  tRPC** (Hono RPC covers the same ground; adding tRPC would be a redundant second RPC paradigm).
- **Schema/DB:** Prisma + Postgres. Prisma is the **single schema owner**; the Python service never
  writes app tables directly.
- **Clients:** Expo (React Native) and Next.js, both consuming `AppType` + TanStack Query.
- **ML:** Python / FastAPI (torch, TRIBE, whisperx), run as a job worker behind a queue.
- **Queue:** Redis + BullMQ between the Bun API and the Python worker (inference is seconds→minutes;
  never block a client request on it).

## Typesafety model

- **client ↔ Bun:** shared TypeScript types via `packages/api-contract` (compile-time, no codegen).
- **Bun ↔ Python:** typed client generated from the ML service's OpenAPI spec (`packages/ml-client`).

## Status / next steps

Folder scaffold only. Not yet wired. Next: root `package.json` (Bun workspaces) + `turbo.json` +
base `tsconfig`, then Prisma init in `packages/db`, then migrate the existing `../tribev2-api` Python
service into `apps/ml`.