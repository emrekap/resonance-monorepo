# apps/worker — Bun, holds the app_service (BYPASSRLS) Postgres credential.
# Built from the REPO ROOT, not this directory:
#
#   docker build -f infra/deploy/worker/Dockerfile -t resonance-worker .
#
# (`make build-worker` does exactly this.) Mirrors infra/deploy/api/Dockerfile
# stage-for-stage — see its comments for the rationale behind each stage. The
# only differences: the pruned scope (@repo/worker) and no EXPOSE, since this
# process has no HTTP surface by construction (CLAUDE.md: apps/api never holds
# BYPASSRLS, so this credential never sits behind a listening port).

# ---- pruner ------------------------------------------------------------------
FROM oven/bun:1.3.14-slim AS pruner
WORKDIR /repo
COPY . .
RUN bunx turbo@2.10.8 prune @repo/worker --docker --out-dir=/out

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
CMD ["bun", "run", "apps/worker/src/index.ts"]
