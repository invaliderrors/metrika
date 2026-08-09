import {
  startDatabase,
  stopDatabase as stopHarnessDatabase,
  type DatabaseHandle,
} from '@metrika/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApiApp } from '../src/bootstrap.js';
import { DATABASE_PACKAGE_ROOT } from './database-root.js';

export const TEST_HEALTH_DEEP_TOKEN = 'integration-health-deep-token';

/** Every environment key {@link bootApiForTest} writes, and therefore restores. */
const ENV_KEYS = ['DATABASE_URL', 'HEALTH_DEEP_TOKEN', 'NODE_ENV'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

/**
 * Bracket notation, not dot: `process.env` is an index signature and the shared
 * tsconfig sets `noPropertyAccessFromIndexSignature`, so `process.env.NODE_ENV`
 * is TS4111.
 *
 * The `undefined` branch is not defensive padding. Node stores the STRING
 * "undefined" when a `process.env` key is assigned `undefined`, so restoring a
 * key that was absent has to delete it — assigning the captured value back
 * would leave `NODE_ENV="undefined"` behind, which `parseEnv` then rejects as
 * an invalid enum member.
 */
function setEnv(key: EnvKey, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

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

  // The ambient environment is restored once the app has read it, so the
  // fixture leaves no trace: without this, the lifecycle suite's probe
  // DATABASE_URL outlives its test and the next suite to read the ambient value
  // silently gets a URL that belongs to a closed app. Safe to restore this
  // early because everything that reads configuration — `loadEnv()` in the
  // ConfigModule factory, and PrismaService's constructor — has already run by
  // the time `createApiApp()` resolves. `app.listen()` reads none of it.
  const restore = new Map<EnvKey, string | undefined>(
    ENV_KEYS.map((key): [EnvKey, string | undefined] => [key, process.env[key]]),
  );

  setEnv('DATABASE_URL', overrides?.DATABASE_URL ?? handle.applicationUrl);
  setEnv('HEALTH_DEEP_TOKEN', overrides?.HEALTH_DEEP_TOKEN ?? TEST_HEALTH_DEEP_TOKEN);
  setEnv('NODE_ENV', overrides?.NODE_ENV ?? 'test');

  let app: NestFastifyApplication;
  try {
    app = await createApiApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
  } finally {
    // `finally`, so a boot that throws — a DI break, EADDRINUSE — does not
    // strand the override in the environment for every suite that follows.
    for (const [key, value] of restore) setEnv(key, value);
  }

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
 *
 * Every step runs even when an earlier one throws. This is MEASURED, not
 * defensive: with a bare `for (…) { await close(); }` and one rejecting
 * closer registered first, the app registered after it stayed reachable over
 * HTTP and `stopHarnessDatabase()` never ran at all. The leak this registry
 * exists to prevent reappeared in precisely the situation where cleanup
 * matters most. With the loop below, the same probe closed the survivor and
 * still reached the harness.
 *
 * Failures are collected and rethrown together rather than letting the first
 * one win, matching `withDatabase` in packages/testing/src/database.ts; a
 * single failure is rethrown as itself, so the common case keeps its original
 * stack.
 */
export async function stopDatabase(): Promise<void> {
  const failures: unknown[] = [];

  for (const close of [...openApps]) {
    try {
      await close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }

  try {
    await stopHarnessDatabase();
  } catch (error: unknown) {
    failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'stopDatabase: more than one cleanup step failed');
  }
}
