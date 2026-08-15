# apps/poller — Bun, holds the app_service (BYPASSRLS) Postgres credential and
# the YouTube Data API key. Built from the REPO ROOT, not this directory:
#
#   docker build -f infra/deploy/poller/Dockerfile -t resonance-poller .
#
# (`make build-poller` does exactly this.) Mirrors infra/deploy/worker/Dockerfile
# stage-for-stage — see infra/deploy/api/Dockerfile for the rationale behind each
# stage. The only differences: the pruned scope (@repo/poller) and the entry
# point. Like the worker it has no EXPOSE and no HTTP surface: it holds
# BYPASSRLS, which never sits behind a listening port (CLAUDE.md).
#
# NOTE ON THE SEED FRAME. `apps/poller/seeds/channels.yaml` ships INSIDE this
# image, and the poller refuses to boot while it is empty — `loadSeeds()` throws
# "the sampling frame is empty" rather than polling nothing quietly. So until
# that file is curated, a started task will crash-loop. That is the app behaving
# as designed (a poller that looks healthy and collects nothing is the failure
# worth preventing), but it does mean CURATING THE FRAME AND REBUILDING THIS
# IMAGE ARE THE SAME STEP: a new frame is a new image, not a config change.

# ---- pruner ------------------------------------------------------------------
# Every stage on one arch (arm64 -> ARM64 Fargate), no --platform anywhere —
# see infra/deploy/api/Dockerfile's pruner comment for why keeping installer and
# runtime on the same architecture is load-bearing rather than incidental.
FROM oven/bun:1.3.14-slim AS pruner
WORKDIR /repo
COPY . .
RUN bunx turbo@2.10.8 prune @repo/poller --docker --out-dir=/out

# ---- installer ----------------------------------------------------------------
FROM oven/bun:1.3.14-slim AS installer
WORKDIR /repo
COPY --from=pruner /out/json/ .
COPY --from=pruner /out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile

COPY --from=pruner /out/full/ .

# Same placeholder trick as the api image — see its Dockerfile for why
# packages/db's build (`prisma generate`) needs this even though it never
# connects.
ARG DIRECT_DATABASE_URL=postgresql://build:build@build.invalid:5432/build
ENV DIRECT_DATABASE_URL=${DIRECT_DATABASE_URL}
RUN bun run --cwd packages/db build

# ---- runtime -------------------------------------------------------------------
FROM oven/bun:1.3.14-slim AS runtime
RUN groupadd --system --gid 1001 resonance \
    && useradd --system --uid 1001 --gid resonance resonance
WORKDIR /repo
COPY --from=installer --chown=resonance:resonance /repo .
USER resonance
ENV NODE_ENV=production
CMD ["bun", "run", "apps/poller/src/index.ts"]
