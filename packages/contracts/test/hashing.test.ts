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

  // --- Fix round 1: sparse array holes (Finding 1, Critical) ---
  //
  // `Array.prototype.map` skips holes but preserves them positionally, and
  // `Array.prototype.join` renders a hole as the empty string — so, without an
  // explicit own-property check per index, `[]` and `new Array(1)` serialise
  // identically. That is a genuine collision between two different runtime
  // values reachable through the typed public API with no cast: `new
  // Array<number>(1)` is a well-typed `CanonicalValue`. A hole is rejected the
  // same way an explicit `undefined` array element already is, since both
  // read as `undefined` and the type system cannot tell them apart.

  it('rejects a sparse array created by new Array(n) — a hole is not an own property', () => {
    expect(() => canonicalJson(new Array<number>(1) as never)).toThrow(CanonicalizationError);
  });

  it('[] still serialises normally — only holes are rejected, not empty arrays', () => {
    expect(canonicalJson([])).toBe('[]');
  });

  it('rejects new Array(3) — multiple holes, not just a single one', () => {
    expect(() => canonicalJson(new Array<number>(3) as never)).toThrow(CanonicalizationError);
  });

  it('rejects a hole created by extending .length past the end of a dense array', () => {
    const arr: number[] = [1, 2];
    arr.length = 4;
    expect(() => canonicalJson(arr as never)).toThrow(CanonicalizationError);
  });

  it('rejects a hole created by delete on an array element', () => {
    const arr: (number | undefined)[] = [1, 2, 3];
    // `delete arr[1]` and `Reflect.deleteProperty(arr, 1)` are the same
    // [[Delete]] operation; the latter sidesteps
    // @typescript-eslint/no-array-delete without changing what is tested —
    // this genuinely leaves a hole, not an `undefined` element.
    Reflect.deleteProperty(arr, 1);
    expect(() => canonicalJson(arr as never)).toThrow(CanonicalizationError);
  });

  // --- Fix round 1: array elements that are explicit undefined (Finding 2) ---
  //
  // This behaviour was already correct before this fix round — an explicit
  // `undefined` array element (as opposed to a hole) already threw — but
  // nothing exercised it, and the natural-looking "fix" of adding
  // `.filter((v) => v !== undefined)` to the array branch, mirroring the
  // object branch a few lines below, would silently make `[1, undefined, 2]`
  // and `[1, 2]` collide. These tests exist specifically to gate that.

  it('rejects an explicit undefined array element', () => {
    expect(() => canonicalJson([undefined] as never)).toThrow(CanonicalizationError);
  });

  it('[1, undefined, 2] throws rather than collapsing to [1, 2]', () => {
    expect(() => canonicalJson([1, undefined, 2] as never)).toThrow(CanonicalizationError);
    expect(canonicalJson([1, 2])).toBe('[1,2]');
  });

  it('rejects undefined inside an array nested in an object', () => {
    expect(() => canonicalJson({ a: [undefined] } as never)).toThrow(CanonicalizationError);
  });

  // --- Fix round 1: accessor properties and Proxies (Finding 3, Important) ---
  //
  // `Object.getPrototypeOf(value) !== Object.prototype` only rules out class
  // instances and null-prototype objects — a getter on an otherwise-plain
  // object literal still has `Object.prototype` in its chain and passes that
  // check, yet re-invoking it can return a different value on every read,
  // producing a different hash for what looks like "the same" object. The fix
  // inspects `Object.getOwnPropertyDescriptors` and rejects any descriptor
  // without a `value` key (i.e. an accessor) instead of reading through
  // `Object.entries`/bracket access, which would invoke the getter.

  it('rejects an accessor (getter) property without ever invoking it', () => {
    let calls = 0;
    const withGetter = {
      get a() {
        calls++;
        return calls;
      },
    };
    expect(() => canonicalJson(withGetter)).toThrow(CanonicalizationError);
    // If this were > 0, the getter was invoked despite being rejected — the
    // whole point of detecting it via the property descriptor instead of by
    // reading the value is to never execute the accessor at all.
    expect(calls).toBe(0);
  });

  it('rejects a setter-only accessor property', () => {
    const withSetter: Record<string, unknown> = {};
    Object.defineProperty(withSetter, 'a', {
      set: (_v: unknown) => undefined,
      enumerable: true,
      configurable: true,
    });
    expect(() => canonicalJson(withSetter as never)).toThrow(CanonicalizationError);
  });

  it('produces stable output for a Proxy wrapping a plain object, and never triggers its get trap', () => {
    let getTrapCalls = 0;
    const target = { a: 1, b: 2 };
    const proxy = new Proxy(target, {
      get(t, prop, receiver): unknown {
        getTrapCalls++;
        return Reflect.get(t, prop, receiver) as unknown;
      },
    });
    const first = canonicalJson(proxy);
    const second = canonicalJson(proxy);
    expect(first).toBe(second);
    expect(first).toBe('{"a":1,"b":2}');
    // Descriptor-based access (`Object.getOwnPropertyDescriptors`) never
    // triggers the `get` trap — only `ownKeys`/`getOwnPropertyDescriptor`,
    // which this proxy does not override. A `get`-trap-based proxy that
    // returned a different value per read would otherwise have produced two
    // different hashes for what callers would reasonably treat as one value.
    expect(getTrapCalls).toBe(0);
  });

  // --- Fix round 2: accessor properties on array INDICES (Finding 1, Critical) ---
  //
  // Fix round 1 applied the descriptor-based accessor check to the object
  // branch but left the array branch reading elements via `arr[i]`, i.e.
  // `[[Get]]` — the exact same defect class the object-branch fix was meant
  // to close, just on the other container type. `number[]` is a well-typed
  // `CanonicalValue`; no cast, no Proxy needed to reach this.

  it('rejects an accessor (getter) defined on an array index without ever invoking it', () => {
    let calls = 0;
    const arr: number[] = [];
    Object.defineProperty(arr, 0, {
      get() {
        calls++;
        return calls;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => canonicalJson(arr)).toThrow(CanonicalizationError);
    // Same discipline as the object case: detection must happen via the
    // property descriptor, never by reading (and thereby invoking) the value.
    expect(calls).toBe(0);
  });

  it('rejects a setter-only accessor defined on an array index', () => {
    const arr: number[] = [];
    Object.defineProperty(arr, 0, {
      set: (_v: unknown) => undefined,
      enumerable: true,
      configurable: true,
    });
    expect(() => canonicalJson(arr)).toThrow(CanonicalizationError);
  });

  it('produces stable output for a Proxy wrapping a plain array, and never triggers its get trap', () => {
    let getTrapCalls = 0;
    const target = [1, 2, 3];
    const proxy = new Proxy(target, {
      get(t, prop, receiver): unknown {
        getTrapCalls++;
        return Reflect.get(t, prop, receiver) as unknown;
      },
    });
    const first = canonicalJson(proxy);
    const second = canonicalJson(proxy);
    expect(first).toBe(second);
    expect(first).toBe('[1,2,3]');
    // Mirrors the object-Proxy test above: descriptor-based array access
    // must not trigger the `get` trap either. Fix round 1's JSDoc claimed
    // this already held for "a Proxy's get trap" without qualifying it to
    // objects only — this test is what makes that claim true for arrays too.
    expect(getTrapCalls).toBe(0);
  });

  it('rejects an array-like Proxy whose length descriptor is misreported rather than silently truncating to []', () => {
    // The length is read via `Object.getOwnPropertyDescriptor(arr, 'length')`
    // rather than `arr.length` specifically so a Proxy cannot make the array
    // branch perform a `[[Get]]`. That means an adversarial Proxy overriding
    // the `getOwnPropertyDescriptor` trap itself — not `get` — can still
    // misreport `length`. This is exactly the deliberately adversarial Proxy
    // case documented as a known, accepted limit: it is not silently treated
    // as an empty array (which would itself be a collision with a genuine
    // `[]`), it throws.
    //
    // The reported descriptor must keep `configurable: false` — array
    // `length` really is non-configurable, and a Proxy is not permitted to
    // lie about that invariant (the engine throws a native `TypeError` if it
    // tries). `length` is writable, though, so the invariant does permit
    // reporting a different `value` for it, which is what this test does.
    const target: number[] = [1, 2, 3];
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(t, prop) {
        if (prop === 'length') {
          return { value: 'not-a-number', writable: true, enumerable: false, configurable: false };
        }
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
    });
    expect(() => canonicalJson(proxy)).toThrow(CanonicalizationError);
  });

  // --- Fix round 2: the `enumerable` filter is load-bearing (Finding 2, Important) ---
  //
  // `Object.getOwnPropertyDescriptors` includes non-enumerable own
  // properties, which `Object.entries` (the pre-round-1 access path) never
  // did. Without the `.filter(([, d]) => d.enumerable)` line, a non-enumerable
  // own property would leak into the output where it was previously and
  // correctly absent — silently changing the hash of any object carrying one.

  it('drops a non-enumerable own property, matching pre-fix Object.entries behaviour', () => {
    const withHidden: Record<string, unknown> = { a: 1 };
    Object.defineProperty(withHidden, 'hidden', {
      value: 'should not appear',
      enumerable: false,
      configurable: true,
    });
    expect(canonicalJson(withHidden as never)).toBe('{"a":1}');
  });

  // --- Fix round 2: documented, pre-existing, unchanged behaviours ---
  //
  // Both were already true before fix round 1 and are not defects — they
  // just belong in the JSDoc alongside the other documented normalisations
  // so the comment describes what the function actually does.

  it('drops extra non-index own properties attached to an array', () => {
    const withExtra = Object.assign([1, 2], { foo: 'bar' });
    expect(canonicalJson(withExtra)).toBe(canonicalJson([1, 2]));
  });

  it('drops symbol-keyed own properties', () => {
    const sym = Symbol('hidden');
    const withSymbol: Record<string, unknown> = { a: 1 };
    (withSymbol as Record<string | symbol, unknown>)[sym] = 'should not appear';
    expect(canonicalJson(withSymbol as never)).toBe('{"a":1}');
  });

  // --- Fix round 1: -0 (Finding 4, minor — documented, not changed) ---
  //
  // `(-0).toString() === '0'`, same as `JSON.stringify(-0) === '0'`. This is
  // an intentional normalisation, unlike the Unicode case: `-0 === 0` in JS
  // and they denote the same real number, so collapsing them is not a
  // collision between distinct inputs the way normalising Unicode would be.

  it('serialises -0 the same as 0 — same real number, not a collision', () => {
    expect(canonicalJson({ a: -0 })).toBe('{"a":0}');
    expect(canonicalJson({ a: -0 })).toBe(canonicalJson({ a: 0 }));
  });

  // --- Fix round 1: exponential-notation integers (Finding 6, minor) ---
  //
  // `Number.isInteger` is true for integers large enough that
  // `Number.prototype.toString` renders them in exponential form. This is
  // still valid, round-trip-stable JSON — not a correctness bug — just a
  // visual mismatch with the "non-integer numbers are rejected" doc wording,
  // which is about fractional/non-finite values, not decimal vs. exponential
  // notation.

  it('accepts an integer large enough to serialise in exponential notation', () => {
    expect(canonicalJson({ a: 1e21 })).toBe('{"a":1e+21}');
    expect(() => JSON.parse(canonicalJson({ a: 1e21 })) as unknown).not.toThrow();
  });

  // --- Fix round 1: circular references and pathological depth (Finding 5) ---
  //
  // Without a depth guard, a circular reference recurses until the platform
  // itself throws a native `RangeError` — a different, untyped failure mode
  // that a caller catching only `CanonicalizationError` would not catch.

  it('rejects a circular reference with CanonicalizationError, not RangeError', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    expect(() => canonicalJson(obj as never)).toThrow(CanonicalizationError);
  });

  it('rejects pathologically deep (but non-circular) nesting with CanonicalizationError, not RangeError', () => {
    let value: unknown = [];
    for (let i = 0; i < 2000; i++) {
      value = [value];
    }
    expect(() => canonicalJson(value as never)).toThrow(CanonicalizationError);
  });

  it('still allows nesting well within the depth guard', () => {
    let value: unknown = 0;
    for (let i = 0; i < 50; i++) {
      value = [value];
    }
    expect(() => canonicalJson(value as never)).not.toThrow();
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

  // --- Fix round 1: sparse array holes must not produce a shared cache key (Finding 1) ---
  //
  // Before the fix, `sha256Canonical([])` and `sha256Canonical(new Array(1))`
  // both digested the same bytes — `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`
  // (sha256 of the exact byte sequence `[]`, both times) — because the hole
  // was silently dropped by `.join`. That is the slice-cache-key collision
  // this fix closes: two different manufacturing inputs must never produce
  // one key. After the fix, `[]` still hashes normally and `new Array(1)`
  // rejects instead of silently colliding with it.

  it('[] still hashes to the real digest of "[]"', async () => {
    expect(await sha256Canonical([])).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
  });

  it('new Array(1) rejects instead of silently colliding with the digest of []', async () => {
    await expect(sha256Canonical(new Array<number>(1) as never)).rejects.toThrow(
      CanonicalizationError,
    );
  });
});
