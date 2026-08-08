/**
 * `Result<T, E>` is for the pure kernels — the pricing engine, authorization
 * policies, state machines — where failure is expected, enumerable, and part
 * of the contract, so every caller must handle it. Exceptions remain for
 * failures that propagate to the transport boundary; the two coexist
 * deliberately. See docs/ARCHITECTURE.md.
 *
 * Deliberately minimal: no `map`/`unwrap`/`andThen` combinators. Add one when
 * a caller actually needs it, not speculatively.
 */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(
  result: Result<T, E>,
): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(
  result: Result<T, E>,
): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/**
 * Compile-time exhaustiveness guard for discriminated unions. The parameter
 * type `never` is the entire mechanism: once every member of a union has
 * been handled (by a switch's `case`s, or a chain of `if`/`else`), the
 * compiler narrows what's left to `never`. Passing anything else — because a
 * new union member was added and this call site wasn't updated — is a
 * compile error at every `assertNever` call, which is what makes discriminated
 * unions safe to extend across this codebase's fit results, state machines,
 * pricing components and error codes.
 *
 * At runtime, though, `never` is not a real value — TypeScript's types are
 * erased, so whatever actually reaches this function is whatever the union
 * grew to include without every consumer being updated. `JSON.stringify`,
 * naively applied to that, throws a `TypeError` on `bigint` and on circular
 * structures, and returns the *value* `undefined` (not a string) for
 * `undefined` — three ways a diagnostic meant to name the offending value
 * would instead crash with an unrelated, less useful error, or silently
 * print nothing. `describeUnhandledValue` treats the input as `unknown` and
 * degrades gracefully in all three cases instead.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled case in ${context}: ${describeUnhandledValue(value)}`);
}

function describeUnhandledValue(value: never): string {
  const unknownValue: unknown = value;
  if (typeof unknownValue === 'undefined') return 'undefined';
  if (typeof unknownValue === 'bigint') return `${unknownValue.toString()}n`;
  try {
    return JSON.stringify(unknownValue);
  } catch {
    // Circular structures (and anything else JSON.stringify refuses) fall
    // back to naming the runtime type rather than calling `String()` on an
    // arbitrary object — `String({})` degrades to the uninformative
    // "[object Object]" for any plain object regardless of its actual shape,
    // which is no more useful than the crash it would replace.
    return `[unserializable ${typeof unknownValue}]`;
  }
}
