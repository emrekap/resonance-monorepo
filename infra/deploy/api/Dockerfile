# apps/api — Bun + Hono BFF. Built from the REPO ROOT, not this directory:
#
#   docker build -f infra/deploy/api/Dockerfile -t resonance-api .
#
# (`make build-api` does exactly this.) These are Bun workspaces: apps/api alone
# is not buildable, it needs the root package.json/bun.lock and its workspace
# deps (@repo/db, @repo/queue). See docs/superpowers/specs/2026-08-09-deploy-api-worker-design.md
# §5 for the full design rationale.

# ---- pruner ------------------------------------------------------------------
# `turbo prune --docker` walks the workspace graph from @repo/api and writes
# two trees: json/ (package.json skeletons only, for a cacheable install
# layer) and full/ (real source of just the packages actually needed), plus a
# lockfile scoped to that subset. This is the documented Turborepo pattern for
# monorepo Docker builds, and it sidesteps the Bun workspace-symlink hazard by
# construction — there's nothing dangling because nothing unneeded was ever
# copied in.
FROM oven/bun:1.3.14-slim AS pruner
WORKDIR /repo
COPY . .
RUN bunx turbo@2.10.8 prune @repo/api --docker --out-dir=/out

# ---- installer ----------------------------------------------------------------
# Deps first, from json/ only — this layer's cache only busts when a
# dependency actually changes, not on every source edit.
FROM oven/bun:1.3.14-slim AS installer
WORKDIR /repo
COPY --from=pruner /out/json/ .
COPY --from=pruner /out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile

# Real source on top of the installed deps.
COPY --from=pruner /out/full/ .

# packages/db's build script is `prisma generate`, and packages/db/prisma.config.ts
# resolves DIRECT_DATABASE_URL or throws — even though generating a client never
# opens a connection. This is never a real host; .github/workflows/test.yml
# solves the same CI problem the same way.
ARG DIRECT_DATABASE_URL=postgresql://build:build@build.invalid:5432/build
ENV DIRECT_DATABASE_URL=${DIRECT_DATABASE_URL}
RUN bun run --cwd packages/db build

# No `tsc -p tsconfig.build.json` here: apps/api's `build` script exists only so
# the mobile/web typechecks see a compiled dist/app.d.ts boundary. Bun runs
# TypeScript directly, so the image never needs dist/.

# ---- runtime -------------------------------------------------------------------
FROM oven/bun:1.3.14-slim AS runtime
RUN groupadd --system --gid 1001 resonance \
    && useradd --system --uid 1001 --gid resonance resonance
WORKDIR /repo
COPY --from=installer --chown=resonance:resonance /repo .
USER resonance
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
