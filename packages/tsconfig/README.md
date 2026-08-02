# @repo/tsconfig

Shared TypeScript configs for the monorepo. One strict **`base.json`** that every package extends,
plus an environment config for each runtime. All configs are **type-check only** (`noEmit: true`) —
Bun, Next (SWC), and Expo (Metro) each do their own transpiling; `tsc` is used purely for checking.

## Files

| Config | Extend it from | For |
| --- | --- | --- |
| `base.json` | shared libs/packages (e.g. `@repo/db`, `@repo/api-contract`) | strict defaults, bundler resolution |
| `bun.json` | `apps/api` (Hono on Bun) | `types: ["bun"]`, `.ts` imports |
| `nextjs.json` | `apps/web` | DOM libs, `jsx: preserve`, the `next` plugin |
| `react-native.json` | `apps/mobile` (Expo) | `jsx: react-jsx`, RN libs |

## Usage

**Bun / Hono API** — `apps/api/tsconfig.json`:

```json
{
  "extends": "@repo/tsconfig/bun.json",
  "include": ["src/**/*.ts"]
}
```

(Also add `@types/bun` as a devDependency in `apps/api` — that's what `types: ["bun"]` resolves to.)

**Next.js** — `apps/web/tsconfig.json`:

```json
{
  "extends": "@repo/tsconfig/nextjs.json",
  "compilerOptions": { "paths": { "@/*": ["./*"] } },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

**Expo / React Native** — `apps/mobile/tsconfig.json`. Use **array-extends** with Expo's base **last**,
so Expo's RN-tuned options (lib/jsx/module resolution) win, while our extra strictness (which Expo
doesn't set) still applies:

```json
{
  "extends": ["@repo/tsconfig/react-native.json", "expo/tsconfig.base"],
  "compilerOptions": { "paths": { "@/*": ["./*"] } },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

## Notes on the strict defaults

- **`verbatimModuleSyntax`** — forces explicit `import type`. Good hygiene, and it keeps the Hono
  `AppType` sharing in `@repo/api-contract` type-only. Relax per-package if a CJS dep fights it.
- **`noUncheckedIndexedAccess`** — array/record access is `T | undefined`. Strict but catches real bugs.
- **`types: []`** in base — no ambient `@types/*` leak across packages; each package opts in to the
  ambient types it needs (e.g. `bun`).