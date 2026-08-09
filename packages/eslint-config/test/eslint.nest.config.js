import { nest } from '../src/index.js';

export default [
  ...nest({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  { ignores: ['../src/**'] },
];
