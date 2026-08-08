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
  // bigint and on circular structures, and returns the *value* `undefined`
  // (not a string) for `undefined`. A diagnostic helper that itself throws a
  // different, unrelated error defeats the point of naming the context. These
  // three guard that assertNever degrades gracefully instead of crashing with
  // an opaque JSON.stringify failure.

  it('renders a bigint value instead of letting JSON.stringify throw on it', () => {
    expect(() => assertNever(10n as never, 'Ctx')).toThrow(/Ctx.*10n/s);
  });

  it('names undefined explicitly, since JSON.stringify(undefined) is not a string', () => {
    expect(() => assertNever(undefined as never, 'Ctx')).toThrow(/Ctx.*undefined/s);
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
  // The brief only spot-checks four of the twenty-six codes; without this,
  // a typo in any of the other twenty-two would go undetected forever.

  it('accepts every declared code, not just the four spot-checked above', () => {
    for (const code of DomainErrorCode.options) {
      expect(DomainErrorCode.safeParse(code).success).toBe(true);
    }
  });

  it('rejects a lowercase variant of a real code — the union is exact strings, not case-insensitive', () => {
    expect(DomainErrorCode.safeParse('quote_expired').success).toBe(false);
  });
});
