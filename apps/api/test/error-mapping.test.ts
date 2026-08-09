import { DomainErrorCode } from '@metrika/contracts';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_RESPONSE,
  FRAMEWORK_ERROR_CODE,
  FRAMEWORK_FALLBACK_CODE,
} from '../src/shared/errors/error-mapping.js';

describe('DOMAIN_ERROR_RESPONSE', () => {
  it('covers every code in the closed union', () => {
    const mapped = Object.keys(DOMAIN_ERROR_RESPONSE).sort();
    const declared = [...DomainErrorCode.options].sort();
    expect(mapped).toEqual(declared);
  });

  it('maps no known domain failure to 500 except INTERNAL_ERROR', () => {
    const fiveHundreds = Object.entries(DOMAIN_ERROR_RESPONSE)
      .filter(([, value]) => value.status === 500)
      .map(([code]) => code);
    expect(fiveHundreds).toEqual(['INTERNAL_ERROR']);
  });

  it('uses only statuses the contract documents', () => {
    const allowed = new Set([400, 401, 403, 404, 409, 410, 413, 422, 429, 500, 502]);
    for (const [code, value] of Object.entries(DOMAIN_ERROR_RESPONSE)) {
      expect(allowed.has(value.status), `${code} → ${String(value.status)}`).toBe(true);
    }
  });

  it('marks exactly the upstream and throttling failures retryable', () => {
    const retryable = Object.entries(DOMAIN_ERROR_RESPONSE)
      .filter(([, value]) => value.retryable)
      .map(([code]) => code)
      .sort();

    expect(retryable).toEqual(
      [
        'GEOMETRY_ANALYSIS_FAILED',
        'PAYMENT_VERIFICATION_FAILED',
        'QUOTA_EXCEEDED',
        'RATE_LIMITED',
        'SLICING_FAILED',
      ].sort(),
    );
  });

  it('maps the codes the contract table pins, exactly', () => {
    expect(DOMAIN_ERROR_RESPONSE.QUOTE_EXPIRED.status).toBe(410);
    expect(DOMAIN_ERROR_RESPONSE.UNITS_NOT_CONFIRMED.status).toBe(422);
    expect(DOMAIN_ERROR_RESPONSE.FILE_TOO_LARGE.status).toBe(413);
    expect(DOMAIN_ERROR_RESPONSE.IDEMPOTENCY_KEY_REUSED.status).toBe(409);
    expect(DOMAIN_ERROR_RESPONSE.ORDER_NOT_FOUND.status).toBe(404);
    expect(DOMAIN_ERROR_RESPONSE.ROUTE_NOT_FOUND.status).toBe(404);
  });
});

describe('FRAMEWORK_ERROR_CODE', () => {
  it('names, for every status, a code the response map pins to that same status', () => {
    // The table exists so that choosing a code and choosing a status are ONE
    // decision. Nothing in the type system enforces the agreement — the key is a
    // number and the value is a code, and TypeScript is happy to pair 404 with a
    // code mapped to 400. This is the only thing that is not.
    for (const [status, code] of Object.entries(FRAMEWORK_ERROR_CODE)) {
      expect(DOMAIN_ERROR_RESPONSE[code].status, `${status} → ${code}`).toBe(Number(status));
    }
  });

  it('has a fallback that is itself consistent, and is a 4xx', () => {
    const fallback = DOMAIN_ERROR_RESPONSE[FRAMEWORK_FALLBACK_CODE];
    expect(fallback.status).toBe(400);
    expect(fallback.retryable).toBe(false);
  });

  it('claims no 5xx status — a 5xx is never reported as the framework described it', () => {
    // A 5xx HttpException carries a message written for an operator, not a
    // client: `InternalServerErrorException('DB_DSN=postgres://…')` and
    // terminus' per-indicator ServiceUnavailableException are both real shapes.
    // The filter routes those to the generic branch instead, and a row here
    // would quietly reopen that path.
    for (const status of Object.keys(FRAMEWORK_ERROR_CODE)) {
      expect(Number(status)).toBeLessThan(500);
    }
  });
});
