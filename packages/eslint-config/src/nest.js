import { typeChecked } from './type-checked.js';

/**
 * The type-checked profile plus the one relaxation NestJS structurally
 * requires, and nothing else. In particular `consistent-type-imports` stays
 * ON: it was verified against this exact toolchain to self-suppress for
 * class-typed imports in any file containing a decorator, so `lint:fix` will
 * not introduce the `import type` DI break. It also never flags an EXISTING
 * `import type` on an injected class as wrong — no compiler and no lint rule
 * does. The only net for that defect is an integration test that boots the
 * module tree, which every Nest app in this repo has.
 *
 * @param {{ tsconfigRootDir: string, project?: string | string[] }} options
 * @returns {import('eslint').Linter.Config[]}
 */
export function nest(options) {
  return [
    ...typeChecked(options),
    {
      // A NestJS module is a class whose entire purpose is to carry decorator
      // metadata. `no-extraneous-class` (from strictTypeChecked) fires on every
      // one of them. Scoped to *.module.ts so a genuinely pointless class
      // anywhere else is still an error.
      files: ['**/*.module.ts'],
      rules: { '@typescript-eslint/no-extraneous-class': 'off' },
    },
  ];
}
