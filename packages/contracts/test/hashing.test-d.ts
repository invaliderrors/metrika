import { describe, expectTypeOf, it } from 'vitest';
import {
  canonicalJson,
  sha256Canonical,
  type CanonicalizationError,
  type CanonicalValue,
} from '../src/index.js';

// The runtime tests in hashing.test.ts exercise bigint/Date/top-level
// undefined rejection only through `as never` casts (`canonicalJson({ a: 1n }
// as never)`), which prove nothing about whether CanonicalValue itself
// excludes these types — a type assertion bypasses the checker regardless of
// what the underlying type declares, so a version of CanonicalValue that
// accidentally widened to include `bigint` would still pass every runtime
// test unchanged. These assertions close that gap directly, at the type
// level, the same way units.test-d.ts and result.test-d.ts already do for
// their own packages' brands and narrowing.
describe('CanonicalValue is exactly the documented shape', () => {
  it('accepts strings, integers, booleans and null', () => {
    expectTypeOf<'x' | 1 | true | false | null>().toExtend<CanonicalValue>();
  });

  it('accepts arrays of CanonicalValue, including nested arrays', () => {
    expectTypeOf<readonly [1, 'two', readonly [3, null]]>().toExtend<CanonicalValue>();
  });

  it('accepts objects nested to arbitrary depth', () => {
    expectTypeOf<{
      readonly a: 1;
      readonly b: { readonly c: 'x'; readonly d: readonly [1, 2] };
    }>().toExtend<CanonicalValue>();
  });

  it('allows undefined as an object property value', () => {
    expectTypeOf<{ readonly a: undefined }>().toExtend<CanonicalValue>();
  });

  it('rejects undefined at the top level, unlike as an object property value', () => {
    expectTypeOf<undefined>().not.toExtend<CanonicalValue>();
  });

  it('rejects bigint — not part of the CanonicalValue union', () => {
    expectTypeOf<bigint>().not.toExtend<CanonicalValue>();
  });

  it('rejects Date — not part of the CanonicalValue union', () => {
    expectTypeOf<Date>().not.toExtend<CanonicalValue>();
  });

  it('rejects a plain function — not part of the CanonicalValue union', () => {
    expectTypeOf<() => void>().not.toExtend<CanonicalValue>();
  });
});

describe('canonicalJson and sha256Canonical signatures', () => {
  it('canonicalJson returns a plain string', () => {
    expectTypeOf(canonicalJson).returns.toEqualTypeOf<string>();
  });

  it('sha256Canonical returns a Promise<string>, not a bare string — it is genuinely async', () => {
    expectTypeOf(sha256Canonical).returns.toEqualTypeOf<Promise<string>>();
  });

  it('CanonicalizationError is a real Error subclass', () => {
    expectTypeOf<CanonicalizationError>().toExtend<Error>();
  });
});
