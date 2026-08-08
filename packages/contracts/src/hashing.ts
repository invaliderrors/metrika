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
 */
export function canonicalJson(value: CanonicalValue): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
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
    return `[${value.map((item: unknown, i: number) => serialize(item, `${path}[${i.toString()}]`)).join(',')}]`;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CanonicalizationError(`Only plain objects are supported, at ${path}`);
  }

  // Two-way comparator, not the three-way `a < b ? -1 : a > b ? 1 : 0`: the
  // keys here come from `Object.entries` on a single object, so `a === b` is
  // unreachable — a JS object cannot have two own enumerable string keys
  // that are equal. `<`/`>` (never `localeCompare`) is still what matters:
  // explicit UTF-16 code unit order, not locale-dependent collation, so the
  // output — and the hash it feeds — is the same on every machine.
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, `${path}.${k}`)}`);

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
