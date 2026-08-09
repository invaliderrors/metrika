import 'reflect-metadata';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { MiddlewareConsumer } from '@nestjs/common';
import {
  NO_REQUEST_ID,
  getRequestContext,
  getRequestId,
  normaliseRequestId,
  runWithRequestContext,
} from '../src/shared/request-context/request-context.js';
import {
  REQUEST_ID_HEADER,
  RequestContextMiddleware,
} from '../src/shared/request-context/request-context.middleware.js';
import { RequestContextModule } from '../src/shared/request-context/request-context.module.js';
import { AppModule } from '../src/app.module.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('normaliseRequestId', () => {
  it('echoes a well-formed client-supplied id', () => {
    expect(normaliseRequestId('req-abc_123.4')).toBe('req-abc_123.4');
  });

  it('mints a UUID when the header is absent', () => {
    expect(normaliseRequestId(undefined)).toMatch(UUID);
  });

  it('mints a UUID when the header is an array — a duplicated header is not a value', () => {
    expect(normaliseRequestId(['a', 'b'])).toMatch(UUID);
  });

  it('rejects a value with characters that could forge a log line', () => {
    expect(normaliseRequestId('abc\ndef')).toMatch(UUID);
  });

  it('rejects an over-long value rather than truncating it', () => {
    expect(normaliseRequestId('x'.repeat(200))).toMatch(UUID);
  });

  it('rejects an empty string', () => {
    expect(normaliseRequestId('')).toMatch(UUID);
  });

  it('mints a different id on each call', () => {
    expect(normaliseRequestId(undefined)).not.toBe(normaliseRequestId(undefined));
  });

  it('refuses to hand back the no-context sentinel, which is inside the character class', () => {
    // Task 11 puts this value in every error body. If a client can obtain it,
    // `requestId: "unknown"` stops meaning "no context was established" and
    // starts also meaning "a client asked for that string" — two conditions
    // that need very different responses from whoever reads the log.
    expect(normaliseRequestId(NO_REQUEST_ID)).toMatch(UUID);
    expect(normaliseRequestId('unknown')).toMatch(UUID);
  });

  it('refuses case variants of the sentinel — a log search for it is not case-sensitive', () => {
    expect(normaliseRequestId('UNKNOWN')).toMatch(UUID);
    expect(normaliseRequestId('Unknown')).toMatch(UUID);
  });

  it('still accepts an id that merely contains the sentinel', () => {
    // The refusal is of the whole value, not a substring ban: narrowing the
    // acceptable set further than the ambiguity requires would reject
    // legitimate client ids for no gain.
    expect(normaliseRequestId('unknown-device-42')).toBe('unknown-device-42');
  });
});

describe('request context storage', () => {
  it('exposes the id inside the scope', () => {
    runWithRequestContext({ requestId: 'inside' }, () => {
      expect(getRequestId()).toBe('inside');
    });
  });

  it('is undefined outside any scope', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('reports "unknown" outside a scope rather than throwing — an error path must never fail on logging', () => {
    // The literal, pinned once. NO_REQUEST_ID is a published value: Task 11 puts
    // it in error bodies and support conversations read it, so changing it is a
    // contract change and has to fail here rather than pass silently because
    // every assertion derives from the constant.
    expect(NO_REQUEST_ID).toBe('unknown');
    expect(getRequestId()).toBe(NO_REQUEST_ID);
  });

  it('does not leak out of the scope', () => {
    runWithRequestContext({ requestId: 'inside' }, () => getRequestId());
    expect(getRequestContext()).toBeUndefined();
  });

  it('survives an await boundary', async () => {
    await runWithRequestContext({ requestId: 'async-scope' }, async () => {
      await Promise.resolve();
      expect(getRequestId()).toBe('async-scope');
    });
  });

  it('keeps concurrent scopes separate', async () => {
    const seen = await Promise.all([
      runWithRequestContext({ requestId: 'a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestId();
      }),
      runWithRequestContext({ requestId: 'b' }, async () => getRequestId()),
    ]);

    expect(seen).toEqual(['a', 'b']);
  });
});

/**
 * The middleware is driven DIRECTLY, over real `node:http` objects rather than
 * hand-rolled fakes, so the assertions are about the unit and not about a stub
 * that agrees with itself. Two things here are invisible to the HTTP-level
 * suite in request-context.integration.test.ts: the response header is set
 * BEFORE `next()` runs (which is what puts it on an error response too), and
 * the id `next()` observes comes from async-local storage rather than from a
 * module-level variable — a middleware that stashed the id in a `let` would
 * still stamp every response header correctly and only corrupt the context of
 * requests that overlap.
 */
function fakeExchange(headerValue?: string): {
  request: IncomingMessage;
  response: ServerResponse;
} {
  const request = new IncomingMessage(new Socket());
  if (headerValue !== undefined) request.headers[REQUEST_ID_HEADER] = headerValue;
  return { request, response: new ServerResponse(request) };
}

describe('RequestContextMiddleware', () => {
  it('echoes a well-formed client id onto the response', () => {
    const middleware = new RequestContextMiddleware();
    const { request, response } = fakeExchange('client-supplied-id');

    middleware.use(request, response, () => undefined);

    expect(response.getHeader(REQUEST_ID_HEADER)).toBe('client-supplied-id');
  });

  it('replaces a hostile client id rather than echoing it', () => {
    const middleware = new RequestContextMiddleware();
    const { request, response } = fakeExchange('a'.repeat(500));

    middleware.use(request, response, () => undefined);

    expect(response.getHeader(REQUEST_ID_HEADER)).toMatch(UUID);
  });

  it('sets the header before calling next, so an error response still carries it', () => {
    const middleware = new RequestContextMiddleware();
    const { request, response } = fakeExchange('set-before-next');
    let headerAtNext: number | string | string[] | undefined;

    middleware.use(request, response, () => {
      headerAtNext = response.getHeader(REQUEST_ID_HEADER);
    });

    expect(headerAtNext).toBe('set-before-next');
  });

  it('runs next inside a context carrying the same id it put on the response', () => {
    const middleware = new RequestContextMiddleware();
    const { request, response } = fakeExchange();
    let seen = 'never-ran';

    middleware.use(request, response, () => {
      seen = getRequestId();
    });

    expect(seen).toMatch(UUID);
    expect(response.getHeader(REQUEST_ID_HEADER)).toBe(seen);
  });

  it('leaves no context behind once next has returned', () => {
    const middleware = new RequestContextMiddleware();
    const { request, response } = fakeExchange('transient');

    middleware.use(request, response, () => undefined);

    expect(getRequestContext()).toBeUndefined();
  });

  it('keeps two overlapping requests from observing one another', async () => {
    const middleware = new RequestContextMiddleware();
    const seen: string[] = [];

    // The slower request enters FIRST and leaves LAST, so its `next` callback
    // resumes after the second request has already run start to finish. A
    // module-level `let` holding the current id passes every other assertion in
    // this file and fails here.
    const drive = async (clientId: string, delayMs: number): Promise<void> => {
      const { request, response } = fakeExchange(clientId);
      await new Promise<void>((resolve) => {
        middleware.use(request, response, () => {
          setTimeout(() => {
            seen.push(getRequestId());
            resolve();
          }, delayMs);
        });
      });
    };

    await Promise.all([drive('slow-request', 20), drive('fast-request', 0)]);

    expect(seen).toEqual(['fast-request', 'slow-request']);
  });
});

describe('registration', () => {
  it('keeps RequestContextModule out of AppModule — importing it double-registers the middleware', () => {
    // The composed app registers the middleware once, globally, in bootstrap.ts,
    // because it sets a global prefix and MiddlewareConsumer cannot escape one
    // on platform-fastify. Importing the module as well is silent: MEASURED, the
    // middleware then runs TWICE per request under /api/v1 — the outer run mints
    // an id and the inner run replaces it — and lint, tsc and the whole
    // integration suite stay green. Plan 0C's access log would be the first
    // thing to notice, by recording a different id than the error body carried.
    const imports: unknown = Reflect.getMetadata('imports', AppModule);
    expect(Array.isArray(imports)).toBe(true);
    expect(imports).not.toContain(RequestContextModule);
  });

  it('mounts the module middleware on the braced wildcard, the only form that also matches "/"', () => {
    // A change-detector on purpose, in the style of the API_PREFIX pin in
    // boot.integration.test.ts. Two of the three plausible spellings are wrong
    // in ways that raise no error: '*splat' silently never matches the bare '/',
    // and '*' works only via an undocumented compatibility shim in the Fastify
    // adapter that suppresses its own deprecation warning.
    const applied: unknown[] = [];
    const routes: unknown[] = [];
    const proxy = {
      forRoutes: (...value: unknown[]): unknown => {
        routes.push(...value);
        return proxy;
      },
      exclude: (): unknown => proxy,
    };
    const consumer = {
      apply: (...middleware: unknown[]): unknown => {
        applied.push(...middleware);
        return proxy;
      },
    };

    new RequestContextModule().configure(consumer as unknown as MiddlewareConsumer);

    expect(applied).toEqual([RequestContextMiddleware]);
    expect(routes).toEqual(['{*splat}']);
  });
});
