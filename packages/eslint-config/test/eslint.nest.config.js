import { nest } from '../src/index.js';

export default [...nest({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.nest.json' })];
