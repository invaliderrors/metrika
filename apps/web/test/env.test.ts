import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseServerEnv } from '../src/config/env.js';

const VALID = {
  NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3001',
  NEXT_PUBLIC_DEFAULT_LOCALE: 'es-CO',
} as const;

describe('parseServerEnv', () => {
  it('applies defaults for the optional keys', () => {
    const env = parseServerEnv({ ...VALID });
    expect(env.NODE_ENV).toBe('development');
    expect(env.WEB_PORT).toBe(3000);
  });

  it('coerces WEB_PORT from its string form', () => {
    expect(parseServerEnv({ ...VALID, WEB_PORT: '4000' }).WEB_PORT).toBe(4000);
  });

  it('rejects a missing NEXT_PUBLIC_API_BASE_URL and names it', () => {
    const { NEXT_PUBLIC_DEFAULT_LOCALE } = VALID;
    expect(() => parseServerEnv({ NEXT_PUBLIC_DEFAULT_LOCALE })).toThrow(EnvValidationError);
    expect(() => parseServerEnv({ NEXT_PUBLIC_DEFAULT_LOCALE })).toThrow(
      /NEXT_PUBLIC_API_BASE_URL/,
    );
  });

  it('rejects an API base URL that is not http(s)', () => {
    expect(() => parseServerEnv({ ...VALID, NEXT_PUBLIC_API_BASE_URL: 'ftp://x/y' })).toThrow(
      /NEXT_PUBLIC_API_BASE_URL/,
    );
  });

  it('rejects a locale outside the supported set', () => {
    expect(() => parseServerEnv({ ...VALID, NEXT_PUBLIC_DEFAULT_LOCALE: 'fr-FR' })).toThrow(
      /NEXT_PUBLIC_DEFAULT_LOCALE/,
    );
  });

  it('reports every problem at once, not just the first', () => {
    try {
      parseServerEnv({});
      expect.unreachable('parseServerEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain('NEXT_PUBLIC_API_BASE_URL');
      expect((error as Error).message).toContain('NEXT_PUBLIC_DEFAULT_LOCALE');
    }
  });
});
