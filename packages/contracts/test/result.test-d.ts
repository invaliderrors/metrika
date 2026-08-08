import { describe, expectTypeOf, it } from 'vitest';
import { assertNever, err, isErr, isOk, ok, type Result } from '../src/index.js';

// `isOk`/`isErr` are type guards; their entire value is narrowing a
// `Result<T, E>` union down to one branch. A version that returned plain
// `boolean` (no `result is {...}` predicate) would still pass every runtime
// assertion in result.test.ts — `expect(isOk(r)).toBe(true)` cannot tell a
// genuine type predicate from a same-shaped boolean function. These tests
// exist specifically to fail if narrowing is lost: without a real predicate,
// `r` stays the full `Result<T, E>` union inside the guarded branch, and a
// union only exposes the properties common to *every* member — neither
// `.value` nor `.error` qualifies, so `r.value`/`r.error` below would not
// even compile. See the task report's break-and-restore section for the
// actual failing output this produces when the guard is deliberately broken.

// `Result` is a value type consumed by the pure kernels (pricing engine,
// authorization policies, state machines); both union members are declared
// `readonly` in src/result.ts, but nothing above reads that — narrowing tests
// only ever access `.value`/`.error`, which type-check identically whether or
// not the properties are readonly. `toEqualTypeOf` alone would not catch this
// either for two mutable-vs-mutable or two readonly-vs-readonly types, but
// expect-type's `toEqualTypeOf` specifically brands `readonly` as part of
// deep structural equality (unlike plain assignability, which ignores it),
// so pinning the full expected shape here — modifiers included — does gate on
// it. See the task report's break-and-restore section for the reproduction.
describe('Result is a readonly value type', () => {
  it('matches the declared union shape exactly, including readonly modifiers', () => {
    expectTypeOf<Result<number, string>>().toEqualTypeOf<
      { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string }
    >();
  });
});

describe('isOk narrows Result<T, E> to the ok branch', () => {
  it('exposes `.value` typed as T inside the guarded branch, `.error` in the other', () => {
    const r: Result<number, string> = ok(1);
    if (isOk(r)) {
      expectTypeOf(r.value).toEqualTypeOf<number>();
    } else {
      expectTypeOf(r.error).toEqualTypeOf<string>();
    }
  });
});

describe('isErr narrows Result<T, E> to the err branch', () => {
  it('exposes `.error` typed as E inside the guarded branch, `.value` in the other', () => {
    const r: Result<number, string> = err('boom');
    if (isErr(r)) {
      expectTypeOf(r.error).toEqualTypeOf<string>();
    } else {
      expectTypeOf(r.value).toEqualTypeOf<number>();
    }
  });
});

describe('assertNever', () => {
  it('accepts a value the compiler has exhaustively narrowed to never', () => {
    // The realistic call site: a switch over every member of a discriminated
    // union, with assertNever in `default`. If this stopped compiling,
    // assertNever's parameter type would no longer be usable for its actual
    // purpose.
    type FitResult = { kind: 'FITS' } | { kind: 'TOO_LARGE' };
    const describeFit = (f: FitResult): string => {
      switch (f.kind) {
        case 'FITS':
          return 'fits';
        case 'TOO_LARGE':
          return 'too large';
        default:
          return assertNever(f, 'FitResult');
      }
    };
    expectTypeOf(describeFit).toBeFunction();
  });

  it('rejects a non-never argument at compile time — the check that makes exhaustiveness enforcement work', () => {
    // @ts-expect-error -- assertNever's parameter is `never`; a plain string literal is not `never`
    assertNever('UNEXPECTED', 'Context');
  });
});
