---
name: add-package
description: Scaffold a new workspace package or app in the Resonance monorepo (an @repo/* package under packages/, or an app under apps/). Use when creating a new shared library, service, or client so it wires into Bun workspaces, Turbo, and @repo/tsconfig correctly.
---

# Add a workspace package or app

## 0. Check what already exists (codebase index)

The repo is indexed in **codebase-memory-mcp** as project
`Users-emre-Desktop-files-resonance-monorepo`. Survey the workspace graph before adding to it:

```
get_architecture(project, aspects: ["packages", "dependencies", "entry_points"])
search_graph(project, query: "<the thing you're about to build>")
```

This catches the two common mistakes early: scaffolding a package whose job an existing `@repo/*`
already does, and adding a dependency edge that points the wrong way across the api/ml boundary.

## Where it goes

- Shared library / contract → `packages/<name>/`
- App (client or service) → `apps/<name>/`

## 1. `package.json`

- Name `@repo/<name>`, `"private": true`, `"type": "module"`.
- Library others import → add `"exports": { ".": "./src/index.ts" }`.
- Add `"typecheck": "tsc --noEmit"` (Turbo runs it).
- Depend on `@repo/tsconfig` (devDep) and any `@repo/*` you consume (version `"*"`).

```json
{
  "name": "@repo/example",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "devDependencies": { "@repo/tsconfig": "*", "typescript": "^5.6.0" }
}
```

## 2. `tsconfig.json` — extend the right base

- Shared TS lib → `@repo/tsconfig/base.json`
- Bun/Hono service → `@repo/tsconfig/bun.json` (also add `@types/bun` devDep)
- Next app → `@repo/tsconfig/nextjs.json`
- Expo app → `["@repo/tsconfig/react-native.json", "expo/tsconfig.base"]` (expo **last**)

```json
{ "extends": "@repo/tsconfig/base.json", "include": ["src/**/*.ts"] }
```

## 3. Link it

```bash
bun install   # from repo root — symlinks @repo/<name> and links it into dependents
```

## 4. Verify

```bash
bunx turbo run typecheck   # confirms the package joins the graph cleanly
```

Re-index so the new package shows up in the code graph:

```
index_repository(repo_path: "/Users/emre/Desktop/files/resonance-monorepo")
```

A Python app is indexed too — the graph spans both runtimes even though Bun/Turbo ignore `apps/ml`.

## Rules / conventions

- Everything is scoped `@repo/*` and `private`.
- If the package exposes types a **different-runtime** consumer imports (like the API's `AppType` →
  mobile/web), emit a **`.d.ts` boundary** (see `apps/api/tsconfig.build.json`) so runtime globals
  don't leak across libs.
- **Prisma is the single schema owner** — a new package must not define a second ORM over the app DB.
- A **Python** app (like `apps/ml`) is intentionally **NOT** a workspace member (no `package.json`) —
  keep it a polyglot island with its own `uv`/`pyproject` tooling.
