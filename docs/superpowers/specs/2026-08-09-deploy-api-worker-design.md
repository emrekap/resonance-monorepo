# Deploying `apps/api` and `apps/worker` — design

**Date:** 2026-08-09 (revised 2026-08-12)
**Status:** design, not yet implemented
**Scope:** container images and a production host for the two Bun services, plus the production
Redis decision. `apps/ml` is explicitly out of scope — it already deploys to a Hugging Face Space
and works.

**2026-08-12 revision — platform changed from Render to AWS, Redis from Upstash to Render.** The
usage pattern turned out to be narrower than "always-on production": this app runs **on demand, for
investor demos**, otherwise fully stopped. Render's Background Worker has no such state — it bills
Starter (~$7/mo) whether or not anything is running, because there's no API to scale a Render service
to zero and back. AWS Fargate does: `desired_count` is a live dial, billed per second while nonzero
and $0 at zero. That single property is why §3-§5 below now target ECS Fargate + Terraform instead of
Render. Redis separately moved to a **free Render Key Value instance** — the user's call, made
outside this doc; §4 records what that trades away and why it's an acceptable trade for a
demo-only, pause-between-uses pattern. Sections 1-2 and 9 are materially unchanged; §3-§8 and §10
are rewritten below (Render terminology swapped for its ECS equivalent) and a new §11 documents the
Makefile that drives the start/stop lifecycle.

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

## 3. The host: AWS ECS Fargate, provisioned with Terraform

**The usage pattern, not ops burden, is now the deciding constraint.** This app runs in two states:
fully stopped (between demos — the common case, could be weeks) and fully running (a live investor
demo — an hour or two). Render has no third option between "Starter, billed monthly" and "deleted" —
there is no API call that takes a Background Worker to $0 and back in seconds. Fargate does:
`desired_count` is a live parameter, billed per vCPU-second/GB-second while nonzero, $0 compute at
zero. That property, not Dockerfile-nativeness, decides the platform here.

**Terraform, not console clicks, because the state is toggled constantly.** A resource that gets
started and stopped for every demo needs a scriptable, idempotent toggle — `aws ecs update-service
--desired-count` — sitting on top of infrastructure that's declared once and never hand-edited. The
Makefile (§11) is that toggle; Terraform is what it toggles.

**No ALB, no NAT Gateway — both are the AWS version of Render's Starter tax: a fixed hourly charge
that runs whether or not the app is up.** An Application Load Balancer bills roughly $16/month from
the moment it's provisioned, not from the moment it's used, and so does a NAT Gateway (roughly
$32/month plus per-GB data processing). Both are common defaults in an ECS tutorial and both defeat
the entire point of this design if left in. They're avoided by:

- **Public subnets, public IPs directly on the Fargate tasks.** The default VPC's subnets are
  already public (default route to an Internet Gateway, which is free). A task with
  `assign_public_ip = true` reaches Supabase, Render Redis, and Anthropic outbound with no NAT
  Gateway in between.
- **No load balancer.** For two tasks that exist for a demo, a security group scoped to the demo
  window is the access control, not an ALB's listener rules. `apps/api`'s task gets a public IP each
  time it starts; `make ip` (§11) fetches it.

**`apps/worker` gets no ingress, and the platform enforces it — same property Render would have
given it, for a different reason.** An ECS service with no load balancer target group attached has
no inbound path by construction. `CLAUDE.md`'s rule that `app_service` (the BYPASSRLS credential)
never sits behind HTTP stops being a convention and becomes a property of the deployment either way.

**Decision.**

| Service       | AWS resource        | Idle cost | Running cost                                                 |
| ------------- | ------------------- | --------- | ------------------------------------------------------------ |
| `apps/api`    | ECS Fargate service | $0        | ~0.25 vCPU / 0.5 GB ≈ $0.01-0.015/hr while `desired_count=1` |
| `apps/worker` | ECS Fargate service | $0        | ~0.25 vCPU / 0.5 GB ≈ $0.01-0.015/hr while `desired_count=1` |

Both start at `desired_count = 0`. Fixed monthly floor, independent of demo frequency: ECR image
storage (roughly $0.10/GB-month, well under $1 for two small images) and CloudWatch log retention (7
days, capped — see Terraform `ecs.tf`). No ALB, no NAT, no EC2 — the cluster itself is a Fargate
cluster, which has no per-cluster charge.

**What this gives up versus Render:** a stable public URL. Render's Web Service keeps the same
hostname across restarts; a Fargate task's public IP is new every time it starts (§11's `make ip`
prints the current one). This matters for `API_PUBLIC_URL` and the Google OAuth redirect URI (§6) —
if the demo needs the connected-accounts flow, either accept re-registering the redirect URI per
demo, or add a Route 53 hosted zone (roughly $0.50/mo fixed) and have `make start` point a record at
the fresh IP. Not built here; flagged as an open item (§10).

## 4. Redis: Render Key Value, free tier

**Changed from the original Upstash-on-a-Fixed-plan decision, by explicit choice, for the demo-only
pattern.** The two concerns that ruled out Render's free Key Value in the original version of this
doc were about an **always-on** production system: (1) BullMQ's `BZPOPMIN` reconnect (~5s) and
stalled-job checker (~30s) poll continuously, which is expensive on Upstash's pay-per-request pricing
but irrelevant to a _free_, non-request-billed instance; (2) data loss on restart, which is a real
defect for a system that's supposed to always have jobs in flight, but close to moot for a system
that is, by design, **only ever running during a demo the operator is watching**. A Redis restart
mid-demo would be immediately visible and simply means retrying the demo clip — not a silently
dropped production job discovered days later.

**What does NOT change: `noeviction` is still the requirement, and it still must be verified, not
assumed.** BullMQ's production guide is unambiguous that it "cannot work properly if Redis evicts
keys arbitrarily." Render's free Key Value plan is documented as in-memory-only (no persistence) —
that trade is accepted above — but eviction policy is a separate axis from persistence, and Render's
docs do not state what a free instance's `maxmemory-policy` is. **Check it directly
(`redis-cli -u $REDIS_URL CONFIG GET maxmemory-policy`) before the first real demo, not after a job
silently vanishes.** If it isn't (or can't be set to) `noeviction`, the fallback is unchanged from
the original decision: a self-managed Redis container (mirrors `infra/docker/docker-compose.yml`,
which already runs `noeviction` + AOF) as a third Fargate service, or Upstash Fixed. `make
redis-check` (§11) runs this check on demand.

**`apps/ml` is a third consumer of this URL, same as before.** The Space runs `worker.py` against the
same queue via the Python `bullmq` package — rotating `REDIS_URL` means updating a Space secret too
(`python manage_space.py secrets`). Three places to update on any Redis change, not two.

## 5. The two images

Both are built from the repo root and run on `oven/bun`, pinned to the version in the root
`package.json` `packageManager` field (`bun@1.3.14`) so the image cannot drift from the lockfile.
They differ only in entrypoint and in whether a port is exposed. Built images push to two private
ECR repositories (`resonance-api`, `resonance-worker`, provisioned in `ecr.tf`); ECS pulls from
there, not from Docker Hub.

**Build context is the repo root, not the app directory.** These are Bun workspaces: `apps/api` on
its own is not buildable. The build needs the root `package.json`, `bun.lock`, and the workspace
packages each app depends on (`@repo/db`, `@repo/queue`). Both Dockerfiles live at
`infra/deploy/<service>/Dockerfile` but are built with the repo root as context
(`docker build -f infra/deploy/api/Dockerfile .`) — `make build-api` / `make build-worker` do this.

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
locally, against real Redis and Supabase credentials, and shown to start before it is pushed to
ECR.** If the multi-stage copy proves fragile, a single-stage image is the accepted fallback:
correctness first, size later.

Both images run as a non-root user.

## 6. Configuration

Nothing is baked into an image. Non-sensitive values are plain container-definition environment
variables; sensitive values (every credential below) are AWS SSM Parameter Store `SecureString`
parameters, referenced by ARN from the task definition's `secrets` block — never plaintext in
Terraform state or the image (see `ssm.tf`).

**`apps/api`** — `PORT`, `API_PUBLIC_URL` (the task's current public IP, or a Route 53 record if
configured — see §3's "what this gives up"; also the OAuth callback origin, so it must match what is
registered with Google), `REDIS_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`APP_USER_DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_STATE_SECRET`,
`TOKEN_ENCRYPTION_KEY`.

**`apps/worker`** — `REDIS_URL`, `APP_SERVICE_DATABASE_URL`, `ANTHROPIC_API_KEY`.

Two properties of that split are worth stating because they are the point of the two-process design:
the API's database URL is the RLS-enforced `app_user` role, the worker's is `app_service`, and
**neither service holds the other's credential**. And `ANTHROPIC_API_KEY` is absent from the API
entirely — insight generation happens only in the worker.

`API_PUBLIC_URL` changes on **every** `make start`, not just on a domain migration — this is the
direct consequence of skipping an ALB (§3). If the connected-accounts / Google OAuth flow is part of
a given demo, either update the registered redirect URI right before that demo (`make ip` prints the
new value) or invest in the Route 53 option from §3 so it stays constant.

**TLS to Postgres.** Both database URLs carry `sslmode=no-verify` today, because Supabase signs
Postgres certs with its own CA (`packages/db/README.md` §TLS). That needs no file in the image. If it
is ever hardened to `verify-full`, `certs/prod-ca-2021.crt` must be baked in or mounted — a change
to the image, not just to config.

## 7. Health and lifecycle

`apps/api` exposes `GET /health`; the ECS task definition's container `healthCheck` drives ECS's own
health state, which is what `make status` reads. It shells out to `bun`'s own `fetch` rather than
`curl` — the runtime image is `oven/bun:slim`, which has neither `curl` nor `wget`, and adding one
just for this would be an extra package for a check the runtime can already do itself. A health check
that only proves the process is up is worth less than one that proves its dependencies resolve, but
widening it is out of scope here — noted so the next person knows the current check is shallow.

`apps/worker` needs no health check and gets none. Its liveness signal is the queue: a growing
`analysis-results` waiting count means the worker is not consuming. The ECS service scheduler
restarts a task that exits (as long as `desired_count` stays at 1); BullMQ redelivers the job it was
holding.

Stops rely on the existing SIGTERM drain (§2). ECS sends SIGTERM, waits the task definition's
`stopTimeout`, then SIGKILLs — set that above the slowest handler's worst case (`ecs.tf`). A worker
killed mid-write leaves an analysis marked in-flight with no result row, and the retry is what
repairs it, but only if the grace period was long enough to reach a consistent stopping point at
all.

## 8. Verification — what "done" means

In order, each gating the next:

1. Both images build from a clean clone and **start locally** against real Redis + Supabase
   credentials (`make build-api build-worker`, then `docker run`). This catches the symlink hazard
   in §5.
2. `terraform apply` provisions cleanly against an empty AWS account; `make start` then `make ip`
   then `curl $(make ip)/health` answers on the deployed API.
3. The provisioned Render Key Value instance is confirmed `noeviction` (§4, `make redis-check`).
4. An analysis enqueued against the deployed Redis is consumed by the Space's `worker.py` and
   persisted by the deployed `apps/worker` — the first time the full path runs with nothing on a
   laptop.
5. `make stop` mid-analysis (an `aws ecs update-service --desired-count 0` while a job is in flight)
   does not lose it — the SIGTERM drain (§7) plus BullMQ's redelivery-on-restart is what's being
   proven, since "stop" here is a deliberate, not incidental, interruption.

Item 4 is the same run that would settle three open questions already tracked in `CLAUDE.md`: the
atlas sanity check, the real per-analysis Anthropic cost, and the `TR_SEC` manifest.

## 9. Deliberately out of scope

- **`apps/ml`.** It deploys and works. Consolidating GPU hosting is a separate decision with its own
  spec, and re-solving a working deployment is not warranted here.
- **CD.** Deploys are manual (`make deploy-api` / `make deploy-worker` — build, push to ECR, force a
  new ECS deployment) until the images are proven. Automating an unverified deploy path automates a
  failure.
- **`apps/web`.** Not scaffolded.
- **Autoscaling, multi-region, zero-downtime.** No users yet.
- **Image size optimization.** Correctness first; revisit if build times or cold starts hurt.

## 10. Open items to settle during implementation

1. **`noeviction` on Render Key Value** — the one item that can invalidate §4. Settle it first, via
   `make redis-check`.
2. Whether the multi-stage Docker copy preserves Bun's workspace symlinks, or the single-stage
   fallback is needed (§5).
3. ECS task `stopTimeout` versus the slowest worker handler's actual worst case (§7) — pick a number
   from real handler timing, not a guess.
4. Whether a Fargate cold start (image pull + container init, typically well under a minute for
   images this size) is tolerable inside a live demo, or whether the demo flow should be "run `make
start` a few minutes before investors arrive" rather than truly on-demand per clip.
5. Whether the floating public IP (§3) is acceptable for the demo's scope, or the Route 53 addition
   is worth building before the first demo that needs the Google OAuth connect flow.

## 11. Lifecycle: the root `Makefile`

The demo-only usage pattern (§3) is the whole reason this design exists, so the thing that toggles it
is a first-class deliverable, not an afterthought. One Makefile at the repo root, covering every
process with a start/stop story — `apps/api` + `apps/worker` on ECS, `apps/ml` on the HF Space
(already scriptable via `apps/ml/manage_space.py pause` / `restart` / `status` — reused, not
reimplemented), and a read-only check against Render Redis, which has no start/stop of its own to
drive (§4).

| Target                     | Does                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `make tf-init`             | `terraform init` in `infra/deploy/terraform/`                                            |
| `make tf-plan`             | `terraform plan`                                                                         |
| `make tf-apply`            | `terraform apply` — provisions the cluster/ECR/IAM/SG once; not part of the demo toggle  |
| `make build-api`           | `docker build` the API image from the repo root (§5)                                     |
| `make build-worker`        | `docker build` the worker image from the repo root                                       |
| `make push-api`            | ECR login + push the API image                                                           |
| `make push-worker`         | ECR login + push the worker image                                                        |
| `make deploy-api`          | `build-api` + `push-api` + `aws ecs update-service --force-new-deployment` for the API   |
| `make deploy-worker`       | Same, for the worker                                                                     |
| `make start`               | `aws ecs update-service --desired-count 1` for **both** services                         |
| `make stop` / `make pause` | `aws ecs update-service --desired-count 0` for **both** services (aliases — same effect) |
| `make restart`             | `stop` then `start` (a clean redeploy path when no new image is involved)                |
| `make status`              | `aws ecs describe-services` for both, plus `manage_space.py status` for `apps/ml`        |
| `make ip`                  | Resolves the API task's ENI and prints its current public IP (§3, §6)                    |
| `make logs-api`            | Tails the API's CloudWatch log group                                                     |
| `make logs-worker`         | Tails the worker's CloudWatch log group                                                  |
| `make redis-check`         | `redis-cli -u $REDIS_URL CONFIG GET maxmemory-policy` against the Render instance (§4)   |
| `make ml-pause`            | `apps/ml && python manage_space.py pause` — stops the Space's GPU meter                  |
| `make ml-restart`          | `apps/ml && python manage_space.py restart`                                              |

`start` / `stop` deliberately do **not** touch Terraform — provisioning is a one-time (or
rarely-changed) step, and a demo-day toggle that ran `terraform apply` every time would mean every
demo start is a chance to apply an unrelated pending infra change. `make start` and `make stop`
are pure `aws ecs update-service` calls; `tf-apply` stays a separate, deliberate step.

`start` intentionally does not also unpause `apps/ml` — the Space has its own GPU billing clock
(hourly, not per-second) and is already controlled separately via `manage_space.py`, which predates
this design. A full demo-day runbook is `make ml-restart start`, then `make ml-pause stop` when
done; documented in `infra/deploy/README.md`, not duplicated into every target's own doc comment.
