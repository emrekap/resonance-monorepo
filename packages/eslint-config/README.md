# `@repo/eslint-config`

Shared ESLint 9 **flat configs** for the monorepo, mirroring `@repo/tsconfig`: one base plus a
variant per runtime.

| Import                             | For                                      |
| ---------------------------------- | ---------------------------------------- |
| `@repo/eslint-config`              | shared TS libraries — `packages/*`       |
| `@repo/eslint-config/bun`          | Bun services — `apps/api`, `apps/worker` |
| `@repo/eslint-config/react-native` | Expo — `apps/mobile`                     |

No `nextjs` variant yet. `@repo/tsconfig` ships one because it costs ten lines of JSON and no
dependency; an ESLint equivalent pulls in `eslint-config-next` and its plugin tree, and there is no
`apps/web` to verify it against. It lands when that app does.

## Using it

```jsonc
// package.json
{
  "scripts": { "lint": "eslint ." },
  "devDependencies": { "@repo/eslint-config": "*", "eslint": "^9.39.5" },
}
```

```js
// eslint.config.js
import config from '@repo/eslint-config/bun';

export default config;
```

To add package-local rules, spread and append — later entries win:

```js
import config from '@repo/eslint-config/react-native';

export default [...config, { rules: { 'no-restricted-syntax': ['error' /* … */] } }];
```

## Linting is type-aware

The base uses `tseslint.configs.recommendedTypeChecked` with `projectService`, which buys the rules
that need type information — `no-floating-promises`, `no-misused-promises`, `await-thenable`. In a
repo whose core is async Prisma calls and BullMQ producers/consumers, a floated promise is silent
data loss that syntax-only linting cannot see.

Two consequences:

- **Run it from the package root.** `projectService` anchors at `process.cwd()` and walks up from
  each file to the nearest `tsconfig.json`. Turbo runs each workspace's `lint` script from that
  workspace, so `turbo run lint` and `bun run lint` are both correct; invoking `eslint` from the
  repo root against a sub-path is not.
- **`lint` depends on `^build`.** Type-aware linting needs upstream types, and `packages/api-contract`
  and `apps/mobile` resolve `AppType` from `apps/api/dist/app.d.ts`. `turbo.json` declares this;
  a fresh clone therefore builds before it lints.

## Two rules worth knowing

- **`consistent-type-imports`.** `packages/tsconfig/base.json` sets `verbatimModuleSyntax: true`,
  which emits a value-import even when every binding is only a type. Across the `AppType` d.ts
  boundary that is exactly how Bun/Node globals leak into the Expo and web typecheck. The rule
  enforces at lint time what the compiler flag assumes.
- **`no-unused-vars` with `^_`.** Prefixing with an underscore marks a binding as deliberately
  unused — omitting a key while destructuring, an unused catch param.

Formatting is **not** the linter's job: `eslint-config-prettier` is applied last in every variant to
switch off stylistic rules that would fight `bun run format`.

## Two version ceilings

Both are lower than the npm `latest` tag, so a routine "upgrade everything" will break linting.

**ESLint stays on 9.** ESLint 10 removed `context.getFilename()`, and `eslint-plugin-react@7.37.5`
— the newest release, peer range topping out at `^9.7` — still calls it. `eslint-config-expo`
depends on that plugin, so `apps/mobile` crashes outright on ESLint 10 with
`contextOrFilename.getFilename is not a function`. This is not fixable from config; it needs an
`eslint-plugin-react` release that supports v10.

**TypeScript stays at or below 6.0.** `typescript-eslint@8` peer-requires
`typescript >=4.8.4 <6.1.0`. The repo runs `^5.6.0` everywhere except `apps/mobile` (`~6.0.3`), so
both are covered today — but TypeScript 7 is already `latest`. Upgrade TypeScript and
typescript-eslint together.
