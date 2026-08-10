import { describe, expect, it } from 'vitest';
import enUS from '../messages/en-US.json' with { type: 'json' };
import esCO from '../messages/es-CO.json' with { type: 'json' };

/**
 * `value as Record<string, unknown>` rather than bare `Object.entries(value)`:
 * the `object` overload of `Object.entries` returns `[string, any][]`, and
 * feeding that `any` back into this function is an error under
 * `no-unsafe-argument`. The assertion is what keeps the walk typed.
 */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix !== '' ? `${prefix}.${k}` : k),
  );
}

describe('message catalogues', () => {
  it('carry exactly the same key set', () => {
    // A key present in one locale and absent from the other is a runtime
    // MISSING_MESSAGE in production for whichever locale lacks it. Structural
    // equality is checkable now; translation quality is not.
    expect(keyPaths(enUS).sort()).toEqual(keyPaths(esCO).sort());
  });

  it('reads a non-trivial key set, so a broken walker cannot make this vacuous', () => {
    // Both catalogues being `{}` satisfies the equality above. This is the
    // control that says the walker actually descended into something.
    expect(keyPaths(esCO)).toContain('app.name');
    expect(keyPaths(esCO).length).toBeGreaterThan(1);
  });

  it('has no empty string values in the shipped locale', () => {
    const empties = keyPaths(esCO).filter((path) => {
      const v = path
        .split('.')
        .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], esCO);
      return v === '';
    });
    expect(empties).toEqual([]);
  });
});
