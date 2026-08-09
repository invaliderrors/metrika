import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../src/config/env.ts', import.meta.url), 'utf8');

describe('the client half of the env module', () => {
  it('reads each NEXT_PUBLIC_ key by its full literal text', () => {
    // Next's build-time replacement is textual. `process.env[key]`,
    // `const e = process.env; e.NEXT_PUBLIC_X`, and object spread all survive
    // typecheck, pass every server-side test, and yield undefined in the
    // browser bundle. The literal form is the only one that is replaced.
    expect(SOURCE).toContain('process.env.NEXT_PUBLIC_API_BASE_URL');
    expect(SOURCE).toContain('process.env.NEXT_PUBLIC_DEFAULT_LOCALE');
  });

  it('never reaches a NEXT_PUBLIC_ key through a computed member access', () => {
    expect(SOURCE).not.toMatch(/process\.env\[/);
  });
});
