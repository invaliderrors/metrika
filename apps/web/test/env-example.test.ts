import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServerEnvSchema, parseServerEnv } from '../src/config/env.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/**
 * Deliberately a copy of the reader in `apps/api/test/env-example.test.ts`
 * rather than a shared helper. `apps/web` must not depend on `apps/api`, and
 * pulling `@metrika/testing` — the Testcontainers harness — into this package's
 * devDependencies for a twelve-line splitter would be a much worse trade than
 * duplicating it.
 */
function readEnvExample(): Record<string, string> {
  const raw = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  const entries: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    entries[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return entries;
}

describe('.env.example', () => {
  it('parses at least one key, so a broken reader cannot make this test vacuous', () => {
    expect(Object.keys(readEnvExample()).length).toBeGreaterThan(5);
  });

  /**
   * The assertion that actually gates drift, and the reason this file is not a
   * straight copy of apps/api's.
   *
   * The not-throw assertion below cannot see a key that has a `.default()`:
   * `parseServerEnv({})` succeeds for `WEB_PORT` and `NODE_ENV` whether or not
   * this file documents them, so a defaulted key could be added to the schema
   * and never appear in `.env.example` with every gate green. Comparing key
   * SETS is what closes that — it is one-directional on purpose (documented ⊇
   * declared), because `.env.example` legitimately carries keys no single app's
   * schema declares, e.g. the database and S3 blocks.
   */
  it('names every key the web server schema declares', () => {
    const documented = new Set(Object.keys(readEnvExample()));
    for (const key of Object.keys(ServerEnvSchema.shape)) expect(documented).toContain(key);
  });

  it('satisfies every requirement of the web server schema', () => {
    expect(() => parseServerEnv(readEnvExample())).not.toThrow();
  });
});
