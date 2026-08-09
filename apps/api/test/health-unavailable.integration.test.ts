import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootApiForTest,
  startTestDatabase,
  stopDatabase,
  TEST_HEALTH_DEEP_TOKEN,
} from './support.js';

/**
 * WHY A PROXY AND NOT `docker kill`.
 *
 * The behaviour under test needs a database that is reachable at boot and gone
 * afterwards, and it cannot be produced by pointing the app at a dead URL:
 * `PrismaService.onModuleInit` calls `$connect()`, so `bootApiForTest()` rejects
 * with `Can't reach database server` and there is no app left to ask. Stated
 * plainly, because it is a real limitation and not a testing inconvenience:
 * **an API that crash-loops when Postgres is down can never report that Postgres
 * is down.** Whether `$connect()` should be non-fatal is being carried as a
 * design question elsewhere; nothing here changes it.
 *
 * So the database has to die AFTER boot. `docker kill` on the container does
 * that — and it was used to measure this behaviour before this file existed —
 * but the container is shared by the whole integration run via `globalSetup`,
 * and Vitest does not order test FILES by name, so a committed test that kills
 * it takes whichever suites happen to run afterwards with it.
 *
 * A TCP proxy in front of the real container gives the same fact hermetically.
 * There is nothing simulated about it: a real Postgres, a real socket, and on
 * teardown a real ECONNREFUSED from the kernel — the same error class Prisma
 * reports for a killed container. What it does NOT cover is anything specific to
 * the container dying rather than the connection dying, which is nothing this
 * route can distinguish.
 */
interface Severable {
  readonly url: string;
  readonly sever: () => Promise<void>;
}

async function proxyTo(upstreamUrl: string): Promise<Severable> {
  const upstream = new URL(upstreamUrl);
  const open = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const forward = net.connect({
      host: upstream.hostname,
      port: Number(upstream.port),
    });
    open.add(client);
    open.add(forward);
    // A severed proxy produces errors on both halves. They are expected, and an
    // unhandled 'error' on a net.Socket is an uncaught exception that would kill
    // the worker rather than fail the test.
    client.on('error', () => undefined);
    forward.on('error', () => undefined);
    client.pipe(forward);
    forward.pipe(client);
  });
  server.on('error', () => undefined);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('proxy did not bind to a TCP port');
  }

  const proxied = new URL(upstreamUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(address.port);

  return {
    url: proxied.toString(),
    sever: async (): Promise<void> => {
      // ORDER IS LOAD-BEARING, and the wrong order deadlocks rather than
      // failing. `server.close(cb)` stops the listener immediately but does not
      // call back until every existing connection has ended — and the whole
      // point here is that Prisma is holding one. MEASURED with close awaited
      // first: the callback never fired, the test hit its 60s timeout, and the
      // sockets were never destroyed, so `/health/deep` in the next test
      // answered a cheerful 200.
      //
      // Both halves are needed. Destroying sockets alone leaves the listener up,
      // so Prisma reconnects and the probe goes on answering `ok`; closing the
      // listener alone leaves the pooled connection working.
      for (const socket of open) socket.destroy();
      open.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

let baseUrl: string;
let close: (() => Promise<void>) | undefined;
let link: Severable;

interface ProbeBody {
  readonly status: string;
  readonly checks: Record<string, unknown>[];
}

beforeAll(async () => {
  const handle = await startTestDatabase();
  link = await proxyTo(handle.applicationUrl);
  ({ baseUrl, close } = await bootApiForTest({ DATABASE_URL: link.url }));
}, 120_000);

afterAll(async () => {
  // Guarded and swallowed: `app.close()` runs `$disconnect()` against a pool
  // whose socket this test deliberately destroyed, and a failure there would
  // displace a real assertion failure in the report.
  await close?.().catch(() => undefined);
  await stopDatabase();
});

describe('probes with the database gone', () => {
  it('answers 200 while the database is reachable', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProbeBody).status).toBe('ok');
  });

  /**
   * THE POINT OF THIS FILE. A readiness probe that answers `{"status":"down"}`
   * at HTTP 200 does not work: docs/OBSERVABILITY.md has this route feeding the
   * load balancer, and an ALB target group decides on the STATUS LINE and never
   * parses the body — so a task with no database stays in rotation and keeps
   * taking traffic. MEASURED at `200 {"status":"down",…}` before the fix.
   *
   * The body assertions are not incidental. 503 could also be produced by
   * throwing, and a throw would reach DomainExceptionFilter's `>= 500` branch
   * and be flattened to a generic `INTERNAL_ERROR` envelope naming no
   * dependency. `checks` proving WHICH dependency failed is what says the status
   * was set without giving up the body — and the absent `latencyMs` proves the
   * response schema still ran, so this route did not buy its status code by
   * turning response validation off.
   */
  it('answers 503 once the database is gone, keeping the per-dependency body', async () => {
    await link.sever();

    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as ProbeBody;
    expect(body.status).toBe('down');
    expect(body.checks).toEqual([{ name: 'database', status: 'down' }]);
  }, 60_000);

  it('gives /health/deep the same status, still behind the token', async () => {
    const unauthenticated = await fetch(`${baseUrl}/health/deep`);
    expect(unauthenticated.status).toBe(401);

    const response = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: `Bearer ${TEST_HEALTH_DEEP_TOKEN}` },
    });
    expect(response.status).toBe(503);

    const body = (await response.json()) as ProbeBody;
    expect(body.status).toBe('down');
    expect(body.checks[0]).toMatchObject({ name: 'database', status: 'down' });
    expect(body.checks[0]).toHaveProperty('latencyMs');
  }, 60_000);

  /**
   * Liveness must not follow readiness down. A liveness probe that fails because
   * a dependency failed makes the orchestrator KILL the task instead of taking
   * it out of rotation, which turns a recoverable degradation into a restart
   * loop. This is the assertion that catches "make all the probes consistent".
   */
  it('leaves /health/live at 200 — liveness checks no dependency', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', environment: 'test' });
  });
});
