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
//     database, and starting one would be a 3-second no-op that makes the
//     suite look like it depends on Docker when it does not.
//
// What it still shares with production is the filter and the request-context
// middleware — the two things under test. Task 12a's health suite covers the
// filter as registered by the real bootstrap.
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DomainError } from '../src/shared/errors/domain-error.js';
import { DomainExceptionFilter } from '../src/shared/errors/domain-exception.filter.js';
import { RequestContextModule } from '../src/shared/request-context/request-context.module.js';

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
}

@Module({ imports: [RequestContextModule], controllers: [BoomController] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a Nest module is a class whose only purpose is to carry decorator metadata; the shared profile relaxes this rule for `**/*.module.ts` only, and this fixture module belongs beside the one suite that boots it rather than in src/.
class BoomModule {}

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(BoomModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

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
    // Every other assertion in this file throws QUOTE_EXPIRED, which the map
    // marks `retryable: false` — so all of them stay green against a filter that
    // hardcodes `retryable: false` on the domain branch, and against one that
    // hardcodes 410. A code the map marks retryable at a different status is the
    // only thing that separates "read from the table" from "written twice".
    const response = await fetch(`${baseUrl}/boom/retryable`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe('SLICING_FAILED');
    expect(body.error.retryable).toBe(true);
  });

  it('omits details entirely when the error carries none', async () => {
    // The conditional spread, pinned: `details: undefined` and an absent
    // `details` are different documents on the wire, and ApiErrorResponse
    // declares the field optional, not nullable.
    const response = await fetch(`${baseUrl}/boom/retryable`);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty('details');
  });

  it('maps an unexpected error to 500 INTERNAL_ERROR', async () => {
    const response = await fetch(`${baseUrl}/boom/unexpected`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
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
    const body = (await response.json()) as { error: { requestId: string } };
    expect(body.error.requestId).toBe('error-path-id');
  });
});
