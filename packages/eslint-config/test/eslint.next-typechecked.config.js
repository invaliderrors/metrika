import { next, typeChecked } from '../src/index.js';

/**
 * The sanctioned composition order for a Next app: `next()` first,
 * `typeChecked()` after. See src/next.js's header for the measurement and
 * test/react.test.ts for the assertion that pins the resolved severity.
 *
 * @type {import('eslint').Linter.Config[]}
 */
const config = [
  ...next({ reactVersion: '19.2.8' }),
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
];

export default config;
