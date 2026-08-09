// The failures find-my-way raises BEFORE Nest's pipeline exists. They reach
// neither the exception filter nor the request-context middleware, so this suite
// boots the REAL bootstrap: the whole point is what the composed app puts on the
// wire, and a hand-built module tree cannot answer that.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainErrorCode } from '@metrika/contracts';
import { bootApiForTest, stopDatabase } from './support.js';
import { API_PREFIX } from '../src/bootstrap.js';

let baseUrl: string;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ baseUrl, close } = await bootApiForTest());
});

afterAll(async () => {
  await close?.();
  await stopDatabase();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A percent-escape find-my-way cannot decode. Rejected by the router itself. */
const BAD_URL = '%zz';

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

describe('router-level failures', () => {
  it('answers a malformed URL in the documented envelope', async () => {
    // MEASURED before `frameworkErrors` was wired:
    //
    //   400 {"error":"Bad Request","code":"FST_ERR_BAD_URL",
    //        "message":"'/api/v1/%zz' is not a valid url component","statusCode":400}
    //
    // `error` a string where ApiErrorResponse declares an object, `code` a
    // Fastify constant and not a DomainErrorCode, and no request id anywhere.
    // A client parsing the published contract fails outright on that response.
    const response = await fetch(`${baseUrl}/${API_PREFIX}/${BAD_URL}`);
    expect(response.status).toBe(400);

    const body = (await response.json()) as ErrorBody;
    expect(DomainErrorCode.parse(body.error.code)).toBe('VALIDATION_FAILED');
    expect(body.error.retryable).toBe(false);
    expect(typeof body.error.message).toBe('string');
  });

  it('leaks no Fastify internals through it', async () => {
    const raw = await (await fetch(`${baseUrl}/${API_PREFIX}/${BAD_URL}`)).text();

    // Fastify's own response shape.
    expect(raw).not.toContain('FST_ERR');
    expect(raw).not.toContain('statusCode');
    expect(raw).not.toContain('"error":"Bad Request"');

    // And the stack, which the three assertions above CANNOT see — measured:
    // forwarding `error.stack` from the 4xx branch left this whole suite green
    // while the wire carried absolute filesystem paths, pinned dependency
    // versions (`.pnpm/fastify@5.10.0/…`, `find-my-way@9.7.0/…`) and Node
    // internals down to `HTTPParser.parserOnHeadersComplete`. `@fastify/error`
    // sets `name = 'FastifyError'` and keeps `FST_ERR_BAD_URL` only on `.code`,
    // so the token those assertions look for never appears in the thing they
    // are meant to detect. These four are the same guard
    // error-filter.integration.test.ts already had on the filter path.
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('.js:');
    expect(raw).not.toContain('node_modules');
    expect(raw).not.toContain('\n    at ');
  });

  it('carries a request id in the body AND on the header', async () => {
    // There is no async-local context here — the middleware never ran — so the
    // handler mints one. Without it, support has nothing to trace and the body
    // and header disagree with every other response the API produces.
    const response = await fetch(`${baseUrl}/${API_PREFIX}/${BAD_URL}`);
    const body = (await response.json()) as ErrorBody;

    expect(body.error.requestId).toMatch(UUID);
    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
  });

  it('echoes a client-supplied request id, and refuses the sentinel', async () => {
    const supplied = await fetch(`${baseUrl}/${API_PREFIX}/${BAD_URL}`, {
      headers: { 'x-request-id': 'router-level-id' },
    });
    expect(((await supplied.json()) as ErrorBody).error.requestId).toBe('router-level-id');

    // `unknown` is what getRequestId() reports when there is NO context. A
    // client that could set it here — where genuinely there is no context —
    // would make the two indistinguishable in exactly the place it matters most.
    const forged = await fetch(`${baseUrl}/${API_PREFIX}/${BAD_URL}`, {
      headers: { 'x-request-id': 'unknown' },
    });
    expect(((await forged.json()) as ErrorBody).error.requestId).toMatch(UUID);
  });

  it('does the same outside the global prefix', async () => {
    // The prefix-excluded health probes live out here, so a handler that only
    // covered `/api/v1/**` would leave the operator-facing surface in Fastify's
    // shape. Same class of mistake as mounting the middleware under the prefix.
    const response = await fetch(`${baseUrl}/${BAD_URL}`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(DomainErrorCode.parse(body.error.code)).toBe('VALIDATION_FAILED');
    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
  });
});
