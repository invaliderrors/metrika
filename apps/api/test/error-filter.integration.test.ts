// This file is the ONE integration suite that does not boot the real
// application, because there is deliberately no route in the real application
// that throws. Two consequences are handled explicitly:
//
//   * `reflect-metadata` is imported here. Every other suite gets it
//     transitively through src/bootstrap.js; this one does not, and Nest's
//     decorators need it installed before any decorated class is evaluated.
//     Relying on @nestjs/core to import it for us is relying on an
//     implementation detail of somebody else's package.
//   * There is no startDatabase()/stopDatabase() call. BoomModule touches no
//     database, so there is nothing here to connect one to. That does NOT make
//     this suite Docker-free — the shared `globalSetup` starts the container
//     unconditionally for the whole integration run, so Docker is required
//     either way; it means only that this file adds no second handle to close.
//
// What it still shares with production is the filter and the request-context
// middleware — the two things under test. Task 12a's health suite covers the
// filter as registered by the real bootstrap.
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Module,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DomainErrorCode } from '@metrika/contracts';
import { DomainError } from '../src/shared/errors/domain-error.js';
import { DomainExceptionFilter } from '../src/shared/errors/domain-exception.filter.js';
import { DOMAIN_ERROR_RESPONSE } from '../src/shared/errors/error-mapping.js';
import { RequestContextModule } from '../src/shared/request-context/request-context.module.js';
import { captureLogger, type CapturedLog } from './log-capture.js';

const DSN = 'DB_DSN=postgres://user:PASSWORD@host/db';
const POD = 'upstream slicer pod slicer-7f2 unreachable';

@Controller('boom')
class BoomController {
  @Get('domain')
  domain(): never {
    throw new DomainError('QUOTE_EXPIRED', 'La cotización ha expirado', { quoteId: 'q-1' });
  }

  @Get('retryable')
  retryable(): never {
    throw new DomainError('SLICING_FAILED', 'El laminado ha fallado');
  }

  @Get('unexpected')
  unexpected(): never {
    throw new Error('a stack trace that must never cross the boundary');
  }

  /** The shape that leaked: a library 5xx whose message was written for an operator. */
  @Get('http-500')
  httpInternal(): never {
    throw new InternalServerErrorException(DSN);
  }

  /** @nestjs/terminus signals an unhealthy check exactly like this. */
  @Get('http-503')
  httpUnavailable(): never {
    throw new ServiceUnavailableException(POD);
  }

  /** A framework 4xx the map marks retryable, which no other probe here is. */
  @Get('http-429')
  httpThrottled(): never {
    throw new HttpException('Demasiadas solicitudes', HttpStatus.TOO_MANY_REQUESTS);
  }

  /**
   * Any framework status on demand. This is how the branch is driven at the
   * statuses that have no row — 405, 409, 415, 422 — which is where the status
   * collapse was measured.
   */
  @Get('http/:status')
  httpStatus(@Param('status') status: string): never {
    throw new HttpException('El framework ha rechazado la solicitud', Number.parseInt(status, 10));
  }
}

@Module({ imports: [RequestContextModule], controllers: [BoomController] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a Nest module is a class whose only purpose is to carry decorator metadata; the shared profile relaxes this rule for `**/*.module.ts` only, and this fixture module belongs beside the one suite that boots it rather than in src/. The alternative this repo already uses twice in apps/api/eslint.config.js — a package-local `files: ['test/**']` override — would work and weakens nothing outside apps/api; it is simply broader than one fixture needs.
class BoomModule {}

let app: NestFastifyApplication;
let baseUrl: string;
/**
 * The REAL sink, into memory. `logger: false` above silences Nest's own output
 * but says nothing about this filter's, which is now written through
 * `createLogger` — so the suite that already drives a DSN over real HTTP can
 * assert what reaches the log as well as what reaches the client.
 */
let log: CapturedLog;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(BoomModule, new FastifyAdapter(), {
    logger: false,
  });
  log = captureLogger();
  app.useGlobalFilters(new DomainExceptionFilter(log.logger));
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

describe('DomainExceptionFilter', () => {
  it('maps a DomainError to its documented status', async () => {
    const response = await fetch(`${baseUrl}/boom/domain`);
    expect(response.status).toBe(410);
  });

  it('returns the documented error envelope', async () => {
    const response = await fetch(`${baseUrl}/boom/domain`, {
      headers: { 'x-request-id': 'trace-me' },
    });
    expect(await response.json()).toEqual({
      error: {
        code: 'QUOTE_EXPIRED',
        message: 'La cotización ha expirado',
        details: { quoteId: 'q-1' },
        requestId: 'trace-me',
        retryable: false,
      },
    });
  });

  it('reads status AND retryable from the map rather than the branch', async () => {
    // Every assertion above throws QUOTE_EXPIRED, which the map marks
    // `retryable: false` at status 410 — so all of them stay green against a
    // filter that hardcodes either value on the domain branch. A code the map
    // marks retryable at a different status is the only thing that separates
    // "read from the table" from "written twice".
    const response = await fetch(`${baseUrl}/boom/retryable`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('SLICING_FAILED');
    expect(body.error.retryable).toBe(true);
  });

  it('omits details entirely when the error carries none', async () => {
    // This pins the WIRE SHAPE that ApiErrorResponse declares — `details` is
    // optional, not nullable, so an error without details must have no such key.
    //
    // It does NOT, and cannot, prove the conditional spread is necessary:
    // `JSON.stringify` drops an `undefined` value, so `details: exception.details`
    // and `...(details !== undefined && { details })` are byte-identical here.
    // What forbids the direct assignment is `tsc` under
    // `exactOptionalPropertyTypes` (TS2375), not this assertion.
    const response = await fetch(`${baseUrl}/boom/retryable`);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty('details');
  });

  it('maps an unexpected error to 500 INTERNAL_ERROR', async () => {
    const response = await fetch(`${baseUrl}/boom/unexpected`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('never leaks a stack trace or the original message', async () => {
    const response = await fetch(`${baseUrl}/boom/unexpected`);
    const raw = await response.text();
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('must never cross the boundary');
    expect(raw).not.toContain('.ts:');
  });

  it('carries the request id on the error response too', async () => {
    const response = await fetch(`${baseUrl}/boom/unexpected`, {
      headers: { 'x-request-id': 'error-path-id' },
    });
    expect(response.headers.get('x-request-id')).toBe('error-path-id');
    const body = (await response.json()) as ErrorBody;
    expect(body.error.requestId).toBe('error-path-id');
  });

  it('never lets a 5xx HttpException describe itself to the client', async () => {
    // MEASURED before the fix: the message went out verbatim, DSN and all.
    // HttpException is the class every Nest library throws, so this branch is
    // not hypothetical — it is the default way a dependency reports failure.
    const response = await fetch(`${baseUrl}/boom/http-500`);
    const raw = await response.text();
    expect(response.status).toBe(500);
    expect(raw).not.toContain('PASSWORD');
    expect(raw).not.toContain('postgres://');
    expect(raw).not.toContain('DB_DSN');
    expect((JSON.parse(raw) as ErrorBody).error.code).toBe('INTERNAL_ERROR');
  });

  /**
   * The same request, from the LOG's side — the half that was still open until
   * Plan 0C Task 2. Keeping the DSN out of the response was Plan 0B-1's fix,
   * and its own comment recorded that the filter still wrote the exception's
   * stack, which begins with its message, to stdout. This asserts the whole
   * round trip: over real HTTP, through the real filter, into the real sink.
   */
  it('and writes no part of it to the log either', async () => {
    await fetch(`${baseUrl}/boom/http-500`);

    expect(log.raw()).not.toContain('PASSWORD');
    expect(log.raw()).not.toContain('postgres://');
    expect(log.raw()).not.toContain('DB_DSN');
    // Not merely quiet: the line is there, and it names the throw site.
    const frames = log
      .lines()
      .flatMap((line) => (line['err'] as { frames?: string[] } | undefined)?.frames ?? []);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('treats a terminus-shaped 503 the same way, naming no internal host', async () => {
    const response = await fetch(`${baseUrl}/boom/http-503`);
    const raw = await response.text();
    expect(response.status).toBe(500);
    expect(raw).not.toContain('slicer-7f2');
    expect(log.raw()).not.toContain('slicer-7f2');
    expect((JSON.parse(raw) as ErrorBody).error.code).toBe('INTERNAL_ERROR');
  });

  it('keeps a framework 4xx at its own status, with retryable from the map', async () => {
    const response = await fetch(`${baseUrl}/boom/http-429`);
    expect(response.status).toBe(429);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryable).toBe(true);
  });

  it('answers an unmatched route with ROUTE_NOT_FOUND at 404', async () => {
    const response = await fetch(`${baseUrl}/no-such-route`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(body.error.requestId).not.toBe('');
  });

  it('keeps a framework rejection at the status the framework chose', async () => {
    // MEASURED before this: 415 → 400, 409 → 400, 422 → 400, 405 → 400. Two of
    // those are statuses this API's own contract table uses heavily, and none of
    // it needs application code to throw anything — `POST` with
    // `content-type: application/x-tar` and Fastify raises the 415 itself. When
    // the first upload endpoint lands, 413 and 415 are precisely the two
    // statuses a client branches on.
    //
    // These four have no row in FRAMEWORK_ERROR_CODE, so they carry the fallback
    // code at their own status — the one sanctioned place where a code and its
    // mapped status differ.
    for (const status of [405, 409, 415, 422]) {
      const response = await fetch(`${baseUrl}/boom/http/${String(status)}`);
      expect(response.status, `thrown ${String(status)}`).toBe(status);
      const body = (await response.json()) as ErrorBody;
      expect(body.error.code, `thrown ${String(status)}`).toBe('VALIDATION_FAILED');
    }
  });

  it('serves every mapped framework status with its own code, over HTTP', async () => {
    // Spelled out rather than iterated from FRAMEWORK_ERROR_CODE, because a test
    // that reads the table cannot see a row DELETED from it. MEASURED: removing
    // `413: 'FILE_TOO_LARGE'` or `401: 'UNAUTHENTICATED'` left both suites green
    // at exit 0 while the wire silently degraded to VALIDATION_FAILED.
    const rows = [
      [400, 'VALIDATION_FAILED'],
      [401, 'UNAUTHENTICATED'],
      [403, 'INSUFFICIENT_PERMISSIONS'],
      [404, 'ROUTE_NOT_FOUND'],
      [413, 'FILE_TOO_LARGE'],
      [429, 'RATE_LIMITED'],
    ] as const;

    for (const [status, code] of rows) {
      const response = await fetch(`${baseUrl}/boom/http/${String(status)}`);
      expect(response.status, `${String(status)} → ${code}`).toBe(status);
      const body = (await response.json()) as ErrorBody;
      expect(body.error.code, `${String(status)} → ${code}`).toBe(code);
    }
  });

  it('puts a DOMAIN-decided code at the status the map pins', async () => {
    // Where the code is the fact and the status is its published consequence.
    // `VALIDATION_FAILED` used to ship at 404, 500 and 503 while the table
    // pinned it at 400 — a contradiction no test over the table alone could
    // see, because the table was right and the responses were wrong.
    //
    // Framework rejections are deliberately NOT in this list: there the status
    // is the fact. That split is the whole point of the two tests above.
    const paths = [
      '/boom/domain',
      '/boom/retryable',
      '/boom/unexpected',
      '/boom/http-500',
      '/boom/http-503',
    ];

    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`);
      const body = (await response.json()) as ErrorBody;
      const code = DomainErrorCode.parse(body.error.code);
      expect(DOMAIN_ERROR_RESPONSE[code].status, `${path} → ${code}`).toBe(response.status);
    }
  });

  it('gives every response the map’s retryable for its code, whoever decided the status', async () => {
    // This one holds across BOTH kinds. `retryable` is a property of the code
    // alone — whether an identical retry could plausibly succeed — so nothing
    // about who chose the status changes it.
    const paths = [
      '/boom/domain',
      '/boom/retryable',
      '/boom/unexpected',
      '/boom/http-500',
      '/boom/http-503',
      '/boom/http-429',
      '/boom/http/415',
      '/no-such-route',
    ];

    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`);
      const body = (await response.json()) as ErrorBody;
      // Parsed, not cast: this also asserts every code on the wire is a member
      // of the closed union.
      const code = DomainErrorCode.parse(body.error.code);
      expect(DOMAIN_ERROR_RESPONSE[code].retryable, `${path} → ${code}`).toBe(body.error.retryable);
    }
  });
});
