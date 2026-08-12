import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REDACTION_CENSOR } from '../src/sentry-event.js';

/**
 * The CENSOR, across the language boundary — the one part of this control the
 * corpus structurally cannot grade.
 *
 * `redaction-corpus.json` declares which KEYS are redacted. It says nothing
 * about what a redacted value is replaced WITH, so `packages/contracts`,
 * `apps/api`, `apps/web` and `apps/workers` could each write a different token
 * with all 956 rows green on every side. Three of them do share one, because
 * they import `REDACTION_CENSOR`; `apps/workers` cannot import a TypeScript
 * constant and therefore restates it.
 *
 * It restated it WRONGLY, and nothing noticed: `metrika_core.logging` wrote
 * `[redacted]` while everything else wrote `[REDACTED]`. Nothing fails when a
 * censor diverges — every sink still censors, every fixture still passes, and
 * the cost lands entirely on the operator, who greps a mixed log stream for the
 * token `docs/OBSERVABILITY.md` §3 shows them and silently matches no Python
 * line at all. That is the same failure shape as the redaction LIST drifting,
 * which is why the list was centralised; this closes the last piece that was
 * still a copy.
 *
 * READ AS TEXT, deliberately. Importing the value from the Python side is not
 * possible from Vitest, and running Python from here would make a unit test
 * depend on a provisioned `uv` environment. Text is enough: the assertion is
 * that a specific literal appears in a specific assignment.
 *
 * TURBO: this reads a file outside `packages/contracts`, so
 * `packages/contracts/turbo.json` declares
 * `$TURBO_ROOT$/apps/workers/packages/metrika_core/src/metrika_core/logging.py`
 * as an input. Without that entry turbo hashes only this package's files and
 * replays a green log while the Python token has moved underneath — which is the
 * only thing this test can fail on. The invalidation was measured, not assumed.
 */
const LOGGING_PY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../apps/workers/packages/metrika_core/src/metrika_core/logging.py',
);

/** The assignment this test grades: `_REDACTED = "<token>"`. */
const ASSIGNMENT = /^_REDACTED = "([^"]*)"$/m;

describe('the censor token, across the language boundary', () => {
  it('is a single assignment in metrika_core.logging, so this test cannot silently stop finding it', () => {
    const source = readFileSync(LOGGING_PY, 'utf8');
    const matches = [...source.matchAll(new RegExp(ASSIGNMENT, 'gm'))];

    // A test that greps for a pattern is only as good as the pattern still
    // matching. Zero matches would make the assertion below throw rather than
    // fail quietly; two would mean it is grading whichever came first.
    expect(matches, `no \`_REDACTED = "…"\` assignment in ${LOGGING_PY}`).toHaveLength(1);
  });

  it('is the same string on both sides', () => {
    const source = readFileSync(LOGGING_PY, 'utf8');
    const found = ASSIGNMENT.exec(source)?.[1];

    expect(
      found,
      'metrika_core.logging writes a different censor from REDACTION_CENSOR. An operator ' +
        'greps one log stream for one token; two tokens means every line from the other ' +
        'runtime is invisible to that query.',
    ).toBe(REDACTION_CENSOR);
  });

  it('is not empty, which would make every redaction fixture on both sides vacuous', () => {
    expect(REDACTION_CENSOR.length).toBeGreaterThan(0);
  });
});
