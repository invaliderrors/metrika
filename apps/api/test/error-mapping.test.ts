import { DomainErrorCode } from '@metrika/contracts';
import { describe, expect, it } from 'vitest';
import { DOMAIN_ERROR_RESPONSE } from '../src/shared/errors/error-mapping.js';

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
  });
});
