import type { UserConfig } from '@commitlint/types';

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'root',
        'api',
        'web',
        'workers',
        'contracts',
        'database',
        'pricing-engine',
        'api-client',
        'ui',
        'eslint-config',
        'typescript-config',
        'testing',
        'printer-sdk',
        'infra',
        'ci',
        'docs',
        'deps',
      ],
    ],
  },
} satisfies UserConfig;
