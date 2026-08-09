import path from 'node:path';
import {
  startDatabase,
  withDatabase as withHarnessDatabase,
  type DatabaseHandle,
} from '@metrika/testing';
import { createPrismaClient, type MetrikaPrismaClient } from '../src/index.js';

/**
 * This package's own root, which is where `sql/00-app-role.sql` and
 * `prisma/` live. @metrika/testing takes it as an option instead of resolving
 * `@metrika/database` itself, because a dependency in that direction would
 * make Turbo's build graph cyclic.
 */
const databasePackageRoot = path.resolve(import.meta.dirname, '..');

export async function startTestDatabase(): Promise<DatabaseHandle> {
  return startDatabase({ databasePackageRoot });
}

/**
 * The signature docs/TESTING.md §3 declares. The client connects as
 * metrika_app, so anything the callback does is subject to row-level security
 * exactly as production is.
 */
export async function withDatabase<T>(fn: (db: MetrikaPrismaClient) => Promise<T>): Promise<T> {
  return withHarnessDatabase(
    { databasePackageRoot, createClient: (databaseUrl) => createPrismaClient({ databaseUrl }) },
    fn,
  );
}

export { stopDatabase } from '@metrika/testing';
