import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../src/config/env.ts', import.meta.url), 'utf8');

/**
 * Comments removed before anything below reads the text, because what follows is
 * a WHITELIST over every occurrence of `process.env` and the module's own header
 * discusses the banned forms in prose. Stripping them is also what lets that
 * header say plainly what it must not do, instead of describing it at arm's
 * length so a grep would not trip over the description.
 *
 * The line-comment guard is `(?<![:\\])`, not the `(?<!:)` of
 * `test/messages.test.ts`, and the difference is measured against this file's
 * subject: `src/config/env.ts` contains the regex literal `/^https?:\/\//`,
 * whose trailing `\/\/` is a `//` preceded by a BACKSLASH rather than by a
 * colon. The looser guard treats it as the start of a comment and eats the rest
 * of that line.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<![:\\])\/\/[^\n]*/g, ' ');
}

const CODE = withoutComments(SOURCE);

/**
 * Every way this module is permitted to reach `process.env`, exhaustively.
 *
 * The two `NEXT_PUBLIC_` reads are the point of the file: Next's support for
 * them is a TEXTUAL substitution performed at build time on exactly the string
 * `process.env.NEXT_PUBLIC_WHATEVER`, so the full literal form is the only one
 * that survives into the browser bundle.
 *
 * The third entry is the server half, and it is a different thing rather than an
 * exception: `parseServerEnv(process.env)` hands the whole object to a pure
 * function that runs on the server, is never inlined and is never expected to
 * be. Whitelisting the call as written keeps it from having to be re-derived by
 * a regex that would then also admit `const e = process.env`.
 *
 * Adding a key means adding a line here. That is the intended cost: the list is
 * the review.
 */
const SANCTIONED_READS = [
  'process.env.NEXT_PUBLIC_API_BASE_URL',
  'process.env.NEXT_PUBLIC_DEFAULT_LOCALE',
  'parseServerEnv(process.env)',
];

describe('the client half of the env module', () => {
  it('reads each NEXT_PUBLIC_ key by its full literal text', () => {
    // Asserted against CODE, not SOURCE. Reading the stripped text is also the
    // vacuity control for `withoutComments`: a stripper that ate the module
    // would satisfy the whitelist below by leaving nothing to check, and fails
    // here instead.
    expect(CODE).toContain('process.env.NEXT_PUBLIC_API_BASE_URL');
    expect(CODE).toContain('process.env.NEXT_PUBLIC_DEFAULT_LOCALE');
  });

  /**
   * A whitelist rather than a list of banned shapes, because the banned shapes
   * are open-ended and the sanctioned ones are three.
   *
   * MEASURED — this test exists because its predecessor asserted only
   * `not.toMatch(/process\.env\[/)` while its comment claimed to cover four
   * forms. The defeat: alias `process.env` to a local, read both keys off the
   * alias, and leave a dead array holding the two literal strings so the
   * `toContain` greps above still passed. Every gate stayed green — this suite,
   * lint, `tsc`, `pnpm build` — on a source Next does not substitute, which
   * ships `undefined` for both values to the browser. Under the whitelist, the
   * alias assignment is text this file cannot account for and the test is red.
   */
  it('reaches process.env in no other way at all — no alias, destructure, spread or computed access', () => {
    const residue = SANCTIONED_READS.reduce((code, form) => code.replaceAll(form, ''), CODE);

    expect(
      residue,
      'Next substitutes only the full literal `process.env.NEXT_PUBLIC_KEY`; every other form type-checks, passes every server-side test and is `undefined` in the browser',
    ).not.toMatch(/process\s*\.\s*env/);
  });
});
