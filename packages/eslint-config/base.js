import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Paths no config should ever lint — build output, caches, and generated code.
 * Exported so a consumer can extend rather than restate them.
 */
export const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.expo/**',
  '**/.turbo/**',
  '**/src/generated/**',
  '**/*.tsbuildinfo',
];

/**
 * Type-aware parser settings.
 *
 * `projectService` resolves each file to the nearest `tsconfig.json` walking up
 * from the file itself, anchored at `tsconfigRootDir`. That defaults to
 * `process.cwd()`, which is the consuming workspace's own directory because
 * Turbo runs each package's `lint` script from that package's root. Running
 * `eslint` from the repo root instead would misresolve — always go through
 * `turbo run lint` or a package script.
 *
 * `allowDefaultProject` covers flat-config files themselves, which no
 * `tsconfig.json` includes and which would otherwise error out of the service.
 */
export const typeAware = {
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ['eslint.config.js'],
      },
    },
  },
};

/**
 * Repo conventions. Exported because a variant that composes a third-party
 * config after the base (see `react-native.js`) must re-apply these — flat
 * config is last-write-wins, and `eslint-config-expo` sets its own options for
 * some of the same rules.
 */
export const repoRules = {
  rules: {
    // `verbatimModuleSyntax` (packages/tsconfig/base.json) emits a
    // value-import even when every binding is a type. Across the AppType
    // d.ts boundary that is how Bun/Node globals leak into the Expo and web
    // typecheck, so the compiler flag's assumption is enforced here.
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

    // Deliberately-unused bindings are a real pattern (destructuring to omit
    // a key, unused catch params); an underscore makes the intent explicit.
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      },
    ],
  },
};

/**
 * Plain JS in this repo is config, not application code. Type-aware rules have
 * nothing useful to say about it and the service has no project for it.
 */
export const jsOverrides = {
  files: ['**/*.{js,cjs,mjs}'],
  extends: [tseslint.configs.disableTypeChecked],
};

export default tseslint.config(
  { ignores },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  typeAware,
  repoRules,
  jsOverrides,
  // Must stay last: switches off every stylistic rule that would fight
  // `bun run format`. Formatting is prettier's job, not the linter's.
  prettier,
);
