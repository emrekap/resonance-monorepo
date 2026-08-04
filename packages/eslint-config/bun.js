import globals from 'globals';
import tseslint from 'typescript-eslint';

import base from './base.js';

/**
 * Bun services — `apps/api`, `apps/worker`, and the Node-shaped `packages/*`.
 *
 * typescript-eslint disables `no-undef` for TS files (the compiler already
 * covers it), so these globals matter only for plain JS. `Bun` is declared
 * explicitly because the `globals` package tracks runtimes, not Bun's API.
 */
export default tseslint.config(...base, {
  languageOptions: {
    globals: {
      ...globals.node,
      Bun: 'readonly',
    },
  },
});
