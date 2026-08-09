import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

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

  it('satisfies every requirement of the API env schema', () => {
    expect(() => parseEnv(readEnvExample())).not.toThrow();
  });
});
