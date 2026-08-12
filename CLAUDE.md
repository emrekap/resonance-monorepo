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
  request.

### The analysis path — two queues, three processes

```text
apps/api  ──add──▶  [analysis]          ──▶  apps/ml   worker.py  (GPU)
                                               │
apps/worker  ◀────  [analysis-results]  ◀──────┘
     │ prismaService (BYPASSRLS)
     ▼
analyses · analysis_results · inference_runs        client reads GET /analyze/:jobId (realtime-refreshed)
```

Two queues rather than one, because of two rules that are load-bearing:

- **`apps/ml` never writes app tables.** Prisma is the single schema owner; a second ORM in Python
  is the drift this split exists to prevent. So the Python worker _reports_, and `apps/worker`
  persists.
- **`apps/api` never holds BYPASSRLS.** Writing an ML result crosses the tenant boundary and cannot
  go through `withUser()`/RLS, so it needs `app_service` — a credential with no business in a
  process that serves HTTP. That is why `apps/worker` is a separate process, not a second entrypoint
  in `apps/api`.

Interop is free, not bridged: the `bullmq` PyPI package is the official port and runs the **same Lua
scripts** as the npm one. Payload contract lives in `packages/queue/src/contract.ts`, mirrored by
hand in `apps/ml/queue_contract.py` — **change one, change the other.**

## Layout

```
apps/    mobile (Expo RN) · web (Next.js, later) · api (Bun+Hono BFF) · ml (Python FastAPI + BullMQ worker) · worker (Bun, results → Postgres)
packages/ db (Prisma) · queue (BullMQ contract) · api-contract (Hono RPC client) · tsconfig (@repo/tsconfig) · eslint-config (@repo/eslint-config) · ml-client (empty placeholder — the queue replaced the HTTP seam it was for; see its README)
infra/   docker (local Redis + bull-board) · deploy
research/ eval harness for the pre-registered validation experiment (Python island, never deploys)
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
- **BullMQ over Redis** for the api↔ml boundary, `@repo/queue` as the shared contract. Chosen over a
  bespoke Redis list or an HTTP call because retries/backoff, at-least-once delivery and a
  dashboard come for free — and because its Python port is protocol-identical, so the polyglot
  split costs no bridge service.

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
turbo run lint              # eslint all (type-aware; also builds first via ^build)
turbo run dev               # run dev tasks
bun run test                # turbo test + the apps/ml and research pytest suites (needs their .venv)
bun run test:research       # the eval harness suite (needs research/.venv)
bun run format              # prettier

# the analysis path, end to end — needs all four
bun run docker:local                 # Redis (`docker:local:tools` adds bull-board :3010)
cd apps/api    && bun run dev        # API → http://localhost:3000/health
cd apps/worker && bun run dev        # results → Postgres
cd apps/ml     && python worker.py   # GPU consumer
```

`apps/ml` is a **Python island** (no `package.json`, so Bun/Turbo ignore it by design) — run it via
`apps/ml/README.md` (venv + `python worker.py`, or uvicorn for the FastAPI face) or its
Docker/`manage_space.py`.

## tsconfig (`@repo/tsconfig`)

Extend the right base: `apps/api` → `@repo/tsconfig/bun.json`; `apps/web` → `nextjs.json`;
`apps/mobile` → `["@repo/tsconfig/react-native.json", "expo/tsconfig.base"]` (expo **last** so its
RN options win). All are type-check only (`noEmit`); the one exception is `apps/api`'s
`tsconfig.build.json`, which emits the `AppType` d.ts boundary.

## Current state

**Done:** root workspace (Bun + Turbo), `@repo/tsconfig`, `apps/api` (`/health` and `/analyze`, Zod
validated, with the `AppType` d.ts), `packages/api-contract` (RPC client), `apps/ml` (Python copied from
`../tribev2-api`), `packages/db` (Prisma 7 schema + migrations on Supabase Postgres, 23 tables, RLS
enforced and verified — see [`packages/db/README.md`](packages/db/README.md)), `apps/api` wired to
`@repo/db`: Supabase JWT (ES256/JWKS) middleware → `c.var.db` = `withUser` bound to the caller,
`/analyze` persisted in `analyses` + `media_assets` (see
[`apps/api/README.md`](apps/api/README.md)).

**Queue (done):** `@repo/queue` contract, `POST /analyze` enqueues, `apps/ml/worker.py` consumes and
runs TRIBE (sharing `engine.py` with the FastAPI face), `apps/worker` persists results, and a local
Redis plus bull-board in `infra/docker/`. Cross-language delivery and payload validation were verified
end-to-end against a real Redis; the Prisma writes in `apps/worker` are typechecked but have not run
against a database yet.

**Mobile + social (done):** `apps/mobile` (Expo SDK 57, `expo-router`, `src/app` tree) — Supabase
Google login via the browser PKCE flow, `Stack.Protected` route groups (`(onboarding)` vs `(app)`),
and a connected-accounts screen on the RPC client + TanStack Query; `apps/api` grew the
`/connected-accounts` domain (list / `:platform/start` / OAuth `callback` / disconnect) with
HMAC-signed connect state and AES-256-GCM-sealed tokens — YouTube (Google OAuth) implemented,
Instagram/TikTok answer 501 until their `PlatformProvider` lands. See
[`apps/mobile/README.md`](apps/mobile/README.md) and the connected-accounts section of
[`apps/api/README.md`](apps/api/README.md). Route auth/state logic is smoke-tested hermetically via
`app.request()`; the connect flow has not yet run against real Google credentials.

**Uploads (done):** the private `media` Storage bucket (workspace-scoped RLS in the `security_rls`
migration §7, 500 MiB / `video|audio|image` caps in `media_bucket_limits`); `POST /media` registers
an asset and the app streams the file to Storage with the user's own JWT (`expo-file-system`
`UploadTask`, progress + cancel); `POST /analyze { mediaAssetId }` mints a signed download URL by
forwarding the caller's token (existence + authz check in one, no storage secret in the API), flips
the asset READY, and queues the job; `(app)/analysis/[id]` polls to completion. Mobile now has a
full design-system layer (`src/design/*` tokens/theme, `src/components/ui/*` primitives — see
`apps/mobile/DESIGN.md`). The flow is typechecked + route-smoke-tested; not yet run
end-to-end against a device + live worker.

**History + pagination (done, one gate):** `apps/api/src/lib/pagination.ts` is the shared list
contract — `pageQuery(sortKeys, defaultSort)` for `limit`/`offset`/`sort`/`order`, `repeatable()` for
`?status=A&status=B`, `paginated()` for the `{ items, page }` envelope (offset, not a cursor — see
the README's "Lists" section for why). `GET /analyze` uses all three, filtering on status / media
kind / created range and sorting on `createdAt` | `completedAt` | `resonanceScore`, always with an
`{ id: 'desc' }` tiebreak. Mobile has a **History** tab (`(app)/history.tsx` + `use-analyses.ts`)
with infinite scroll, pinned status/kind chips, and a sort menu. `media_assets.file_name` was added
so rows have a name to show. Its migration and the realtime one below are both applied. Nothing
here has run against a device yet.

**Realtime (done, unobserved):** mobile no longer polls for analysis status. `analyses` is a member
of the `supabase_realtime` publication, and `authenticated` holds a seven-column `SELECT` on it
(`20260805140000_realtime_analyses`) — the one exception to "clients hold no grants in `public`",
because `realtime.apply_rls` delivers a row only to a role with column privileges on it (`id` and
`workspace_id` are load-bearing: without the first every event is dropped as 401, without the
second the policy cannot resolve). Rows stay scoped by `analyses_select` against forced RLS, and
`db:check-rls` now also fails on any column-level grant outside that allowlist.
`use-analysis-realtime.ts` mounts one channel in the `(app)` layout and invalidates TanStack keys;
the payload is never rendered, because a list row also needs `analysis_results` + `media_assets`.
Typechecked, linted and unit-tested — **no event has been observed reaching a device.**

**Insights (done, unobserved):** a successful analysis now fills every column it can.
`apps/ml/atlas/` holds a committed Schaefer-2018 17-network fsaverage5 parcellation (parcel ids, not
axis ids — the mapping lives in `axis_map.py` so it is reviewable); `parcellation.py` reduces the
`[T × 20484]` tensor to five product axes, and the transcript rides along from the whisperx events
already on each segment. `apps/worker` scores it: `percentileInChannel` is a rank against the
**workspace's own prior analyses** (no calibration needed, no cross-creator comparison),
`resonanceScore` is the same number rounded, and `analysis_axis_scores` gets five rows — all of it
withheld below 5 priors, because a rank with no history is not a number. Then `insights.ts` asks
`claude-opus-5` for `analysis_recommendations`, over numbers it is given rather than any it computes,
validated hard on the way in and best-effort throughout (`ANTHROPIC_API_KEY` unset → analyses still
score, just without tips). `GET /analyze/:id` returns the lot and the mobile result screen renders
verdict → timeline → why → do-this. Unit-tested on both sides of the queue, including a shared
fixture that catches api↔ml contract drift — **but no real clip has run through it end to end.**

**Validation harness (done, synthetic-only):** `research/` implements the pre-registered analysis
end to end — snapshot contract, synthetic ground-truth worlds, splits with the prereg's leakage
rules as runtime assertions, the B0–B4 ladder, bootstrap + paired Wilcoxon, three negative controls
that gate the run, and a mechanically-computed GREEN/YELLOW/RED verdict written to
`results.json` + `report.md`. 164 tests. **No real cohort has ever run through it** — every number
it has produced came from a world whose ground truth it generated itself.

## TODO

**Blocking, and one of them blocks the honesty of everything else.**

1. **Check the atlas against real anatomy.** `parcellation.py` asserts the atlas has the expected
   `n_vertices`, but its **vertex order has never been checked against a real brain** — and a
   transposed or differently-ordered surface still averages to plausible numbers on all five axes,
   so the failure is silent by construction. Everything downstream (axes, composite,
   `percentileInChannel`, `resonanceScore`, the insight prompt) inherits it. The check is cheap: one
   high-motion clip should light the visual band and little else. **Do this before quoting any axis
   number to anyone.** Also tracked in `docs/resonance-model-design.md` §2e and
   `docs/validation-prereg.md` §9.
2. **Run a real clip through ml → worker → Postgres** and confirm the five timeline arrays land.
   Same run yields (1), the real per-analysis Anthropic cost, and the `TR_SEC` manifest via
   `ML_RECORD_DIR` — three unknowns for one GPU-minute.
3. **Run the upload→analyze flow on-device** against a live GPU worker.
4. **Run the YouTube connect flow** against real Google credentials + Supabase Google login.

**Product surfaces that are specified but absent.** Each is promised in `docs/` and has no code:

- **A/B variants** — `resonance-model-design.md` §3 calls ranking "the tip of the spear" and the
  most defensible use of a noisy model. No route, no schema, no screen.
- **Credits / billing** — `CreditBalance`, `CreditTransaction` and `analyses.credits_charged` exist
  in the schema and **nothing reads or writes them**. The one-pager's entire business model is
  usage-based credits. Either build the meter or record the deferral; a billing schema no code
  touches is the kind of thing that silently rots.
- **The ToS purge sweep** — `connected-accounts` disconnect sets `purgeAfter`, `data_deletion_requests`
  exists as the audit trail, and `platform-data-contract.md` says all three platforms _require_
  deletion. **No sweep runs.** This is the compliance-shaped one.
- **Cold-start copy** — a workspace's first four analyses correctly have no score. The screen says
  so only via a caption; there is no onboarding that sets the expectation.

**Decisions still open.**

- **`BAND_SUMMARY`** (`apps/worker/src/scoring.ts`) is `'peak'` by argument, not by evidence, and it
  feeds the composite → the percentile → the headline number. Settling it needs real clips ranked
  each way; it is not in scope for the pre-registration.
- **The calibration head** that would give `resonanceScore` an absolute meaning
  (`docs/resonance-model-design.md` §2), gated on `docs/validation-prereg.md`.
- **Validation cohort acquisition** — the gating dependency for the whole experiment. The _analysis_
  is no longer a dependency: `research/` implements it against synthetic ground truth, so the day a
  cohort lands the harness runs. What remains is acquisition. See
  `docs/validation-experiment-spec.md` §11a: YouTube gives no source video files, so the corpus
  needs a paid or design-partner motion, not an ask.

**`apps/api` + `apps/worker` deploy (code-complete, unverified against a real AWS account):**
`infra/deploy/{api,worker}/Dockerfile` (Bun multi-stage, `turbo prune --docker` — both build and run
locally against real Redis + Supabase credentials) and `infra/deploy/terraform/` (ECS Fargate, no
ALB/NAT, SSM-parameter secrets) target AWS, provisioned on demand for investor demos rather than
continuously — see `docs/superpowers/specs/2026-08-09-deploy-api-worker-design.md`. Production Redis
is a free Render Key Value instance shared by all three processes; `noeviction` is required and is
**not** stated as that plan's default, so `make redis-check` must confirm it before the first real
job crosses it. The root `Makefile` drives the lifecycle (`make start` / `stop` / `deploy-api` / …).
**Nothing here has run `terraform apply` against a real account yet** — that, plus the Google OAuth
redirect URI (a Fargate task's public IP is not stable without an added Route 53 record, §3/§10 of
the spec) and the ECS `stopTimeout` value, are the open items before the first real demo.

**Also queued:** the ml worker's own deploy image (Hugging Face Space, already working — a separate,
smaller decision, see the spec's §9); Instagram/TikTok `PlatformProvider`s; Facebook/TikTok login
providers; scaffold `apps/web`.

**Not** `@repo/ml-client` — the queue replaced the HTTP seam it was scaffolded for, and it only
becomes real if something in the TS layer needs a synchronous call into `apps/ml`.

## Conventions

- Package scope `@repo/*`, `private`, `type: module`.
- **Looking for code?** Query the codebase index first (see _Code discovery_ above) — then `Read`.
- **Adding/editing an API route?** Use the `add-api-route` skill (`.claude/skills/`). A directory per
  domain, a file per route: each route file exports its own method-chained `Hono`, and the domain's
  `index.ts` composes them with `.route()`. Schema, validation and Prisma calls live in the route's
  own file; `src/lib/*` holds only what a second route needs. Responses may carry Prisma enums, but
  import them from `@repo/db/enums` (a leaf module, browser-safe) — never from the `@repo/db` barrel,
  which drags `client.ts` into the Expo/Next typecheck.
- **Adding a package or app?** Use the `add-package` skill (`.claude/skills/`).
- **Touching the queue?** Payload shapes live in `packages/queue/src/contract.ts` and are mirrored by
  hand in `apps/ml/queue_contract.py` — change both. Prefer `.nullish()` over `.optional()` in the
  zod schemas: Pydantic serialises an unset field as `null`, which `.optional()` rejects.
- **Adding/changing a DB model?** Use the `add-db-model` skill (`.claude/skills/`) — snake_case
  `@@map`/`@map`, `<name>_enum` for enum types, and every new table needs RLS enabled + forced with
  a policy rooted at `workspace_id` or `profile_id`.
- **Touching `apps/ml`?** Test first. `cd apps/ml && pytest` needs no GPU, no torch and no `tribev2`,
  because the model sits behind a backend seam (`backends/`) — and CI enforces that by installing
  only `requirements-dev.txt`. **Never add a module-scope `import torch` to a tested module**; only
  `backends/tribe.py` may import it, and only inside a function. Run the whole worker without a GPU
  via `ML_BACKEND=synthetic python worker.py`.
- After structural changes, **re-index** so the graph doesn't go stale.
- Commit / push only when asked.
