import { typeChecked } from './type-checked.js';

/**
 * The type-checked profile plus the one relaxation NestJS structurally
 * requires, and nothing else. In particular `consistent-type-imports` stays
 * ON: typescript-eslint suppresses it for a class-typed constructor
 * parameter only when the RESOLVED program has both `experimentalDecorators`
 * and `emitDecoratorMetadata` enabled and the file contains a decorator —
 * verified against this exact toolchain in this package's test suite
 * (`test/rules.test.ts`, "nest profile"). That means the precondition is on
 * the caller: `options.project` (or the `tsconfigRootDir`'s default
 * tsconfig) must resolve to a config that extends
 * `@metrika/typescript-config/nest.json`, or otherwise sets both flags
 * itself. Compose `nest()` over a tsconfig that doesn't, and `pnpm lint:fix`
 * silently rewrites an injected dependency's value import into
 * `import type`, which erases `design:paramtypes` and breaks DI at Nest
 * bootstrap — with no compiler or lint diagnostic warning about it either
 * way, going in or coming back out (an existing `import type` on an injected
 * class is never flagged as wrong either). The only backstop for that
 * failure mode is an integration test that boots the module tree; no app in
 * this repo exists yet to have one, so that is a requirement for whichever
 * app adopts this profile first, not a control this repo currently has.
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
