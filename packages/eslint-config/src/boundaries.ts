import tseslint from 'typescript-eslint';

/**
 * Boundary enforcement across the monorepo. Loaded per-package via `files` glob
 * in the consuming eslint.config.
 */
export const boundaries = tseslint.config(
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@metrika/*', '!@metrika/contracts'],
              message: 'contracts is the root of the dependency graph — import nothing but zod',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/pricing-engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', '@prisma/*', 'node:*'],
              message: 'pricing-engine must stay pure — no framework, no I/O',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@metrika/database', '@metrika/pricing-engine'],
              message: 'no Prisma in the browser; prices are computed server-side only',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/infrastructure/persistence/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client'],
              message: 'Prisma access goes through infrastructure/persistence',
            },
          ],
        },
      ],
    },
  },
);
