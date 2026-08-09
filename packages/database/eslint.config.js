import { rawSqlBan, typeChecked } from '@metrika/eslint-config';

export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  // Only the raw-SQL half of the Prisma boundary applies here: this package IS
  // the persistence layer, so prismaImportBoundary would forbid it from doing
  // its job. $queryRawUnsafe / $executeRawUnsafe stay banned, here most of all.
  // Imported BY NAME, never as `prismaBoundary.slice(1)` — an index couples
  // this file to the declaration order of two objects in another package.
  ...rawSqlBan,
  { ignores: ['dist/**', 'coverage/**'] },
];
