import { createRequire } from 'node:module';
import path from 'node:path';
import { redactionCorpus } from '@metrika/contracts';
import { describe, expect, it } from 'vitest';
import { REDACTION_CENSOR, redactSentryEvent } from '../src/lib/telemetry/redaction.js';
import { ALLOWED_INTEGRATION_NAMES, keepAllowedIntegrations } from '../src/lib/telemetry/sentry.js';

const CORPUS = redactionCorpus();

/**
 * THE FIXTURE THAT GRADES THIS SINK, and it grades the WALK rather than the
 * rule.
 *
 * `isRedactedKey` lives in `packages/contracts` and is graded there against the
 * same corpus, so re-asserting its verdicts here would be a second copy of
 * somebody else's test. What is unproven until this file runs it is that a key
 * reaching this sink is actually VISITED: the traversal is `apps/web`'s own, and
 * a walk that stopped recursing — into arrays, past a depth, through a nested
 * `extra` — would leave the shared rule perfectly correct and the sink leaking.
 *
 * So every row is run through `redactSentryEvent` at a nesting depth an event
 * really has, not through the matcher.
 *
 * The corpus's verdicts are DECLARED rather than computed from the rule, which
 * is what stops this from being two wrong implementations agreeing with each
 * other, and it extends mechanically when a name is added to
 * `RedactedFieldName`.
 */
describe('the corpus', () => {
  it('is not empty and states both verdicts, so the loops below cannot be vacuous', () => {
    expect(CORPUS.length).toBeGreaterThan(100);
    expect(CORPUS.some((row) => row.redacted)).toBe(true);
    expect(CORPUS.some((row) => !row.redacted)).toBe(true);
  });
});

describe('redactSentryEvent, graded against the declared corpus', () => {
  /**
   * Nested two levels down inside `extra`, because the top level of an event is
   * the one place a broken walk still works: `redactInPlace` is called with the
   * event itself, so its own keys are visited before any recursion happens.
   */
  function eventCarrying(key: string): Record<string, unknown> {
    return { extra: { payload: { [key]: 'SECRET-VALUE' } } };
  }

  function verdictFor(key: string): boolean {
    const redacted = redactSentryEvent(eventCarrying(key));
    const payload = (redacted['extra'] as { payload: Record<string, unknown> }).payload;
    return payload[key] === REDACTION_CENSOR;
  }

  it('censors every key the corpus says must be redacted', () => {
    const missed = CORPUS.filter((row) => row.redacted && !verdictFor(row.key)).map(
      (row) => row.key,
    );

    expect(missed, 'these keys reached the sink and were written down').toEqual([]);
  });

  it('leaves every key the corpus says must survive', () => {
    const overreached = CORPUS.filter((row) => !row.redacted && verdictFor(row.key)).map(
      (row) => row.key,
    );

    expect(overreached, 'a control that censors these costs real debuggability').toEqual([]);
  });

  /**
   * The same rows again, one level deeper and inside an ARRAY. A walk that
   * recurses into objects but not into array elements passes everything above
   * and misses `event.breadcrumbs`, which is where a browser event keeps the
   * fetch that carried a presigned URL.
   */
  it('reaches keys inside arrays too', () => {
    const redactedRows = CORPUS.filter((row) => row.redacted).map((row) => row.key);
    const event = { breadcrumbs: redactedRows.map((key) => ({ data: { [key]: 'SECRET-VALUE' } })) };

    const walked = redactSentryEvent(event);
    const survivors = walked.breadcrumbs
      .flatMap((crumb) => Object.entries(crumb.data))
      .filter(([, value]) => value !== REDACTION_CENSOR)
      .map(([key]) => key);

    expect(survivors).toEqual([]);
  });
});

/**
 * A Sentry event with something sensitive at every depth and shape the real
 * SDK produces: request headers, a fetch breadcrumb, `extra`, `contexts`, and
 * the local variables Sentry's `LocalVariablesAsync` integration attaches to a
 * stack frame.
 */
const PRESIGNED = 'https://s3.example/metrika/uploads/abc.stl?X-Amz-Signature=DEADBEEF';
const SECRETS = [
  'Bearer eyJhbGciOiJIUzI1NiJ9',
  'session=s%3AabC123',
  'hunter2',
  PRESIGNED,
  'Torre_Bacata_Fase3_Final.stl',
  'Edificio Confidencial',
  'whsec_livekey',
  'tok_visa_4242',
];

function sampleEvent(): Record<string, unknown> {
  return {
    event_id: 'abc123',
    level: 'error',
    transaction: '/models/[id]',
    request: {
      url: 'https://metrika.example/models/42?foo=bar',
      headers: {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9',
        Cookie: 'session=s%3AabC123',
        'Accept-Language': 'es-CO',
      },
    },
    breadcrumbs: [
      { category: 'fetch', data: { url: PRESIGNED, method: 'PUT', status_code: 200 } },
      { category: 'navigation', data: { from: '/', to: '/models' } },
    ],
    extra: {
      password: 'hunter2',
      cacheKey: 'sha256:deadbeef',
      upload: { signedUrls: [PRESIGNED], originalFilename: 'Torre_Bacata_Fase3_Final.stl' },
      projectName: 'Edificio Confidencial',
    },
    contexts: {
      payment: { providerPayload: { token: 'tok_visa_4242' }, webhookSecret: 'whsec_livekey' },
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: 'upload failed',
          stacktrace: {
            frames: [{ filename: 'app:///page.js', vars: { token: 'tok_visa_4242' } }],
          },
        },
      ],
    },
  };
}

describe('redactSentryEvent', () => {
  /**
   * The strong form of the assertion: not "this field is censored" but "this
   * STRING is nowhere in the serialised event". A per-field assertion passes
   * while the same secret sits in a sibling key nobody thought of — which is
   * how the fetch breadcrumb, whose `data.url` carries a presigned S3 URL, was
   * missed in the first place.
   */
  it.each(SECRETS)('leaves no trace of %s anywhere in the event', (secret) => {
    const serialised = JSON.stringify(redactSentryEvent(sampleEvent()));

    expect(serialised).not.toContain(secret);
  });

  it('censors rather than deletes, so the shape of the event is unchanged', () => {
    const event = redactSentryEvent(sampleEvent());
    const request = event['request'] as { headers: Record<string, string> };

    expect(request.headers['Authorization']).toBe(REDACTION_CENSOR);
    expect(request.headers['Cookie']).toBe(REDACTION_CENSOR);
  });

  it('keeps everything that is not on the list', () => {
    const event = redactSentryEvent(sampleEvent());
    const request = event['request'] as { headers: Record<string, string> };
    const extra = event['extra'] as Record<string, unknown>;
    const breadcrumbs = event['breadcrumbs'] as { data: Record<string, unknown> }[];

    expect(event['event_id']).toBe('abc123');
    expect(event['level']).toBe('error');
    expect(event['transaction']).toBe('/models/[id]');
    expect(request.headers['Accept-Language']).toBe('es-CO');
    expect(extra['cacheKey']).toBe('sha256:deadbeef');
    expect(breadcrumbs[1]?.data['to']).toBe('/models');
  });

  /**
   * Stated as a test because it is the cost of putting `url` on the shared list
   * in its bare form, and a later reader will otherwise take it for a bug.
   * `packages/contracts/src/redaction.ts` explains the trade; the page identity
   * survives in `transaction`, asserted above.
   */
  it('censors request.url too, which is the known cost of the bare `url` entry', () => {
    const event = redactSentryEvent(sampleEvent());

    expect((event['request'] as Record<string, unknown>)['url']).toBe(REDACTION_CENSOR);
  });

  it("reaches into arrays and into a stack frame's local variables", () => {
    const event = redactSentryEvent(sampleEvent());
    const frames = (
      event['exception'] as {
        values: { stacktrace: { frames: { vars: Record<string, unknown> }[] } }[];
      }
    ).values[0]?.stacktrace.frames;

    expect(frames?.[0]?.vars['token']).toBe(REDACTION_CENSOR);
  });

  /**
   * A cycle in an event is not hypothetical — Sentry attaches framework objects
   * to `contexts` — and a walker without cycle detection hangs inside
   * `beforeSend`, i.e. exactly when something is already going wrong.
   */
  it('terminates on a cyclic event, and still redacts', () => {
    const event = sampleEvent();
    const cycle: Record<string, unknown> = { password: 'hunter2' };
    cycle['self'] = cycle;
    event['contexts'] = cycle;

    const redacted = redactSentryEvent(event);

    expect((redacted['contexts'] as Record<string, unknown>)['password']).toBe(REDACTION_CENSOR);
  });

  it('returns the same object, which is what Sentry expects from beforeSend', () => {
    const event = sampleEvent();

    expect(redactSentryEvent(event)).toBe(event);
  });

  it('handles an event with nothing sensitive in it without changing anything', () => {
    const benign = { level: 'info', extra: { modelId: 'mv_1', durationMs: 12 } };

    expect(redactSentryEvent(benign)).toStrictEqual({
      level: 'info',
      extra: { modelId: 'mv_1', durationMs: 12 },
    });
  });
});

/**
 * The integration allowlist, measured against the SDK that is actually
 * installed.
 *
 * Loaded through `createRequire` at an absolute path into the package's CJS
 * build, and that is not gratuitous: `@sentry/nextjs`'s ESM build imports
 * `next/constants` and `next/router` extensionlessly, which Node's ESM resolver
 * rejects outright — measured, `ERR_MODULE_NOT_FOUND` — and Vitest imports
 * dependencies natively rather than through Vite's resolver. The CJS build
 * loads because CommonJS resolution tries extensions. The alternative, a test
 * over synthetic integrations only, would keep passing after Sentry renamed
 * every real one.
 */
const require_ = createRequire(import.meta.url);
const sentryCjs = path.join(
  path.dirname(require_.resolve('@sentry/nextjs/package.json')),
  'build/cjs',
);

interface IntegrationLike {
  readonly name: string;
}

interface SentryBuild {
  getDefaultIntegrations: (options: Record<string, unknown>) => IntegrationLike[];
}

function defaults(
  build: 'index.server.js' | 'index.client.js',
  options: Record<string, unknown>,
): string[] {
  const loaded = require_(path.join(sentryCjs, build)) as SentryBuild;
  return loaded.getDefaultIntegrations(options).map((integration) => integration.name);
}

describe('keepAllowedIntegrations', () => {
  it('keeps what is on the list and drops what is not', () => {
    const filtered = keepAllowedIntegrations([
      { name: 'LinkedErrors' },
      { name: 'BrowserTracing' },
      { name: 'Dedupe' },
    ]);

    expect(filtered.map((integration) => integration.name)).toStrictEqual([
      'LinkedErrors',
      'Dedupe',
    ]);
  });

  /**
   * The property ADR-0029 obligation 2 chose the allowlist direction FOR: a
   * Sentry release that adds a span-producing integration must be excluded by
   * default rather than opted into silently. A denylist passes the case above
   * and fails this one.
   */
  it('drops an integration that did not exist when this list was written', () => {
    expect(keepAllowedIntegrations([{ name: 'SomeFutureTracingIntegration' }])).toStrictEqual([]);
  });

  it('excludes BrowserTracing, which is what stops apps/web opening its own traces', () => {
    expect(ALLOWED_INTEGRATION_NAMES).not.toContain('BrowserTracing');
  });

  /**
   * Against the REAL default sets, so a rename upstream is red here rather than
   * a silently shrinking allowlist. `tracesSampleRate: 1` is what makes the
   * server SDK offer its full instrumentation set — ADR-0029 measured 44, and
   * that number is reproduced below rather than trusted.
   */
  it('drops every span-producing integration the server SDK offers under tracing', () => {
    const withTracing = defaults('index.server.js', { tracesSampleRate: 1 });

    expect(withTracing.length).toBe(44);

    const kept = keepAllowedIntegrations(withTracing.map((name) => ({ name }))).map((i) => i.name);

    for (const spanProducing of ['Fastify', 'Express', 'Postgres', 'Prisma', 'Redis', 'Mongo']) {
      expect(withTracing).toContain(spanProducing);
      expect(kept).not.toContain(spanProducing);
    }
  });

  it('still recognises the error-side integrations both runtimes ship', () => {
    const server = keepAllowedIntegrations(
      defaults('index.server.js', {}).map((name) => ({ name })),
    );
    const client = keepAllowedIntegrations(
      defaults('index.client.js', {}).map((name) => ({ name })),
    );

    // Every default the SDK ships with tracing off is error-side, so the filter
    // must keep all of them. A rename upstream shows up here as a shortfall.
    expect(server.length).toBe(defaults('index.server.js', {}).length);
    expect(client.length).toBe(defaults('index.client.js', {}).length);
    expect(server.length).toBeGreaterThan(10);
    expect(client.length).toBeGreaterThan(10);
  });
});
