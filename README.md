# resonance-monorepo

Monorepo for **Resonance** — AI content-resonance prediction for creators & brands, built on the
TRIBE v2 brain-encoding model.

Product and ML design notes live in [`docs/`](docs/). Working agreements for this repo live in
[`CLAUDE.md`](CLAUDE.md).

## Architecture (polyglot split)

Two workloads with opposite shapes, so two runtimes with a clean boundary:

- **TypeScript / Bun app layer** — many small, I/O-bound requests (auth, CRUD, social OAuth, serving
  the mobile & web clients). Owns the DB (Prisma) and orchestrates ML jobs. Scales cheaply on CPU.
- **Python ML layer** — few heavy, long, GPU-bound inference jobs (video decode → whisperx → TRIBE).
  Runs as a queue worker. Scales independently on GPU (and to zero when idle).

```text
mobile / web ──(Hono RPC, fully typed)──▶ apps/api ──add──▶ [analysis] ──▶ apps/ml worker.py (GPU)
                                              │                                    │
                                              ▼ Prisma (RLS, as the caller)        │ reports
                                           Postgres                                ▼
                                              ▲                            [analysis-results]
                                              │                                    │
                                              └── apps/worker ◀────────────────────┘
                                                  prismaService (BYPASSRLS)
```

**Two queues, three processes** — and the shape is load-bearing in both directions:

- **`apps/ml` never writes app tables.** Prisma is the single schema owner; a second ORM in Python is
  exactly the drift this split exists to prevent. So the Python worker _reports_ what it computed and
  `apps/worker` persists it.
- **`apps/api` never holds BYPASSRLS.** Writing an ML result crosses the tenant boundary and cannot
  go through `withUser()`/RLS, so it needs the `app_service` credential — which has no business in a
  process that serves HTTP. That is why `apps/worker` is a separate process rather than a second
  entrypoint in `apps/api`.

Interop is free rather than bridged: the `bullmq` PyPI package is the official port of the npm one
and runs the same Lua scripts against Redis, so the queue straddles the language split with no
bridge service.

## Layout

```text
resonance-monorepo/
├── apps/
│   ├── mobile/         Expo / React Native (SDK 57, expo-router)
│   ├── web/            Next.js — not scaffolded yet
│   ├── api/            Bun + Hono (RPC) + Prisma — app backend / BFF
│   ├── ml/             Python FastAPI + BullMQ worker — TRIBE inference (a Python island; no package.json)
│   └── worker/         Bun + BullMQ — persists ML results to Postgres
├── packages/
│   ├── db/             Prisma schema + generated client — single source of truth
│   ├── queue/          BullMQ contract shared by api / worker, mirrored by hand in apps/ml
│   ├── api-contract/   Re-exports the Hono `AppType` + `createApiClient` for client typesafety
│   ├── tsconfig/       Shared `@repo/tsconfig` bases (bun / nextjs / react-native)
│   ├── eslint-config/  Shared `@repo/eslint-config`
│   └── ml-client/      Placeholder — see packages/ml-client/README.md
├── infra/              Docker (local Redis + bull-board), deploy
└── research/           Eval harness for the validation experiment (Python island; never deploys)
```

## Stack decisions

- **App API:** Bun + **Hono**, using **Hono RPC** (`hc<AppType>`) for end-to-end typesafety — **no
  tRPC** (Hono RPC covers the same ground; adding tRPC would be a redundant second RPC paradigm).
- **Schema/DB:** Prisma + Postgres (Supabase). Prisma is the **single schema owner**; the Python
  service never writes app tables directly.
- **Clients:** Expo (React Native) and Next.js, both consuming `AppType` + TanStack Query.
- **ML:** Python / FastAPI (torch, TRIBE, whisperx), run as a job worker behind a queue.
- **Queue:** Redis + BullMQ between the Bun API and the Python worker (inference is seconds→minutes;
  never block a client request on it). Chosen over a bespoke Redis list or a plain HTTP call because
  retries, backoff, at-least-once delivery and a dashboard come for free.

## Typesafety model

- **client ↔ Bun:** shared TypeScript types via `packages/api-contract` (compile-time, no codegen).
  `AppType` crosses as a compiled `.d.ts` (`apps/api` `build` → `dist/app.d.ts`), so Bun globals do
  not leak into the Expo/Next typecheck — **rebuild after changing routes**.
- **Bun ↔ Python:** the analysis path is **not** an HTTP call, so there is no generated client on it.
  The contract is `packages/queue/src/contract.ts` (Zod) mirrored by hand as Pydantic models in
  `apps/ml/queue_contract.py`, validated on both sides. **Change one, change the other.**

## From a fresh clone

In order, because three of these fail confusingly if skipped:

```bash
bun install                 # 1. install + link workspaces
bun run build               # 2. REQUIRED ONCE — emits apps/api dist/app.d.ts.
                            #    `dist/` is gitignored, so until this runs, every
                            #    AppType in the clients resolves to `unknown`.
                            #    It also runs `prisma generate` for @repo/db.

# 3. env files — five of them, none checked in. Each .env.example explains its own.
cp apps/api/.env.example     apps/api/.env       # DB + Supabase + Redis (+ OAuth)
cp apps/worker/.env.example  apps/worker/.env    # BYPASSRLS DB + Redis (+ Anthropic)
cp apps/mobile/.env.example  apps/mobile/.env    # Supabase URL/key + API URL
cp packages/db/.env.example  packages/db/.env    # the four role URLs, for migrations
cp apps/ml/.env.example      apps/ml/.env        # HF_TOKEN + Redis

# 4. the Python island — Bun/Turbo do not manage it, and `bun run test:ml` needs it
cd apps/ml && python -m venv .venv && ./.venv/bin/pip install -r requirements-dev.txt

# 4b. the second Python island — only needed to run the eval harness
cd research && python -m venv .venv && ./.venv/bin/pip install -r requirements.txt

bun run docker:local        # 5. Redis
```

Only step 2 is mandatory to get editors working; the rest are per-thing-you-want-to-run.

## Commands

```bash
bun install                 # install + link workspaces
turbo run build             # emit apps/api AppType d.ts
turbo run typecheck         # typecheck all (builds first via ^build)
turbo run lint              # eslint all
bun run test                # turbo test + the apps/ml and research pytest suites (needs their .venv)
bun run format              # prettier

# the analysis path, end to end — needs all four
bun run docker:local                 # Redis (`docker:local:tools` adds bull-board :3010)
cd apps/api    && bun run dev        # API → http://localhost:3000/health
cd apps/worker && bun run dev        # results → Postgres
cd apps/ml     && python worker.py   # GPU consumer (ML_BACKEND=synthetic runs it without a GPU)
```

## When an analysis goes wrong

The failure modes the code handles, and where each one is actually visible. Worth reading once
before you need it, because the evidence is spread across three processes.

| Symptom                                | Where to look                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stuck `QUEUED`, nothing in the ml logs | No consumer. Is `apps/ml` running, and on the **same** `REDIS_URL` and `QUEUE_PREFIX`?                                                                                   |
| Stuck `PROCESSING` for a long time     | The GPU run outlived `ML_WORKER_LOCK_MS` (default 30 min) → BullMQ's stalled-job checker requeued it. Raise the lock, don't lower the timeout.                           |
| `SUCCEEDED` but no score               | Expected below **5** prior analyses in the workspace — the score is a rank. See `apps/worker/README.md`.                                                                 |
| `SUCCEEDED` but no tips                | `ANTHROPIC_API_KEY` unset (one warning at boot), or the insight call failed — the reason is recorded on `analysis_results.raw_stats.insights`. Never fails the analysis. |
| `FAILED`                               | `analyses.error` holds the one-line message. The **full traceback survives only in bull-board** (`bun run docker:local:tools` → :3010).                                  |
| Nothing at all, but the job was added  | Redis evicted it. BullMQ requires `maxmemory-policy noeviction`; any other policy drops job hashes silently.                                                             |

A single retryable miss writes an `inference_runs` row and nothing else — an analysis only flips
`FAILED` when the **last** attempt fails, so "still working" during a retry is correct, not a bug.

## CI

[`.github/workflows/test.yml`](.github/workflows/test.yml) runs two independent jobs on push to
`main` and on every PR:

- **`apps/ml (pytest)`** installs only `requirements-dev.txt` — deliberately _not_ `requirements.txt`,
  which pins torch and installs `tribev2` from git. Installing the dev file is itself the test: if a
  tested module grows a module-scope `import torch`, this job goes red. The `integration` (needs
  Redis) and `gpu` (needs the real model) marks are deselected by `pytest.ini`.
- **`turbo (typecheck + test)`** runs `bunx turbo run typecheck test`. It passes a placeholder
  `DIRECT_DATABASE_URL` because `typecheck`'s `^build` dependency reaches `@repo/db`'s
  `prisma generate`, whose config resolves that variable or throws — generating a client never
  connects, and nothing in the job talks to a database.

## Status

The analysis path is built end to end and is typechecked, linted and unit-tested — but **it has not
yet been run against a real clip on a live GPU**. See the "Current state" and "TODO" sections of
[`CLAUDE.md`](CLAUDE.md) for what is done, what is done-but-unobserved, and what is next.
