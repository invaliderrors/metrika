import { next, typeChecked } from '../src/index.js';

/**
 * The WRONG order, kept as a fixture on purpose. Nothing in the repository
 * composes the profiles this way; this exists so the hazard is measured rather
 * than asserted in a comment — the last thing a comment claimed about this
 * composition turned out to be false.
 *
 * @type {import('eslint').Linter.Config[]}
 */
const config = [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  ...next({ reactVersion: '19.2.8' }),
];

export default config;
