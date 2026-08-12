import { describe, expect, it } from 'vitest';
import { RedactedFieldName } from '../src/redaction.js';

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
