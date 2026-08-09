import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApplicationConfig } from '@nestjs/core';
import { bootApiForTest, startTestDatabase, stopDatabase } from './support.js';
import { API_PREFIX } from '../src/bootstrap.js';
import { EnvService } from '../src/config/env.service.js';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service.js';

let app: NestFastifyApplication;
let baseUrl: string;
let close: (() => Promise<void>) | undefined;

/**
 * A distinct `application_name` on the connection URL, which Postgres surfaces
 * in `pg_stat_activity`. It is how the lifecycle test below attributes backends
 * to one specific app instance while the observer connects as the same role.
 */
const LIFECYCLE_APPLICATION_NAME = 'metrika-lifecycle-probe';

/** Backends belonging to the lifecycle probe, counted over an INDEPENDENT connection. */
async function lifecycleBackendCount(observer: PrismaService): Promise<number> {
  const rows = await observer.client.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count
    FROM pg_stat_activity
    WHERE application_name = ${LIFECYCLE_APPLICATION_NAME}`;
  return Number(rows[0]?.count ?? 0n);
}

/**
 * Postgres reaps a backend asynchronously, so a bare read straight after
 * `$disconnect()` races the server. Polls to a deadline and returns whatever
 * the count settled on, so a failure reports the real number rather than a
 * timeout.
 */
async function settledBackendCount(
  observer: PrismaService,
  done: (count: number) => boolean,
  deadlineMs = 10_000,
): Promise<number> {
  const expiry = Date.now() + deadlineMs;
  let count = await lifecycleBackendCount(observer);
  while (!done(count) && Date.now() < expiry) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    count = await lifecycleBackendCount(observer);
  }
  return count;
}

beforeAll(async () => {
  ({ app, baseUrl, close } = await bootApiForTest());
});

afterAll(async () => {
  // Guarded. If `bootApiForTest()` itself throws — EADDRINUSE, port
  // exhaustion, a DI break — `close` is never assigned, and an unguarded call
  // raises a TypeError that displaces the real error in the report.
  await close?.();
  await stopDatabase();
});

describe('application boot', () => {
  it('resolves every provider in the real module tree', () => {
    // Constructing the graph is what proves DI: a provider whose constructor
    // parameter type was erased by an `import type` throws
    // UnknownDependenciesException before this line is ever reached.
    expect(app.get(EnvService)).toBeInstanceOf(EnvService);
    expect(app.get(PrismaService)).toBeInstanceOf(PrismaService);
  });

  it('gives PrismaService a working client, not just a resolved token', async () => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.client.$queryRaw<{ one: number }[]>`SELECT 1 AS one`;
    expect(rows[0]?.one).toBe(1);
  });

  it('serves GET /health/live over a real socket', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', environment: 'test' });
  });

  it('applies the global prefix and excludes exactly the probe routes', () => {
    // The POSITIVE half of the prefix contract, and the reason it cannot be
    // asserted over HTTP yet: every route this app currently serves is on the
    // exclude list, so deleting `setGlobalPrefix` entirely produces byte-identical
    // responses — MEASURED, the suite stayed green. `ApplicationConfig` is what
    // `setGlobalPrefix` actually writes, so reading it back distinguishes
    // "prefix applied, health excluded" from "no prefix exists at all".
    // Task 12a adds the first non-excluded route; assert it over HTTP then.
    const config = app.get(ApplicationConfig);
    // The literal, pinned exactly once. Every other prefix assertion in this
    // file derives its value from API_PREFIX, so they all move together when
    // the constant changes and none of them notices — MEASURED: flipping it to
    // 'api/v2' left the suite at exit 0. `api/v1` is a PUBLISHED URL contract;
    // changing it silently breaks every client, so one assertion has to hold
    // the value rather than the constant.
    expect(API_PREFIX).toBe('api/v1');
    expect(config.getGlobalPrefix()).toBe(API_PREFIX);
    expect(config.getGlobalPrefixOptions().exclude?.map((route) => route.path)).toEqual([
      'health/live',
      'health/ready',
      'health/deep',
    ]);
  });

  it('does not prefix the health routes — probes must not track the API version', async () => {
    // URL built FROM the constant, so the assertion tracks `API_PREFIX` instead
    // of restating it.
    const prefixed = await fetch(`${baseUrl}/${API_PREFIX}/health/live`);
    expect(prefixed.status).toBe(404);
  });

  it('plumbs NODE_ENV through EnvService instead of echoing a constant', async () => {
    // Vitest's own prepareVitest does `process.env.NODE_ENV ??= 'test'`, so the
    // 'test' asserted above cannot tell "the value flowed through parseEnv and
    // EnvService" from "the controller returns a literal that happens to match".
    // MEASURED: hardcoding `environment: 'test'` in the controller left the
    // suite green. 'production' is in the schema's enum and is a value Vitest
    // never sets, so this assertion can only pass if the value is really plumbed.
    const previous = process.env['NODE_ENV'];
    const booted = await bootApiForTest({ NODE_ENV: 'production' });
    try {
      const response = await fetch(`${booted.baseUrl}/health/live`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok', environment: 'production' });

      // The override reached the app but not the rest of the run: the fixture
      // restores what it overrode, so no later suite inherits a NODE_ENV it
      // never asked for. The app keeps serving 'production' because EnvService
      // captured it at construction.
      expect(process.env['NODE_ENV']).toBe(previous);
    } finally {
      await booted.close();
    }
  });

  it('connects in onModuleInit and releases the pool in onModuleDestroy', async () => {
    // Both hooks are observed from a connection this test controls independently
    // of the app under test — the already-booted `app`'s client — because
    // neither hook leaves any trace on the app it belongs to.
    const observer = app.get(PrismaService);
    const handle = await startTestDatabase();
    const probeUrl = new URL(handle.applicationUrl);
    probeUrl.searchParams.set('application_name', LIFECYCLE_APPLICATION_NAME);

    expect(await lifecycleBackendCount(observer)).toBe(0);

    const ambientDatabaseUrl = process.env['DATABASE_URL'];
    const subject = await bootApiForTest({ DATABASE_URL: probeUrl.toString() });
    try {
      // The probe URL does not outlive its boot. Left in the ambient
      // environment it would point every later suite that reads DATABASE_URL
      // at a connection belonging to an app this test is about to close.
      expect(process.env['DATABASE_URL']).toBe(ambientDatabaseUrl);

      // Nothing has queried `subject`. Prisma connects LAZILY, on first query,
      // so a backend can exist at this point only because onModuleInit called
      // $connect(). MEASURED: with $connect() removed this count is 0, while
      // every other test in this file still passes — the client connects on
      // demand and nothing else notices.
      expect(await settledBackendCount(observer, (count) => count >= 1)).toBeGreaterThanOrEqual(1);
    } finally {
      await subject.close();
    }

    // And onModuleDestroy must release it. Today a single integration file
    // hides a missing $disconnect() because the fork dies at file end; from the
    // second API suite onward the pool accumulates against the shared container
    // and the symptom surfaces in an unrelated test.
    expect(await settledBackendCount(observer, (count) => count === 0)).toBe(0);
  });
});
