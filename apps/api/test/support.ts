import {
  startDatabase,
  stopDatabase as stopHarnessDatabase,
  type DatabaseHandle,
} from '@metrika/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApiApp } from '../src/bootstrap.js';
import { DATABASE_PACKAGE_ROOT } from './database-root.js';

export const TEST_HEALTH_DEEP_TOKEN = 'integration-health-deep-token';

export async function startTestDatabase(): Promise<DatabaseHandle> {
  return startDatabase({ databasePackageRoot: DATABASE_PACKAGE_ROOT });
}

/**
 * Per-boot environment overrides, applied on top of the defaults
 * {@link bootApiForTest} always writes. Narrowly typed to the three keys a
 * test has any business changing — a `Record<string, string>` here would be an
 * open door into the app's configuration from any suite.
 *
 * The defaults are re-applied on EVERY call, so an override is transient by
 * construction: the next `bootApiForTest()` puts the ambient environment back
 * whether or not the caller remembered to.
 */
export interface BootApiOverrides {
  readonly DATABASE_URL?: string;
  readonly NODE_ENV?: 'development' | 'test' | 'production';
  readonly HEALTH_DEEP_TOKEN?: string;
}

export interface BootedApi {
  readonly app: NestFastifyApplication;
  readonly baseUrl: string;
  /**
   * Releases the Prisma pool and the listening socket. Idempotent, and safe to
   * call after `app.close()` has already been called directly — suites written
   * before this existed keep working unchanged.
   */
  readonly close: () => Promise<void>;
}

/**
 * Every app this fixture has booted and that nothing has closed yet.
 *
 * `bootApiForTest` acquires two process-level resources (a Prisma connection
 * pool and a listening socket) and, before this registry existed, handed back
 * no way to release them but a convention: "remember an `afterAll`". One
 * forgotten call leaked a pool and a socket for the rest of the run against a
 * shared container, and nothing detected it — the symptom would surface in an
 * unrelated suite as connection exhaustion. `stopDatabase()` below drains this
 * set, which turns that leak from "possible if you forget" into "impossible".
 */
const openApps = new Set<() => Promise<void>>();

/**
 * Boots the REAL bootstrap against the shared test database and listens on an
 * ephemeral port. Every API integration suite uses this; a suite that builds
 * its own module graph cannot catch a wiring mistake in the real one, and
 * wiring mistakes are the defect class this app is most exposed to.
 */
export async function bootApiForTest(overrides?: BootApiOverrides): Promise<BootedApi> {
  const handle = await startTestDatabase();
  // Bracket notation, not dot: `process.env` is an index signature and the
  // shared tsconfig sets `noPropertyAccessFromIndexSignature`, so `tsc`
  // rejects `process.env.DATABASE_URL` with TS4111.
  process.env['DATABASE_URL'] = overrides?.DATABASE_URL ?? handle.applicationUrl;
  process.env['HEALTH_DEEP_TOKEN'] = overrides?.HEALTH_DEEP_TOKEN ?? TEST_HEALTH_DEEP_TOKEN;
  process.env['NODE_ENV'] = overrides?.NODE_ENV ?? 'test';

  const app = await createApiApp();
  await app.listen({ port: 0, host: '127.0.0.1' });

  // Annotated rather than inferred: the body names `close`, and inference over
  // a self-referential initialiser is circular (TS7022).
  const close: () => Promise<void> = async (): Promise<void> => {
    if (!openApps.delete(close)) return;
    await app.close();
  };
  openApps.add(close);

  return { app, baseUrl: await app.getUrl(), close };
}

/**
 * Closes anything {@link bootApiForTest} still has open, then stops the
 * container if this module registry is the one that started it.
 *
 * A wrapper around `@metrika/testing`'s `stopDatabase`, not a re-export: same
 * name, same signature, strictly more cleanup. Draining `openApps` first is
 * what makes a forgotten `app.close()` harmless — Nest's `close()` is
 * idempotent (MEASURED: a second call on an already-closed app resolves
 * without throwing), so a suite that closes its own app AND relies on this
 * backstop is not doing anything unsafe.
 */
export async function stopDatabase(): Promise<void> {
  for (const close of [...openApps]) {
    await close();
  }
  await stopHarnessDatabase();
}
