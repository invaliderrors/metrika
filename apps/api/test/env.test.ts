import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../src/config/env.js';

const VALID = {
  DATABASE_URL: 'postgresql://metrika_app:metrika_app@localhost:5432/metrika_dev?schema=public',
  HEALTH_DEEP_TOKEN: 'local-health-deep-token',
} as const;

describe('parseEnv', () => {
  it('applies defaults for the optional keys', () => {
    const env = parseEnv({ ...VALID });
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces API_PORT from its string form', () => {
    expect(parseEnv({ ...VALID, API_PORT: '4100' }).API_PORT).toBe(4100);
  });

  it('rejects a missing DATABASE_URL and names it', () => {
    const { HEALTH_DEEP_TOKEN } = VALID;
    expect(() => parseEnv({ HEALTH_DEEP_TOKEN })).toThrow(EnvValidationError);
    expect(() => parseEnv({ HEALTH_DEEP_TOKEN })).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not postgresql://', () => {
    expect(() => parseEnv({ ...VALID, DATABASE_URL: 'mysql://x/y' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a short HEALTH_DEEP_TOKEN — it guards a diagnostic endpoint', () => {
    expect(() => parseEnv({ ...VALID, HEALTH_DEEP_TOKEN: 'short' })).toThrow(/HEALTH_DEEP_TOKEN/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseEnv({ ...VALID, API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  it('lists every problem at once rather than the first', () => {
    const message = (() => {
      try {
        parseEnv({ DATABASE_URL: 'mysql://x/y' });
        return '';
      } catch (error: unknown) {
        return error instanceof Error ? error.message : '';
      }
    })();

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('HEALTH_DEEP_TOKEN');
  });
});
