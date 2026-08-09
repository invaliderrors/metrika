import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootApiForTest, stopDatabase, TEST_HEALTH_DEEP_TOKEN } from './support.js';

const TOKEN = TEST_HEALTH_DEEP_TOKEN;

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  ({ app, baseUrl } = await bootApiForTest());
});

afterAll(async () => {
  await app.close();
  await stopDatabase();
});

describe('GET /health/live', () => {
  it('is 200 and checks no dependency', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', environment: 'test' });
  });
});

describe('GET /health/ready', () => {
  it('is 200 with the database reachable', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: { name: string }[] };
    expect(body.status).toBe('ok');
    expect(body.checks.map((c) => c.name)).toEqual(['database']);
  });

  /**
   * This is the fixture for ADR-0019 obligation 1, and the only test in the
   * repository that fails when the global ZodSerializerInterceptor is removed.
   *
   * The controller hands the DTO the service's full DependencyResult, which
   * carries `latencyMs`. `HealthReadySchema` omits that field, so the response
   * schema is what removes it — and a Zod schema only removes anything if
   * something parses the response. Delete the APP_INTERCEPTOR provider and
   * `latencyMs` appears in the body of an UNAUTHENTICATED endpoint, which is
   * both a leak of internal topology and proof that every other route's
   * response validation is off too.
   *
   * toEqual, not toMatchObject: the point is the absent key.
   */
  it('reports no per-dependency latency — readiness is unauthenticated, /health/deep is not', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const body = (await response.json()) as { checks: Record<string, unknown>[] };
    expect(body.checks).toEqual([{ name: 'database', status: 'ok' }]);
  });
});

describe('GET /health/deep', () => {
  it('is 401 with no credentials — the endpoint reports internal topology', async () => {
    const response = await fetch(`${baseUrl}/health/deep`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('is 401 with the wrong token', async () => {
    const response = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(response.status).toBe(401);
  });

  /**
   * A token of exactly the right LENGTH and the wrong bytes. The two 401s above
   * both differ from the real token in length as well as content, so both stay
   * green against a comparison that only checks `presented.length ===
   * expected.length` and then returns true. This is the only assertion here that
   * separates "compares the token" from "compares its length".
   */
  it('is 401 with a wrong token of exactly the right length', async () => {
    const wrong = `${'x'.repeat(TOKEN.length - 1)}y`;
    expect(wrong).toHaveLength(TOKEN.length);
    expect(wrong).not.toBe(TOKEN);
    const response = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(response.status).toBe(401);
  });

  it('is 401 with a correct token under the wrong scheme', async () => {
    const response = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: TOKEN },
    });
    expect(response.status).toBe(401);
  });

  /**
   * RFC 9110 §11.1: the auth-scheme is case-insensitive, so `bearer <token>` is
   * a conformant request. A `startsWith('Bearer ')` check answers 401 to a
   * client that did nothing wrong, and the failure looks identical to a genuine
   * bad-credential 401 from the caller's side — the worst kind of interop bug to
   * debug.
   */
  it('accepts the scheme in any case — RFC 9110 makes it case-insensitive', async () => {
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const response = await fetch(`${baseUrl}/health/deep`, {
        headers: { authorization: `${scheme} ${TOKEN}` },
      });
      expect(response.status, scheme).toBe(200);
    }
  });

  /**
   * Case-insensitivity applies to the SCHEME only. If it leaked into the token
   * comparison, every token would have 2^n matching variants.
   */
  it('keeps the token itself case-sensitive', async () => {
    const response = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: `Bearer ${TOKEN.toUpperCase()}` },
    });
    expect(TOKEN.toUpperCase()).not.toBe(TOKEN);
    expect(response.status).toBe(401);
  });

  /**
   * RFC 9110 §11.6.1 requires a 401 to carry a challenge. Asserted on the wire
   * rather than at the guard, because the guard writes the header and then
   * THROWS — that it survives depends on DomainExceptionFilter answering on the
   * same reply object, which is somebody else's implementation detail and
   * exactly the kind of thing that changes without warning.
   */
  it('carries a WWW-Authenticate challenge on every 401, and none on success', async () => {
    for (const headers of [
      undefined,
      { authorization: 'Bearer wrong' },
      { authorization: TOKEN },
    ]) {
      const response = await fetch(`${baseUrl}/health/deep`, headers ? { headers } : undefined);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }

    const ok = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('www-authenticate')).toBeNull();
  });

  /**
   * `ApiErrorResponse` documents `message` as localised and safe to display, and
   * a 401 from this guard is the first one a real user can hit. The guard throws
   * a `DomainError`, not an `HttpException`, so `DomainExceptionFilter` takes its
   * `isDomainError` branch and the message on the wire is the one written here —
   * not Nest's or Fastify's English. Pinning it is what keeps a future
   * `throw new UnauthorizedException()` from quietly putting `Unauthorized` in a
   * field the contract says is user-facing Spanish.
   */
  it('answers with a localised message, not a framework string', async () => {
    const response = await fetch(`${baseUrl}/health/deep`);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Credenciales requeridas.');

    const wrongToken = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    const wrongBody = (await wrongToken.json()) as { error: { message: string } };
    expect(wrongBody.error.message).toBe('Credenciales inválidas.');
  });

  it('is 200 with the right token and reports per-dependency latency', async () => {
    const response = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      checks: { name: string; status: string; latencyMs: number }[];
    };
    const database = body.checks.find((c) => c.name === 'database');
    expect(database?.status).toBe('ok');
    expect(database?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
