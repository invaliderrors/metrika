export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

// Chosen to be far below the platform's native recursion limit (empirically
// ~10,000 stack frames for a trivial function on this runtime, and this
// function's frames are heavier) while remaining generous for any real
// manufacturing input. A circular reference recurses until this is exceeded
// and is rejected the same as pathologically deep, non-circular nesting —
// both would otherwise surface as a native, untyped `RangeError` instead of
// `CanonicalizationError`.
const MAX_DEPTH = 1000;

/**
 * Deterministic JSON: keys sorted, no whitespace, undefined object values
 * omitted. Non-integer numbers are REJECTED — floats are not reproducible
 * across platforms, and this function backs the slice cache key, where an
 * unstable hash silently serves wrong manufacturing metrics. Pass decimals as
 * strings. bigint and Date are rejected so callers convert explicitly rather
 * than relying on a coercion that could collide (1n and "1").
 *
 * Object keys are sorted by explicit `<`/`>` comparison, i.e. UTF-16 code
 * unit order — never `localeCompare`, which is locale-dependent and would
 * make the output (and therefore the hash) vary by the machine's locale.
 * Object and array keys are encoded with `JSON.stringify`, not raw string
 * concatenation, so a key containing `"`, `\`, `:` or `,` is escaped and
 * cannot be mistaken for structural JSON syntax by anything that parses the
 * output. Unicode normalisation is deliberately NOT applied: composed and
 * decomposed forms of the same grapheme are different JS string values, and
 * collapsing them onto identical output would be a genuine collision between
 * two distinct inputs, which is exactly the failure this module exists to
 * prevent.
 *
 * `-0` serialises as `0`, the same as `Number.prototype.toString` and
 * `JSON.stringify` — a deliberate normalisation, unlike the Unicode case
 * above: `-0 === 0` in JS and they denote the same real number, so this
 * collapses two representations of one value rather than colliding two
 * distinct ones. Separately, `Number.isInteger` accepts integers large enough
 * that `toString` renders them in exponential notation (e.g. `1e21` →
 * `"1e+21"`); that output is still valid, round-trip-stable JSON, so it is
 * accepted — "non-integer numbers are rejected" is about fractional and
 * non-finite values, not decimal-vs-exponential formatting.
 *
 * Every array index must be an own property. `Array.prototype.map` skips a
 * hole (from `new Array(n)`, `arr.length = n`, or `delete arr[i]`) but
 * `Array.prototype.join` still renders its slot as empty — so without an
 * explicit per-index check, `[]` and `new Array(1)` would serialise
 * identically. A hole is rejected the same way an explicit `undefined` array
 * element already is, since both read as `undefined` and are otherwise
 * indistinguishable. Extra own properties attached to an array outside its
 * index range (e.g. `Object.assign([1, 2], {foo: 'bar'})`) are not
 * serialised — only indices `0` to `length - 1` are — and any symbol-keyed
 * own property, on an array or a plain object, is silently dropped, the same
 * as `JSON.stringify`: symbol keys are never visited by `Object.entries` (nor
 * by `Object.keys`/`Object.values`), regardless of what produced the object.
 *
 * Only own data properties are serialised, for both object values and array
 * elements. An accessor (`get`/`set`) is rejected — via
 * `Object.getOwnPropertyDescriptor(s)`, never invoked — rather than read,
 * because invoking it could return a different value on every call, making
 * one logical value hash differently each time. Detecting accessors this
 * way, instead of through `Object.entries`/bracket access, also means a
 * `Proxy`'s `get` trap is never triggered — by reading a property OR an array
 * index OR an array's `length` — so a proxy that would otherwise return
 * different values per read cannot destabilise the hash through that path.
 * This is a defence against a proxy overriding `get`, specifically; a proxy
 * that instead overrides `getOwnPropertyDescriptor` or `ownKeys` themselves
 * to report different descriptors or key sets on each call is a known,
 * accepted limit — closing that would mean distrusting the descriptor
 * protocol itself, which is where this module's inspection necessarily
 * bottoms out. No realistic manufacturing input constructs such a proxy.
 *
 * Nesting deeper than {@link MAX_DEPTH} — including a circular reference — is
 * rejected as `CanonicalizationError` rather than being left to surface as a
 * native `RangeError`, so a caller that catches only this module's typed
 * error does not also need to catch `RangeError` to be safe.
 */
export function canonicalJson(value: CanonicalValue): string {
  return serialize(value, '$', 0);
}

function serialize(value: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError(
      `Exceeded maximum nesting depth of ${MAX_DEPTH.toString()} at ${path}; this is also how a circular reference is rejected`,
    );
  }

  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`Non-finite number at ${path}`);
      }
      if (!Number.isInteger(value)) {
        throw new CanonicalizationError(`Non-integer number at ${path}; pass decimals as strings`);
      }
      return value.toString();
    case 'object':
      break;
    case 'bigint':
    case 'symbol':
    case 'undefined':
    case 'function':
      throw new CanonicalizationError(`Unsupported type ${typeof value} at ${path}`);
  }

  if (Array.isArray(value)) {
    const arr = value as readonly unknown[];
    // Reading `.length` directly (`arr.length`) is itself a `[[Get]]`, which
    // invokes a Proxy's `get` trap exactly as reading an element would — so
    // the length is read via its own property descriptor too. Without this,
    // every element could go through `Object.getOwnPropertyDescriptor` and
    // the array branch would still perform one `[[Get]]` per serialise call,
    // leaving a narrow gap in the "never invokes `[[Get]]`" guarantee below.
    const lengthDescriptor = Object.getOwnPropertyDescriptor(arr, 'length');
    if (typeof lengthDescriptor?.value !== 'number') {
      // Unreachable for a real array, and for a Proxy wrapping one that
      // doesn't override `getOwnPropertyDescriptor` — every array has an own
      // numeric `length`. A Proxy that overrides that trap specifically to
      // misreport it is the deliberately adversarial case documented on
      // `canonicalJson` as a known, accepted limit; failing loudly here
      // rather than silently treating it as an empty array avoids that
      // silent-collision case being worse than this thrown error.
      throw new CanonicalizationError(`Array-like value at ${path} has no numeric length`);
    }
    const length = lengthDescriptor.value;
    const items: string[] = [];
    for (let i = 0; i < length; i++) {
      // `Object.getOwnPropertyDescriptor`, not bracket access (`arr[i]`):
      // reading an index via `[[Get]]` invokes an accessor defined on that
      // index (or a Proxy's `get` trap) the same way bracket access on an
      // object property would — the array branch needs the identical
      // discipline as the object branch below, for the identical reason. A
      // missing descriptor is the hole case (replacing a separate
      // `Object.hasOwn` lookup with this one); a descriptor present but
      // lacking `value` is the accessor case.
      const descriptor = Object.getOwnPropertyDescriptor(arr, i);
      if (descriptor === undefined) {
        throw new CanonicalizationError(`Sparse array hole at ${path}[${i.toString()}]`);
      }
      if (!('value' in descriptor)) {
        throw new CanonicalizationError(
          `Accessor property at ${path}[${i.toString()}]; only data properties are supported`,
        );
      }
      items.push(serialize(descriptor.value as unknown, `${path}[${i.toString()}]`, depth + 1));
    }
    return `[${items.join(',')}]`;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CanonicalizationError(`Only plain objects are supported, at ${path}`);
  }

  // `Object.getOwnPropertyDescriptors`, not `Object.entries`/bracket access:
  // reading a data property's descriptor never invokes user code, whereas
  // `value[key]` invokes an accessor's getter (or a Proxy's `get` trap) —
  // either of which could legitimately return something different on every
  // call, making one object hash differently each time it is serialised.
  const descriptors = Object.getOwnPropertyDescriptors(value);

  // Two-way comparator, not the three-way `a < b ? -1 : a > b ? 1 : 0`: the
  // keys here come from a single object's own properties, so `a === b` is
  // unreachable — a JS object cannot have two own enumerable string keys
  // that are equal. `<`/`>` (never `localeCompare`) is still what matters:
  // explicit UTF-16 code unit order, not locale-dependent collation, so the
  // output — and the hash it feeds — is the same on every machine.
  const entries = Object.entries(descriptors)
    .filter(([, d]) => d.enumerable)
    .map(([k, d]): [string, unknown] => {
      if (!('value' in d)) {
        throw new CanonicalizationError(
          `Accessor property at ${path}.${k}; only data properties are supported`,
        );
      }
      return [k, d.value as unknown];
    })
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, `${path}.${k}`, depth + 1)}`);

  return `{${entries.join(',')}}`;
}

/**
 * Uses Web Crypto rather than node:crypto so `packages/contracts` stays free
 * of Node built-ins and remains safe to bundle for the browser.
 */
export async function sha256Canonical(value: CanonicalValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
