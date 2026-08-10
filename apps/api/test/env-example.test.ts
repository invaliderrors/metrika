import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchema, parseEnv } from '../src/config/env.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

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
   * A real gap in this gate, found while writing apps/web's equivalent.
   *
   * The not-throw assertion below is blind to any key carrying a `.default()`:
   * `parseEnv({...})` succeeds for `NODE_ENV`, `API_PORT` and `LOG_LEVEL`
   * whether or not this file documents them. So a defaulted key could be added
   * to EnvSchema and never reach `.env.example`, with this suite green — which
   * is precisely the "a fresh clone can never fail with an unexplained missing
   * variable" property the file header claims is enforced.
   *
   * One-directional on purpose (documented ⊇ declared): `.env.example` also
   * carries keys no single app's schema declares, such as the S3 and SMTP
   * blocks and DATABASE_ADMIN_URL, which schema.prisma reads rather than this
   * schema.
   */
  it('names every key the API env schema declares', () => {
    const documented = new Set(Object.keys(readEnvExample()));
    for (const key of Object.keys(EnvSchema.shape)) expect(documented).toContain(key);
  });

  it('satisfies every requirement of the API env schema', () => {
    expect(() => parseEnv(readEnvExample())).not.toThrow();
  });
});
