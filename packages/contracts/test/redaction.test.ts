import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RedactedFieldName,
  conflictingDeclarations,
  isRedactedKey,
  redactionCorpus,
} from '../src/redaction.js';

/**
 * The TypeScript half of the redaction agreement. The Python half is
 * `apps/workers/packages/metrika_core/tests/test_logging.py`, which asserts that
 * structlog actually redacts every name below — this file asserts only that the
 * names are here.
 *
 * The roster is RESTATED here rather than derived from `RedactedFieldName`, and
 * that is the entire point of the file: a test that reads the list it is
 * checking agrees with it by construction and would stay green while somebody
 * deletes `signedUrl`. Every name below traces to a document —
 * `docs/OBSERVABILITY.md` §3's redaction block, or the widening
 * `apps/workers`' structlog processor was given after `download_url`, `s3_url`
 * and `upload_url` were measured going through untouched — so removing one from
 * `src/redaction.ts` is a red test in the same second, before any codegen runs.
 */
describe('RedactedFieldName', () => {
  const names = new Set<string>(RedactedFieldName.options);

  it('carries every name docs/OBSERVABILITY.md §3 redacts', () => {
    for (const required of [
      'authorization',
      'cookie',
      'password',
      'token',
      'webhookSecret',
      'signedUrl',
      'presignedUrl',
      'uploadUrl',
      'downloadUrl',
      'providerPayload',
      'paymentPayload',
      'filename',
      'originalFilename',
      'projectName',
    ]) {
      expect(
        names,
        `${required} is named by docs/OBSERVABILITY.md §3 and is not in the list`,
      ).toContain(required);
    }
  });

  it("carries the names apps/workers' structlog processor was widened for", () => {
    // `secret` and `fileName` are exact keys the Python side already matched;
    // `url` is the bare name that lets its word-suffix matcher reach `s3_url`,
    // `object_url` and every other spelling a caller invents. Dropping any of
    // the three narrows a control that was widened on a measurement.
    for (const required of ['secret', 'fileName', 'url']) {
      expect(names).toContain(required);
    }
  });

  it('does not redact the identifiers a pipeline is debugged with', () => {
    // The cost of over-redaction, asserted rather than assumed. `cacheKey` is
    // the content-addressed identifier every pipeline log line carries; a list
    // containing `key` would take it, and take `apiKey`'s neighbours with it.
    // `modelId` and `requestId` are the two identifiers a support ticket is
    // answered with — redacting either would make the correlation chain this
    // list ships alongside worthless.
    for (const kept of ['key', 'cacheKey', 'modelId', 'requestId', 'organizationId', 'traceId']) {
      expect(names, `${kept} must stay readable`).not.toContain(kept);
    }
  });

  it('states every name in camelCase, because three sinks derive from the spelling', () => {
    // Pino builds `*.${name}` paths, which are matched against JavaScript object
    // keys; the Python matcher lower-cases and splits on word boundaries, so it
    // reaches `signed_url` from `signedUrl` without either side restating the
    // other's convention. A snake_case entry here would be a Pino path that
    // matches nothing while looking exactly like one that works.
    for (const name of RedactedFieldName.options) {
      expect(name, `${name} is not camelCase`).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it('has no duplicates and is not vacuous', () => {
    expect(names.size).toBe(RedactedFieldName.options.length);
    expect(names.size).toBeGreaterThan(10);
  });
});

/**
 * The matcher, and the corpus that keeps its Python port honest.
 *
 * `RedactedFieldName` made the key LIST one source. The matching RULE was still
 * two hand-written implementations of one algorithm, and review measured 27 of
 * 140 probe names disagreeing between `apps/workers` and `apps/web` — including
 * `signedURLs`, which one side redacted and the other let through, in exactly
 * the class a round of review had just been raised to close.
 *
 * `redaction-corpus.json` is the structural close. It is emitted from
 * `redactionCorpus()` by `pnpm contracts:emit`, CI diffs it, this file asserts
 * `isRedactedKey` reproduces every row, and
 * `apps/workers/.../test_redaction_corpus.py` asserts the Python matcher does
 * too. A change to one rule without the other goes red — which is a stronger
 * property than each side agreeing with itself.
 */
describe('isRedactedKey', () => {
  const corpus: readonly { key: string; redacted: boolean }[] = JSON.parse(
    readFileSync(path.join(import.meta.dirname, '..', 'redaction-corpus.json'), 'utf8'),
  ) as { key: string; redacted: boolean }[];

  it('the committed corpus is the one this rule generates', () => {
    // The CI `contracts` job re-emits and diffs, so this is the same guarantee
    // from inside the test suite — a developer who edits the table above and
    // does not re-run `pnpm contracts:emit` sees it here first.
    expect(corpus).toEqual(redactionCorpus());
  });

  it('is not vacuous, in both directions', () => {
    expect(corpus.filter((row) => row.redacted).length).toBeGreaterThan(100);
    expect(corpus.filter((row) => !row.redacted).length).toBeGreaterThan(20);
  });

  it('declares nothing both ways', () => {
    // A `MUST_SURVIVE` entry that some spelling also produces used to be
    // resolved silently in favour of redaction, so a deliberate negative
    // declaration could be discarded with no error at all.
    expect(conflictingDeclarations()).toEqual([]);
  });

  it('covers the PRODUCT of the spelling dimensions, not their sum', () => {
    // The regression this exists for: `signedURLs2` is an acronym plural AND an
    // ordinal, and a flat list of transforms contains the shapes somebody
    // thought of rather than their combinations. A one-character edit to the
    // Python matcher was measured leaving its whole suite green while exactly
    // this key diverged.
    const keys = new Set(corpus.map((row) => row.key));
    for (const composed of [
      'signedURLs2',
      'downloadURLs2',
      'upstreamSignedURLsV2',
      'UPSTREAM_SIGNED_URLS_V2',
      'upstream_signed_urls_v2',
      'signedurlsv2',
      'presignedURLs2',
    ]) {
      expect(keys, `${composed} is not in the corpus`).toContain(composed);
    }
  });

  it.each(
    ['signedURLs', 'downloadURLs', 'presignedURLs', 'URLs', 'signedURL', 'signedURL2'].map(
      (key) => [key] as const,
    ),
  )('reaches the acronym spelling %s', (key) => {
    // The regression this test exists for. `[A-Z]+(?![a-z])` backtracks off the
    // lowercase `s` and yields `['ur','ls']`, so an acronym plural matched
    // nothing at all — a batch step logging `signedURLs` leaked a bearer
    // credential with the whole gate green. The fix is one alternation branch,
    // `[A-Z]+s(?![a-z])`, tried FIRST.
    expect(isRedactedKey(key)).toBe(true);
  });

  it("grades the acronym branch's near-misses through the CORPUS, not only here", () => {
    // These used to live only in this file, so the Python port was ungraded on
    // exactly the names the acronym branch could have swept in. They are
    // `MUST_SURVIVE` entries now and both sides check them; this asserts they
    // really did cross rather than being dropped from the table.
    const survivors = new Set(corpus.filter((row) => !row.redacted).map((row) => row.key));
    for (const key of ['HTTPStatus', 'AWSRegion', 'cacheKeys', 'statuses', 'rev2', 'dev2']) {
      expect(survivors, `${key} is not declared a survivor`).toContain(key);
    }
  });

  it.each(corpus.map((row) => [row.key, row.redacted] as const))(
    'agrees with the corpus on %j',
    (key, redacted) => {
      expect(isRedactedKey(key)).toBe(redacted);
    },
  );
});
