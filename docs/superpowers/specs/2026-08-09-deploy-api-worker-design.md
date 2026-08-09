# Deploying `apps/api` and `apps/worker` — design

**Date:** 2026-08-09
**Status:** design, not yet implemented
**Scope:** container images and a production host for the two Bun services, plus the production
Redis decision. `apps/ml` is explicitly out of scope — it already deploys to a Hugging Face Space
and works.

---

## 1. Goal

Get the two processes that have no deploy story at all — `apps/api` and `apps/worker` — running in
production, on a host, from images built out of this monorepo, talking to a Redis that does not lose
jobs.

Success is a single observable thing: **a clip uploaded from a device is analysed end to end by
processes nobody is running on a laptop.** Every requirement below exists to make that sentence true
and to keep it true across a redeploy.

## 2. What already exists, and what does not

| Component       | Deploy story today                                                           |
| --------------- | ---------------------------------------------------------------------------- |
| `apps/ml`       | `Dockerfile` + `entrypoint.sh` + `manage_space.py` → Hugging Face Space, GPU |
| `apps/api`      | none                                                                         |
| `apps/worker`   | none                                                                         |
| Redis           | `infra/docker/docker-compose.yml`, local only                                |
| `infra/deploy/` | referenced in `CLAUDE.md`, **does not exist**                                |

Two things in the existing code turn out to be already correct for production, and the design depends
on both:

- **`packages/queue/src/connection.ts`** sets `maxRetriesPerRequest: null` — which BullMQ _requires_
  for any process running a `Worker` — and a retry strategy that survives a Redis restart. ioredis
  parses a `rediss://` URL and enables TLS on its own. Moving to a managed Redis is a URL change and
  nothing else.
- **`apps/worker/src/index.ts`** already handles `SIGINT`/`SIGTERM` by calling `worker.close()`,
  which drains in-flight handlers before exit. A platform redeploy therefore does not abandon a job
  mid-write. This is load-bearing and must not regress.

## 3. The host: Render, but not the free tier

Render was chosen for Dockerfile-native deploys and low ops burden. The free tier cannot run this
architecture, for two independent reasons, and both fail **silently** — which is why they are
recorded here rather than discovered later.

**Blocker 1 — background workers are not a free service type.** Render's free instances cover web
services, static sites, Postgres and Key Value. `apps/worker` has no HTTP surface by construction:
it is the process that holds `app_service`, the BYPASSRLS credential, and `CLAUDE.md` forbids that
credential living in anything that serves HTTP. The only free workaround is to deploy it as a _web
service_ with a dummy endpoint — but free web services spin down after 15 minutes without inbound
traffic, and a queue consumer receives no inbound traffic by definition. It would spin down ~15
minutes after each deploy and stay down until someone hit the dummy URL, while `apps/ml` kept
publishing to `analysis-results` and nothing persisted them. No error would appear anywhere.

**Blocker 2 — free Key Value is in-memory only.** Render's docs: _"whenever an instance restarts, all
of its data is lost."_ For BullMQ that is queued GPU jobs vanishing on any restart or maintenance
window. The local compose file already runs AOF `everysec` specifically to prevent this.

**Decision.**

| Service       | Render type       | Plan             | Why                                                                                                    |
| ------------- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/api`    | Web Service       | Free to start    | Cold start ≈1 min after 15 min idle. Acceptable with no users; one toggle to Starter when that changes |
| `apps/worker` | Background Worker | Starter (~$7/mo) | Cannot be free. A queue consumer must stay resident                                                    |

The free API tier is a deliberate, reversible trade, not an oversight: it is recorded here so that
the first user-facing latency complaint has an obvious cause and a one-line fix.

**The worker gets no ingress, and the platform enforces it.** A Render Background Worker has no
public URL by construction. The architectural rule that `app_service` never sits behind HTTP stops
being a convention maintained by discipline and becomes a property of the deployment.

## 4. Redis: Upstash, on a Fixed plan

**Not pay-as-you-go.** Upstash's own BullMQ integration page states that BullMQ "accesses Redis
regularly, even when there is no queue activity," which "can incur extra costs because Upstash
charges per request on the Pay-As-You-Go plan," and recommends a Fixed plan. BullMQ's blocking
`BZPOPMIN` reconnects roughly every 5 seconds per worker and the stalled-job checker runs every 30
seconds, so an entirely idle system bills continuously. Fixed plan, from the start.

**`noeviction` must be verified, not assumed.** BullMQ's production guide is unambiguous: it "cannot
work properly if Redis evicts keys arbitrarily," and `noeviction` is "the only setting that
guarantees the correct behavior of the queues." Upstash's BullMQ page does not mention eviction
policy at all. Confirm the policy on the actual provisioned database before any real job crosses it;
if Upstash cannot guarantee `noeviction`, that invalidates this choice and the fallback is a Redis
instance we configure (Render Key Value on a paid plan, or a container with a volume), mirroring
`infra/docker/docker-compose.yml`.

**`apps/ml` is a third consumer of this URL.** The Space runs `worker.py` against the same queue via
the Python `bullmq` package. Rotating `REDIS_URL` means updating a Space secret too. No code changes
there — but the cutover is three places, not two.

## 5. The two images

Both are built from the repo root and run on `oven/bun`, pinned to the version in the root
`package.json` `packageManager` field (`bun@1.3.14`) so the image cannot drift from the lockfile.
They differ only in entrypoint and in whether a port is exposed.

**Build context is the repo root, not the app directory.** These are Bun workspaces: `apps/api` on
its own is not buildable. The build needs the root `package.json`, `bun.lock`, and the workspace
packages each app depends on (`@repo/db`, `@repo/queue`). Render must be configured with the repo
root as Docker context and the Dockerfile path pointed at `infra/deploy/<service>/Dockerfile`.

**`prisma generate` runs at build, and needs a placeholder.** `packages/db`'s build step is
`prisma generate`, and `packages/db/prisma.config.ts` resolves `env('DIRECT_DATABASE_URL')` or
throws — even though generating a client never opens a connection. `.github/workflows/test.yml`
already solves this with a placeholder value; the Dockerfile uses the same trick, via a build arg
that is obviously not a real host so nobody mistakes it for a leaked credential.

**No TypeScript compile step.** Bun runs TypeScript directly. `apps/api`'s `build` script
(`tsc -p tsconfig.build.json` → `dist/app.d.ts`) exists only so the mobile and web typechecks see a
compiled `.d.ts` boundary rather than raw source. It is not needed at runtime, so the images skip it
and do not ship `dist/`.

**Multi-stage, with one hazard to verify.** A deps stage runs `bun install --frozen-lockfile` and
`prisma generate`; a runtime stage carries the result plus source. The hazard is that Bun hoists
`node_modules` to the repo root and symlinks workspace packages into it — a naive `COPY` across
stages can produce dangling links that fail only at runtime. **Each image must be built and run
locally, against real Upstash and Supabase credentials, and shown to start before it is pushed.**
If the multi-stage copy proves fragile, a single-stage image is the accepted fallback: correctness
first, size later.

Both images run as a non-root user.

## 6. Configuration

Nothing is baked into an image. Every value below is set on the Render service.

**`apps/api`** — `PORT`, `API_PUBLIC_URL` (the Render URL; also the OAuth callback origin, so it must
match what is registered with Google), `REDIS_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`APP_USER_DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_STATE_SECRET`,
`TOKEN_ENCRYPTION_KEY`.

**`apps/worker`** — `REDIS_URL`, `APP_SERVICE_DATABASE_URL`, `ANTHROPIC_API_KEY`.

Two properties of that split are worth stating because they are the point of the two-process design:
the API's database URL is the RLS-enforced `app_user` role, the worker's is `app_service`, and
**neither service holds the other's credential**. And `ANTHROPIC_API_KEY` is absent from the API
entirely — insight generation happens only in the worker.

`APP_PUBLIC_URL` changes when the API moves off its Render subdomain to a custom domain; the Google
OAuth redirect URI must be updated in the same change or the connect flow breaks with an opaque
error.

**TLS to Postgres.** Both database URLs carry `sslmode=no-verify` today, because Supabase signs
Postgres certs with its own CA (`packages/db/README.md` §TLS). That needs no file in the image. If it
is ever hardened to `verify-full`, `certs/prod-ca-2021.crt` must be baked in or mounted — a change
to the image, not just to config.

## 7. Health and lifecycle

`apps/api` exposes `GET /health`; Render's web service health check points at it. A health check that
only proves the process is up is worth less than one that proves its dependencies resolve, but
widening it is out of scope here — noted so the next person knows the current check is shallow.

`apps/worker` needs no health check and gets none. Its liveness signal is the queue: a growing
`analysis-results` waiting count means the worker is not consuming. Render restarts the process if it
exits; BullMQ redelivers the job it was holding.

Redeploys rely on the existing SIGTERM drain (§2). Verify that Render's shutdown grace period exceeds
the slowest handler — a worker killed mid-write leaves an analysis marked in-flight with no result
row, and the retry is what repairs it.

## 8. Verification — what "done" means

In order, each gating the next:

1. Both images build from a clean clone and **start locally** against real Upstash + Supabase
   credentials. This catches the symlink hazard in §5.
2. `curl $API_PUBLIC_URL/health` answers on the deployed API.
3. The provisioned Redis is confirmed `noeviction` (§4).
4. An analysis enqueued against production Redis is consumed by the Space's `worker.py` and persisted
   by the deployed `apps/worker` — the first time the full path runs with nothing on a laptop.
5. A redeploy of `apps/worker` during an in-flight job does not lose it.

Item 4 is the same run that would settle three open questions already tracked in `CLAUDE.md`: the
atlas sanity check, the real per-analysis Anthropic cost, and the `TR_SEC` manifest.

## 9. Deliberately out of scope

- **`apps/ml`.** It deploys and works. Consolidating GPU hosting is a separate decision with its own
  spec, and re-solving a working deployment is not warranted here.
- **CD.** Deploys are manual (push to `main`, deploy from the Render dashboard) until the images are
  proven. Automating an unverified deploy path automates a failure.
- **`apps/web`.** Not scaffolded.
- **Autoscaling, multi-region, zero-downtime.** No users yet.
- **Image size optimization.** Correctness first; revisit if build times or cold starts hurt.

## 10. Open items to settle during implementation

1. **`noeviction` on Upstash** — the one item that can invalidate §4. Settle it first.
2. Whether the multi-stage copy preserves Bun's workspace symlinks, or the single-stage fallback is
   needed (§5).
3. Render's shutdown grace period versus the slowest worker handler (§7).
4. Whether Render's free web service cold start is tolerable for the mobile app's first request, or
   whether `apps/api` should start on Starter after all.
