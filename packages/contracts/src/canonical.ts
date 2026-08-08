import { createHash } from 'node:crypto';

/**
 * Canonical JSON: sorted object keys, no insignificant whitespace, UTF-8,
 * numbers via RFC 8785 (JCS) — but bigint is rendered as string and
 * `undefined` fields are dropped, matching JSON.stringify behaviour.
 *
 * Used for content hashing of pricing configurations, slice cache keys,
 * and `PrintConfiguration.contentHash`.
 */
export const canonicalJson = (value: unknown): string => {
  return serialize(value);
};

const serialize = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number ${value}`);
    }
    // Use the shortest round-trip representation (ECMAScript ToString for numbers).
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'bigint') {
    // Bigint is not representable in JSON; canonical form is its decimal string.
    return JSON.stringify(value.toString());
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
    return `{${pairs.join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
};

export const sha256Canonical = (value: unknown): string => {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
};
