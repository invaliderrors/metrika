import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, DEFAULT_TIME_ZONE, SUPPORTED_LOCALES } from '../src/i18n/routing.js';

const REQUEST_CONFIG = readFileSync(new URL('../src/i18n/request.ts', import.meta.url), 'utf8');

/**
 * `src/i18n/request.ts` cannot be imported here, and that is measured rather
 * than assumed: `next-intl`'s `./server` subpath resolves to its react-client
 * build outside Next's `react-server` export condition, and calling
 * `getRequestConfig` from there throws "`getRequestConfig` is not supported in
 * Client Components". Forcing the condition on in `vitest.config.ts` would
 * change module resolution for every test in the package to buy one assertion.
 *
 * So this file splits the check in two: the VALUE is tested for real, and the
 * fact that `request.ts` passes it is a text assertion. Say what that second
 * half can see — it proves the key is present, not that next-intl received it.
 * `next build` is what proves the wiring end to end, and it does: removing the
 * plugin wrapper from `next.config.ts` aborts the build at `await getLocale()`
 * in `layout.tsx`.
 */
describe('the request configuration', () => {
  it('pins a time zone rather than inheriting one from the machine', () => {
    // Absent `timeZone`, next-intl falls back to the runtime's own zone. This
    // machine infers America/Bogota and a CI runner infers UTC, so the same
    // instant renders as two different wall clocks and server and client
    // disagree inside one page. Nothing formats a date yet — which is exactly
    // why the pin is cheap now.
    expect(REQUEST_CONFIG).toMatch(/timeZone:/);
    expect(REQUEST_CONFIG).toContain('DEFAULT_TIME_ZONE');
  });

  it('names a time zone the platform actually knows', () => {
    // A typo'd IANA name is a RangeError at render time, not a fallback.
    expect(() => new Intl.DateTimeFormat('es-CO', { timeZone: DEFAULT_TIME_ZONE })).not.toThrow();

    // And the resolved zone is the one asked for. `Intl` normalises some
    // aliases, so a value that survives construction can still not be the zone
    // it was written as.
    expect(
      new Intl.DateTimeFormat('es-CO', { timeZone: DEFAULT_TIME_ZONE }).resolvedOptions().timeZone,
    ).toBe(DEFAULT_TIME_ZONE);
  });

  it('defaults to a locale that is actually supported', () => {
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});
