import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalJson, sha256Canonical } from '../src/index.js';
import type { CanonicalValue } from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('emits no whitespace', () => {
    expect(canonicalJson({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });

  it('omits undefined object values', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('preserves null', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('rejects non-integer numbers — decimals must be passed as strings', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow(CanonicalizationError);
  });

  it('rejects NaN', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalizationError);
  });

  it('rejects Infinity', () => {
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
  });

  it('rejects bigint — convert explicitly to avoid 1n/"1" collisions', () => {
    expect(() => canonicalJson({ a: 1n } as never)).toThrow(CanonicalizationError);
  });

  it('rejects Date — pass an ISO string', () => {
    expect(() => canonicalJson({ a: new Date(0) } as never)).toThrow(CanonicalizationError);
  });

  it('rejects a top-level undefined', () => {
    expect(() => canonicalJson(undefined as never)).toThrow(CanonicalizationError);
  });

  // Deviation from the brief's literal Step 1 snippet: both property tests
  // below add `{ noNullPrototype: true }` to their `fc.dictionary(...)`
  // calls. Without it, fast-check's `dictionary` combinator (since 3.13.0,
  // and present in the pinned 4.9.0) generates a null-prototype object via
  // `Object.create(null)` on roughly half of its samples, as a deliberate
  // fuzzing feature unrelated to this test's intent. canonicalJson correctly
  // rejects those (see the dedicated `Object.create(null)` test above), so
  // with the default 100 runs per property, the brief's literal snippet fails
  // deterministically in practice (~1 - 0.5^100 chance of hitting at least
  // one), not occasionally — confirmed by five repeated runs, all failing the
  // same way. This constraint keeps the test verifying key-order insensitivity
  // and determinism, not re-testing the null-prototype rejection these two
  // tests were never meant to cover.
  it('is insensitive to key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer(), { noNullPrototype: true }), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(obj)).toBe(canonicalJson(reversed));
      }),
    );
  });

  it('is deterministic across repeated calls', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean()), {
          noNullPrototype: true,
        }),
        (obj) => {
          expect(canonicalJson(obj)).toBe(canonicalJson(obj));
        },
      ),
    );
  });

  // --- Additional edge cases and collision-hunting, beyond the brief ---
  //
  // Task 9's brief only names the eleven runtime cases and two property tests
  // above. The task instructions require actively trying to construct two
  // different inputs that produce the same canonical string — sha256Canonical
  // computes the slice cache key, and a collision there silently serves one
  // model's manufacturing metrics for another model's quote. Every test below
  // is a specific collision attempt, and each is annotated with what it would
  // have proven if the strings below turned out equal.

  it('names the thrown error CanonicalizationError, not the generic Error', () => {
    // Mirrors the same vacuity-trap concern already fixed once in this
    // package for MoneyMismatchError: `toThrow(CanonicalizationError)` only
    // checks `instanceof`, which still passes if `.name` regresses to the
    // inherited "Error" — a divergence that would corrupt serialised logs.
    try {
      canonicalJson({ a: 1.5 });
      expect.unreachable('canonicalJson should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalizationError);
      expect((err as CanonicalizationError).name).toBe('CanonicalizationError');
    }
  });

  it('rejects a class instance — only plain objects serialise', () => {
    class Point {
      x = 1;
      y = 2;
    }
    expect(() => canonicalJson(new Point() as never)).toThrow(CanonicalizationError);
  });

  it('rejects Object.create(null) — no prototype is not the plain-object prototype', () => {
    const nullProto: Record<string, number> = Object.create(null) as Record<string, number>;
    nullProto['a'] = 1;
    expect(() => canonicalJson(nullProto as never)).toThrow(CanonicalizationError);
  });

  it('rejects bigint nested inside an array, not just as a top-level object value', () => {
    expect(() => canonicalJson([1, 2n] as never)).toThrow(CanonicalizationError);
  });

  it('rejects a function value', () => {
    expect(() => canonicalJson({ a: () => 1 } as never)).toThrow(CanonicalizationError);
  });

  it('rejects a symbol value', () => {
    expect(() => canonicalJson({ a: Symbol('x') } as never)).toThrow(CanonicalizationError);
  });

  // Collision attempt: [] and {} both have "nothing inside the brackets" —
  // confirm the array/object distinction survives at the empty-container edge.
  it('[] and {} produce different output', () => {
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).not.toBe(canonicalJson({}));
  });

  // Collision attempt: an array of integers vs. the same digits as strings.
  // If number and string serialisation ever converged (e.g. numbers were
  // quoted, or strings were emitted unquoted), these would collide.
  it('[1,2] and ["1","2"] produce different output', () => {
    expect(canonicalJson([1, 2])).toBe('[1,2]');
    expect(canonicalJson(['1', '2'])).toBe('["1","2"]');
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson(['1', '2']));
  });

  // Collision attempt: a single key containing literal ":" and "," characters
  // vs. two separate keys that, if key encoding used raw concatenation
  // instead of JSON.stringify, could produce indistinguishable output.
  it('a key containing ":" and "," cannot collide with two separate keys', () => {
    expect(canonicalJson({ 'a:1,b': 2 })).toBe('{"a:1,b":2}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ 'a:1,b': 2 })).not.toBe(canonicalJson({ a: 1, b: 2 }));
  });

  // Collision attempt: a key containing a literal quote and a literal
  // backslash. If key encoding did not escape these (i.e. used raw string
  // concatenation instead of JSON.stringify), the emitted bytes could be
  // ambiguous with a different key/value split.
  it('escapes a key containing a quote and a backslash', () => {
    const rawKey = 'a"b\\c'; // the literal five characters: a " b \ c
    expect(canonicalJson({ [rawKey]: 1 })).toBe('{"a\\"b\\\\c":1}');
  });

  // Collision attempt: a string value that looks like a nested JSON object
  // vs. an actual nested object with the same logical content. JSON string
  // escaping keeps these unambiguous (the string value's quotes are
  // themselves escaped), but this is exactly the shape of bug that would
  // let a manufacturing input smuggle a fake structure into the hash input.
  it('a string value containing structural JSON characters cannot collide with a nested object', () => {
    expect(canonicalJson({ a: '{"b":1}' })).toBe('{"a":"{\\"b\\":1}"}');
    expect(canonicalJson({ a: { b: 1 } })).toBe('{"a":{"b":1}}');
    expect(canonicalJson({ a: '{"b":1}' })).not.toBe(canonicalJson({ a: { b: 1 } }));
  });

  // Sorting must use explicit `<`/`>` (UTF-16 code unit order), not
  // `localeCompare`, which is locale-dependent and would sort differently
  // on a machine with a different default locale — an unstable cache key.
  // "é" (U+00E9) sorts after "f" by code unit (233 > 102) but *before* "f"
  // under `String.prototype.localeCompare` in common locales, since a
  // locale-aware collation treats "é" as a variant of "e". This test fails
  // under a `localeCompare`-based sort and passes under code-unit `<`/`>`.
  it('sorts non-ASCII keys by UTF-16 code unit, not locale-aware collation', () => {
    // Typed as `string`, not the string-literal type `const` would otherwise
    // infer: with a literal type, the type checker can resolve `'f' < composed`
    // to a statically-known boolean, which `no-unnecessary-condition` then
    // flags as an unnecessary conditional — correctly, in general, but not
    // useful here, where the point of the assertion is precisely to pin this
    // specific runtime comparison result as a named test.
    const composed: string = 'é'; // "é" as a single precomposed code point
    expect('f'.localeCompare(composed)).toBeGreaterThan(0); // locale: "é" before "f"
    expect('f' < composed).toBe(true); // code unit: "f" before "é"
    expect(canonicalJson({ [composed]: 2, f: 1 })).toBe(`{"f":1,"${composed}":2}`);
  });

  it('sorts a broader mix of ASCII and non-ASCII keys purely by code unit', () => {
    const composed = 'é';
    expect(canonicalJson({ a: 1, B: 2, _: 3, [composed]: 4 })).toBe(
      `{"B":2,"_":3,"a":1,"${composed}":4}`,
    );
  });

  // Unicode normalisation: composed "é" (U+00E9, one UTF-16 code unit) and
  // decomposed "é" (U+0065 U+0301, "e" + combining acute accent, two code
  // units) are different JS string values — different `Object.keys` entries,
  // different byte sequences. We deliberately do NOT normalise keys before
  // sorting or serialising. Reasoning: normalising would mean two *different*
  // programmatic inputs (JS does not treat these strings as equal, and never
  // silently merges same-object properties written in both forms) collapse
  // onto identical output — which is a real collision, not a false one, and
  // exactly the failure mode this whole module exists to prevent. Not
  // normalising means "same logical input" trivially implies "same bytes",
  // because we never transform the input at all; the cost is that a producer
  // who accidentally emits the "wrong" normalisation form for what should be
  // the same manufacturing input gets a cache miss, not a wrong price — the
  // same "annoying but visible" failure mode the module's own documentation
  // prefers over a silent wrong answer.
  it('does not Unicode-normalise keys — composed and decomposed forms stay distinct', () => {
    const composed = 'é'; // é, one code unit
    const decomposed = 'é'; // e + combining acute accent, two code units
    expect(composed).not.toBe(decomposed); // sanity: JS itself treats these as different strings
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC')); // but they ARE the same grapheme
    expect(canonicalJson({ [composed]: 1 })).not.toBe(canonicalJson({ [decomposed]: 1 }));
  });

  it('does not Unicode-normalise string values either', () => {
    const composed = 'é';
    const decomposed = 'é';
    expect(canonicalJson({ a: composed })).not.toBe(canonicalJson({ a: decomposed }));
  });

  // Collision attempt via prototype pollution: a plain-looking object literal
  // with a non-computed `__proto__` key does not create an own property at
  // all — it reassigns the object's actual [[Prototype]] (an ECMAScript
  // object-literal special case, Annex B.3.1). If canonicalJson ever switched
  // from `Object.entries` (own enumerable properties only) to something that
  // walked inherited properties, or treated "no own keys" as unconditionally
  // `{}`, an attacker-supplied object could smuggle a value past
  // serialisation entirely, colliding with the genuine empty object.
  it('rejects an object whose [[Prototype]] was reassigned via object-literal __proto__ syntax', () => {
    const poisoned = { __proto__: { hidden: 'value' } } as unknown as Record<string, unknown>;
    expect(Object.keys(poisoned)).toEqual([]); // sanity: no own property was created
    expect(Object.getPrototypeOf(poisoned)).not.toBe(Object.prototype); // sanity: the prototype WAS reassigned
    expect(() => canonicalJson(poisoned as never)).toThrow(CanonicalizationError);
  });

  // The converse: a key genuinely, legitimately named "__proto__" — created
  // via Object.fromEntries/JSON.parse, which use [[DefineOwnProperty]] and so
  // are immune to the assignment-triggers-the-inherited-setter footgun above
  // — must still serialise correctly, since it's a real own property.
  it('serialises a genuine own property literally named "__proto__"', () => {
    const withRealProtoKey = Object.fromEntries([['__proto__', 1]]) as Record<string, number>;
    expect(Object.getPrototypeOf(withRealProtoKey)).toBe(Object.prototype); // sanity: not poisoned
    expect(canonicalJson(withRealProtoKey)).toBe('{"__proto__":1}');
  });

  // --- Property tests beyond the brief ---
  //
  // A bounded-depth recursive arbitrary over the full CanonicalValue shape
  // (not just flat dictionaries of integers, as in the brief's two property
  // tests), used to check structural properties that only emerge with
  // nesting: valid-JSON-ness and round-trip stability.
  //
  // `noNullPrototype: true` is required: fast-check's `dictionary` combinator
  // deliberately builds some of its generated objects via `Object.create(null)`
  // rather than the `{}` object literal (a documented fuzzing feature, to
  // exercise code that assumes every object inherits from `Object.prototype`).
  // The CanonicalValue *type* can't distinguish this at compile time — a
  // null-prototype object structurally satisfies `{ readonly [k: string]:
  // CanonicalValue | undefined }` — but canonicalJson correctly rejects it at
  // runtime (see the dedicated `Object.create(null)` test above); this
  // constraint keeps these general structural-property tests about
  // canonicalJson's behaviour on values it accepts, since that rejection is
  // already covered on its own. (Initially misdiagnosed this as a `__proto__`
  // key/assignment footgun; reading fast-check's own dictionary source
  // showed it already special-cases a literal `"__proto__"` key with
  // `Object.defineProperty`, precisely to avoid that footgun — the
  // `noNullPrototype` fuzzing feature was the actual, unrelated cause.)
  const { value: canonicalValueArbitrary } = fc.letrec<{ value: CanonicalValue }>((tie) => ({
    value: fc.oneof(
      { depthSize: 'small' },
      fc.integer(),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.array(tie('value'), { maxLength: 4 }),
      fc.dictionary(fc.string(), tie('value'), { maxKeys: 4, noNullPrototype: true }),
    ),
  }));

  it('always produces a string that parses as valid JSON', () => {
    fc.assert(
      fc.property(canonicalValueArbitrary, (value) => {
        expect(() => JSON.parse(canonicalJson(value)) as unknown).not.toThrow();
      }),
    );
  });

  it('is stable under a parse/re-serialise round trip', () => {
    fc.assert(
      fc.property(canonicalValueArbitrary, (value) => {
        const once = canonicalJson(value);
        const roundTripped = JSON.parse(once) as CanonicalValue;
        expect(canonicalJson(roundTripped)).toBe(once);
      }),
    );
  });

  it('is insensitive to key insertion order for arbitrarily nested values', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), canonicalValueArbitrary, { maxKeys: 4, noNullPrototype: true }),
        (obj) => {
          const reversed = Object.fromEntries(Object.entries(obj).reverse());
          expect(canonicalJson(obj)).toBe(canonicalJson(reversed));
        },
      ),
    );
  });
});

describe('sha256Canonical', () => {
  it('produces 64 lowercase hex characters', async () => {
    expect(await sha256Canonical({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the known digest of the canonical bytes', async () => {
    // sha256 of the exact byte sequence: {"a":1}
    // Verified independently with: printf '%s' '{"a":1}' | shasum -a 256
    // Hardcoded deliberately — see the brief's own note on this test.
    expect(await sha256Canonical({ a: 1 })).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
  });

  it('gives identical digests for differently ordered but equal objects', async () => {
    expect(await sha256Canonical({ b: 1, a: 2 })).toBe(await sha256Canonical({ a: 2, b: 1 }));
  });

  it('gives different digests for different values', async () => {
    // sha256 of the exact byte sequence: {"a":2}
    // Verified independently with: printf '%s' '{"a":2}' | shasum -a 256
    expect(await sha256Canonical({ a: 2 })).toBe(
      '7e8059f495589fcd981232cc11d00b00da3802c01d688fa1cf1f6bed6e5bb33c',
    );
    expect(await sha256Canonical({ a: 1 })).not.toBe(await sha256Canonical({ a: 2 }));
  });

  // --- Additional cases beyond the brief ---

  it('is deterministic across repeated calls on the same value', async () => {
    const value = { z: [1, 2, { y: 'x' }], a: null };
    expect(await sha256Canonical(value)).toBe(await sha256Canonical(value));
  });

  it('propagates CanonicalizationError for invalid input rather than hashing garbage', async () => {
    await expect(sha256Canonical({ a: 1.5 })).rejects.toThrow(CanonicalizationError);
  });

  it('propagates CanonicalizationError for a rejected bigint', async () => {
    await expect(sha256Canonical({ a: 1n } as never)).rejects.toThrow(CanonicalizationError);
  });
});
