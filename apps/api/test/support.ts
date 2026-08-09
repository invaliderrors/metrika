import { startDatabase, type DatabaseHandle } from '@metrika/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApiApp } from '../src/bootstrap.js';
import { DATABASE_PACKAGE_ROOT } from './database-root.js';

export { stopDatabase } from '@metrika/testing';

export const TEST_HEALTH_DEEP_TOKEN = 'integration-health-deep-token';

export async function startTestDatabase(): Promise<DatabaseHandle> {
  return startDatabase({ databasePackageRoot: DATABASE_PACKAGE_ROOT });
}

export interface BootedApi {
  readonly app: NestFastifyApplication;
  readonly baseUrl: string;
}

/**
 * Boots the REAL bootstrap against the shared test database and listens on an
 * ephemeral port. Every API integration suite uses this; a suite that builds
 * its own module graph cannot catch a wiring mistake in the real one, and
 * wiring mistakes are the defect class this app is most exposed to.
 */
export async function bootApiForTest(): Promise<BootedApi> {
  const handle = await startTestDatabase();
  // Bracket notation, not dot: `process.env` is an index signature and the
  // shared tsconfig sets `noPropertyAccessFromIndexSignature`, so `tsc`
  // rejects `process.env.DATABASE_URL` with TS4111.
  process.env['DATABASE_URL'] = handle.applicationUrl;
  process.env['HEALTH_DEEP_TOKEN'] = TEST_HEALTH_DEEP_TOKEN;
  process.env['NODE_ENV'] = 'test';

  const app = await createApiApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, baseUrl: await app.getUrl() };
}
