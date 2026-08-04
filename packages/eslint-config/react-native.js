// The `.js` is load-bearing: the package ships both a `flat.js` file and a
// `flat/` directory, and Node's ESM resolver picks the directory, which is not
// a supported import. `eslint-config-expo` has no `exports` map to disambiguate.
import expoConfig from 'eslint-config-expo/flat.js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

import base, { jsOverrides, repoRules, typeAware } from './base.js';

/**
 * Expo / React Native — `apps/mobile`.
 *
 * `eslint-config-expo/flat` brings react, react-hooks, import and RN rules, but
 * it also ships its own `parserOptions` (without `projectService`) and its own
 * options for shared rules like `no-unused-vars`. Flat config is
 * last-write-wins, so ordering is load-bearing: Expo's config goes after the
 * base, then the parser settings, the repo's own rules, and
 * `eslint-config-prettier` are re-applied so repo conventions win.
 */
export default tseslint.config(
  ...base,
  ...expoConfig,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: typeAware.languageOptions,
  },
  repoRules,
  jsOverrides,
  prettier,
);
