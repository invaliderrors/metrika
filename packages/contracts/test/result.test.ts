import { describe, expect, it } from 'vitest';
import { assertNever, DomainErrorCode, err, isErr, isOk, ok } from '../src/index.js';

describe('Result', () => {
  it('ok carries its value', () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
  });

  it('err carries its error', () => {
    const r = err('QUOTE_EXPIRED');
    expect(r).toEqual({ ok: false, error: 'QUOTE_EXPIRED' });
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
  });

  it('narrows through isOk', () => {
    const r = ok('value');
    if (isOk(r)) expect(r.value.toUpperCase()).toBe('VALUE');
    else throw new Error('unreachable');
  });

  // --- Additional edge cases beyond the brief ---
  // The brief's own tests exercise isOk/isErr narrowing only for `ok(...)` —
  // without this, `isErr`'s narrowing branch (as opposed to just its boolean
  // return value, already covered above) would go unexercised at runtime.

  it('narrows through isErr', () => {
    const r = err('QUOTE_EXPIRED');
    if (isErr(r)) expect(r.error).toBe('QUOTE_EXPIRED');
    else throw new Error('unreachable');
  });
});

describe('assertNever', () => {
  it('throws naming the context and the unhandled value', () => {
    expect(() => assertNever('UNEXPECTED' as never, 'FitResult')).toThrow(/FitResult.*UNEXPECTED/s);
  });

  // --- Additional edge cases beyond the brief ---
  // `JSON.stringify` — the brief's own Step 3 snippet — throws a TypeError on
  // bigint and on circular structures, and silently returns the *value*
  // `undefined` (not a string) for `undefined`, `function`, and `symbol`
  // inputs, despite its TypeScript signature always declaring a `string`
  // return. A diagnostic helper that itself throws a different, unrelated
  // error — or silently lies about its own return type — defeats the point of
  // naming the context. These guard that assertNever degrades gracefully in
  // every case instead of crashing or going quiet.

  it('renders a bigint value instead of letting JSON.stringify throw on it', () => {
    expect(() => assertNever(10n as never, 'Ctx')).toThrow(/Ctx.*10n/s);
  });

  it('names undefined explicitly, since JSON.stringify(undefined) is not a string', () => {
    expect(() => assertNever(undefined as never, 'Ctx')).toThrow(/Ctx.*undefined/s);
  });

  it('names a function value, since JSON.stringify(fn) silently returns undefined, not a string', () => {
    function namedCase() {
      return undefined;
    }
    expect(() => assertNever(namedCase as never, 'Ctx')).toThrow(/Ctx.*namedCase/s);
  });

  it('names a symbol value, since JSON.stringify(sym) silently returns undefined, not a string', () => {
    expect(() => assertNever(Symbol('OOPS') as never, 'Ctx')).toThrow(/Ctx.*Symbol\(OOPS\)/s);
  });

  it('names the runtime type instead of letting JSON.stringify throw on a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => assertNever(circular as never, 'Ctx')).toThrow(/Ctx.*unserializable object/s);
  });
});

describe('DomainErrorCode', () => {
  it('includes the codes the domain throws', () => {
    for (const code of [
      'MODEL_NOT_FOUND',
      'UNITS_NOT_CONFIRMED',
      'QUOTE_EXPIRED',
      'SLICING_FAILED',
    ]) {
      expect(DomainErrorCode.safeParse(code).success).toBe(true);
    }
  });

  it('is a closed union', () => {
    expect(DomainErrorCode.safeParse('SOMETHING_MADE_UP').success).toBe(false);
  });

  // --- Additional edge cases beyond the brief ---
  // The brief only spot-checks four of the twenty-eight codes. A loop asserting
  // `safeParse(code).success` for every `code` in `DomainErrorCode.options`
  // cannot fail: `.options` *is* the parse whitelist a `z.enum` builds itself
  // from, so every element trivially round-trips by construction, on any
  // enum, including an empty one. Catching a typo, an accidental deletion, or
  // an unreviewed addition requires comparing the membership list against an
  // independent, hard-coded source of truth — this list, spelled out in full
  // and in order, duplicated deliberately so that changing the enum without
  // updating this test is exactly the event that fails the build.

  it('is exactly this set of twenty-eight codes, in this order', () => {
    expect(DomainErrorCode.options).toEqual([
      'VALIDATION_FAILED',
      'ROUTE_NOT_FOUND',
      'UNAUTHENTICATED',
      'INSUFFICIENT_PERMISSIONS',
      'MODEL_NOT_FOUND',
      'MODEL_NOT_READY',
      'MODEL_NOT_PRINTABLE',
      'MODEL_TOO_COMPLEX',
      'UNSUPPORTED_FILE_FORMAT',
      'FILE_TOO_LARGE',
      'CHECKSUM_MISMATCH',
      'MALICIOUS_ARCHIVE',
      'UNITS_NOT_CONFIRMED',
      'IMPLAUSIBLE_SCALE',
      'GEOMETRY_ANALYSIS_FAILED',
      'INVALID_PRINT_CONFIGURATION',
      'DOES_NOT_FIT_BUILD_VOLUME',
      'SLICING_FAILED',
      'QUOTE_NOT_FOUND',
      'QUOTE_EXPIRED',
      'QUOTE_SUPERSEDED',
      'ORDER_NOT_FOUND',
      'INVALID_STATE_TRANSITION',
      'PAYMENT_VERIFICATION_FAILED',
      'IDEMPOTENCY_KEY_REUSED',
      'RATE_LIMITED',
      'QUOTA_EXCEEDED',
      'INTERNAL_ERROR',
    ]);
  });

  it('rejects a lowercase variant of a real code — the union is exact strings, not case-insensitive', () => {
    expect(DomainErrorCode.safeParse('quote_expired').success).toBe(false);
  });
});
