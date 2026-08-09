import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootApiForTest, stopDatabase } from './support.js';
import { RequestContextMiddleware } from '../src/shared/request-context/request-context.middleware.js';
import { API_PREFIX } from '../src/bootstrap.js';

let baseUrl: string;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ baseUrl, close } = await bootApiForTest());
});

afterAll(async () => {
  // Guarded, and via the fixture's own closer rather than `app.close()`: if
  // `bootApiForTest()` throws, nothing is assigned and an unguarded call raises
  // a TypeError that displaces the real error in the report. Same shape as
  // boot.integration.test.ts.
  await close?.();
  await stopDatabase();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('X-Request-Id', () => {
  it('echoes a client-supplied id', async () => {
    const response = await fetch(`${baseUrl}/health/live`, {
      headers: { 'x-request-id': 'client-supplied-id' },
    });
    expect(response.headers.get('x-request-id')).toBe('client-supplied-id');
  });

  it('generates one when the client sends none', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.headers.get('x-request-id')).toMatch(UUID);
  });

  it('generates a different one per request', async () => {
    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/health/live`),
      fetch(`${baseUrl}/health/live`),
    ]);
    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
  });

  it('replaces a hostile id rather than echoing it', async () => {
    const response = await fetch(`${baseUrl}/health/live`, {
      headers: { 'x-request-id': 'a'.repeat(500) },
    });
    expect(response.headers.get('x-request-id')).toMatch(UUID);
  });

  it('stamps a route that is NOT on the health exclude list', async () => {
    // `'{*splat}'` has to match the bare '/' AND every nested path. Every route
    // this app serves today is an excluded health probe, so a middleware
    // mounted on a narrower path — `/health` say — would satisfy every
    // assertion above while covering none of the API surface Task 12a adds.
    // A 404 is produced by the router AFTER the middleware chain has run, so
    // the header on it is evidence the middleware saw the request.
    const missing = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-request-id')).toMatch(UUID);

    const root = await fetch(`${baseUrl}/`);
    expect(root.headers.get('x-request-id')).toMatch(UUID);
  });

  it('replaces the no-context sentinel a client asks for', async () => {
    // Over HTTP as well as at the unit boundary: this is the value Task 11 puts
    // in error bodies, and a client that could set it would make its own
    // requests indistinguishable from ones with no context at all.
    const response = await fetch(`${baseUrl}/health/live`, {
      headers: { 'x-request-id': 'unknown' },
    });
    expect(response.headers.get('x-request-id')).toMatch(UUID);
  });

  it('runs the middleware exactly once per request', async () => {
    // The guard against registering BOTH ways. Counted on a path under the
    // global prefix, because that is the only place a second, module-based
    // registration would also match — on /health/live it would be mounted at
    // /api/v1/health/live and never fire, so counting there proves nothing.
    //
    // The spy is installed on the prototype BEFORE the app boots, because
    // bootstrap.ts resolves `requestContext.use` at bind time. It also drives
    // the class rather than the app: a Nest application object is a Proxy whose
    // get trap routes calls through ExceptionsZone, so stubbing anything on the
    // app would measure the proxy.
    const spy = vi.spyOn(RequestContextMiddleware.prototype, 'use');
    const booted = await bootApiForTest();
    try {
      spy.mockClear();
      const response = await fetch(`${booted.baseUrl}/${API_PREFIX}/does-not-exist`);
      expect(response.status).toBe(404);
      expect(response.headers.get('x-request-id')).toMatch(UUID);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await booted.close();
      spy.mockRestore();
    }
  });
});
