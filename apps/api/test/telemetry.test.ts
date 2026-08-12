import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRedactedKey } from '@metrika/contracts';
import * as Sentry from '@sentry/node';
import {
  RedactingSpanProcessor,
  SENTRY_URL_TRACE_STATE_KEY,
  redactSpanAttributes,
  redactSpanTraceState,
  redactUrlValue,
} from '../src/infrastructure/telemetry/span-redaction.js';
import {
  BAGGAGE_REQUEST_ID,
  FIELD_REQUEST_ID,
  LOG_KEYS,
  REQUIRED_SENTRY_OTEL_PIECES,
  SENTRY_KEPT_INTEGRATIONS,
  buildPropagator,
  createDiagLogger,
  loadedTooEarly,
  missingSentryOtelPieces,
  sentryIntegrations,
} from '../src/infrastructure/telemetry/index.js';

/**
 * The parts of the telemetry bootstrap that can be graded without starting it.
 *
 * `startTelemetry()` registers process-global state and refuses a second call,
 * so everything it decides is a pure function taking its input as an argument —
 * that is why `loadedTooEarly`, `sentryIntegrations`, `buildPropagator`,
 * `missingSentryOtelPieces` and `createDiagLogger` exist as exports rather than
 * as closures. The end-to-end behaviour is in
 * `test/telemetry.integration.test.ts`, which runs the built application in a
 * real Node process for a measured reason recorded there.
 */

describe('the load-order guard', () => {
  /**
   * The failure this converts is silent and total. `require-in-the-middle`
   * patches future requires only: a `pino` that was resident before
   * `startTelemetry()` is never instrumented, so every log line in the process
   * loses `traceId` and `spanId` and nothing anywhere reports a problem.
   */
  it('names a module that was already resident', () => {
    expect(
      loadedTooEarly(['/repo/node_modules/.pnpm/pino@10.3.1/node_modules/pino/lib/proto.js']),
    ).toEqual(['pino']);
  });

  it('names each module once, however many of its files are loaded', () => {
    expect(
      loadedTooEarly([
        '/repo/node_modules/pino/pino.js',
        '/repo/node_modules/pino/lib/proto.js',
        '/repo/node_modules/@nestjs/core/nest-factory.js',
      ]),
    ).toEqual(['pino', '@nestjs/core']);
  });

  /**
   * The negative, and it is the assertion that stops the guard becoming a
   * boot-time false alarm: the packages whose NAMES contain an instrumented
   * one, and the instrumentation packages themselves, must not match.
   */
  it('does not fire on a package that merely mentions an instrumented one', () => {
    expect(
      loadedTooEarly([
        '/repo/node_modules/@opentelemetry/instrumentation-pino/build/src/instrumentation.js',
        '/repo/node_modules/pino-http/index.js',
        '/repo/node_modules/@nestjs/common/index.js',
      ]),
    ).toEqual([]);
  });

  /**
   * `@fastify/otel` is deliberately NOT guarded, and that is a property of the
   * package rather than an omission: its `init()` returns `[]` and it registers
   * through the `fastify.initialization` diagnostics channel, so it is the one
   * instrumentation here that a late start cannot silently disable.
   */
  it('does not guard @fastify/otel, which patches no module', () => {
    expect(loadedTooEarly(['/repo/node_modules/@fastify/otel/index.js'])).toEqual([]);
  });
});

describe('the Sentry integration allowlist', () => {
  /**
   * ADR-0029's measurement, re-run on every CI job rather than trusted: the
   * default set is what the allowlist is subtracted from, so a Sentry release
   * that adds to it is the event this suite exists to catch. The full name list
   * is pinned deliberately — the COUNT alone would not notice a rename.
   */
  it('pins the default integration set this allowlist was derived from', () => {
    expect(Sentry.getDefaultIntegrations({}).map((integration) => integration.name)).toEqual([
      'InboundFilters',
      'FunctionToString',
      'LinkedErrors',
      'RequestData',
      'NodeSystemError',
      'ConversationId',
      'Console',
      'OnUncaughtException',
      'OnUnhandledRejection',
      'ContextLines',
      'LocalVariablesAsync',
      'Context',
      'ChildProcess',
      'ProcessSession',
      'Modules',
      'Http',
      'NodeFetch',
    ]);
  });

  /**
   * The other half of ADR-0029's count, and the reason the allowlist direction
   * was chosen: enabling tracing adds twenty-seven more, every one of them an
   * instrumentation. A denylist would admit the twenty-eighth silently.
   */
  it('pins the count that appears once tracing is enabled', () => {
    expect(Sentry.getDefaultIntegrations({ tracesSampleRate: 1 })).toHaveLength(44);
    expect(Sentry.getDefaultIntegrations({})).toHaveLength(17);
  });

  it('keeps only names that are really in the default set', () => {
    const defaults = new Set(
      Sentry.getDefaultIntegrations({ tracesSampleRate: 1 }).map((integration) => integration.name),
    );
    for (const kept of SENTRY_KEPT_INTEGRATIONS) expect(defaults).toContain(kept);
  });

  /**
   * THE RULE, asserted rather than described: no Sentry integration that patches
   * a module survives the filter. Both of these have an OpenTelemetry
   * counterpart installed by the bootstrap, and two patchers on one module is
   * what ADR-0029 measured as `FST_ERR_DEC_ALREADY_PRESENT` at listen time.
   */
  it('drops the two default integrations that instrument a module', () => {
    const kept = sentryIntegrations(Sentry.getDefaultIntegrations({ tracesSampleRate: 1 })).map(
      (integration) => integration.name,
    );
    expect(kept).not.toContain('Http');
    expect(kept).not.toContain('NodeFetch');
    expect(kept).not.toContain('Fastify');
  });

  it('drops every tracing integration, keeping exactly the allowlist', () => {
    const kept = sentryIntegrations(Sentry.getDefaultIntegrations({ tracesSampleRate: 1 })).map(
      (integration) => integration.name,
    );
    expect(new Set(kept)).toEqual(SENTRY_KEPT_INTEGRATIONS);
  });

  /**
   * The failure direction the allowlist was chosen for. A name Sentry has not
   * shipped yet cannot be admitted by this filter, whatever it does.
   */
  it('excludes an unknown integration by default', () => {
    expect(
      sentryIntegrations([{ name: 'SomeFutureTracingIntegration' }, { name: 'LinkedErrors' }]),
    ).toEqual([{ name: 'LinkedErrors' }]);
  });
});

describe('the composite propagator', () => {
  /**
   * MEMBERSHIP, not "the SDK started". `SentryPropagator` alone was measured
   * turning one Temporal round trip into three unrelated traces with baggage
   * `null` on the activity leg, at exit 0 with every component reporting
   * success. The fields are the only place that is visible before it happens.
   */
  it('carries W3C trace context, W3C baggage and Sentry', () => {
    const fields = buildPropagator().fields();
    expect(fields).toContain('traceparent');
    expect(fields).toContain('tracestate');
    expect(fields).toContain('baggage');
    expect(fields).toContain('sentry-trace');
  });
});

describe('the Sentry/OpenTelemetry shared-provider check', () => {
  it('names every piece that has to be installed', () => {
    expect([...REQUIRED_SENTRY_OTEL_PIECES]).toEqual([
      'SentryContextManager',
      'SentryPropagator',
      'SentrySpanProcessor',
      'SentrySampler',
    ]);
  });

  it('reports what a partial setup is missing', () => {
    expect(missingSentryOtelPieces(['SentryContextManager', 'SentryPropagator'])).toEqual([
      'SentrySpanProcessor',
      'SentrySampler',
    ]);
  });

  it('reports nothing when all four registered', () => {
    expect(missingSentryOtelPieces([...REQUIRED_SENTRY_OTEL_PIECES])).toEqual([]);
  });
});

describe('the diag logger', () => {
  /**
   * It exists because `@opentelemetry/api`'s duplicate-registration error goes
   * to `diag`, whose default logger DISCARDS — the one symptom of a whole class
   * of failure whose other symptom is "one backend has no data, at exit 0".
   */
  it('writes one JSON line per call, at the level that was called', () => {
    const written: string[] = [];
    createDiagLogger((line) => written.push(line)).error('Attempted duplicate registration');

    expect(written).toHaveLength(1);
    const line = JSON.parse(written[0] ?? '') as Record<string, unknown>;
    expect(line['level']).toBe('error');
    expect(line['context']).toBe('opentelemetry-diag');
    expect(line['msg']).toBe('Attempted duplicate registration');
  });

  /**
   * This sink runs BEFORE the application's redaction control exists — it has
   * to, because building the Pino logger would load the module the Pino
   * instrumentation has to patch at require time. So it cannot carry an object,
   * and therefore cannot carry a secret inside one.
   */
  it('stringifies its arguments rather than embedding them', () => {
    const written: string[] = [];
    createDiagLogger((line) => written.push(line)).warn('careful', {
      password: 'hunter2',
    });

    const line = JSON.parse(written[0] ?? '') as Record<string, unknown>;
    expect(line['args']).toEqual(['[object Object]']);
    expect(written[0]).not.toContain('hunter2');
  });

  it('maps every diag level, verbose included', () => {
    const written: string[] = [];
    const logger = createDiagLogger((line) => written.push(line));
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    logger.verbose('v');
    expect(written.map((line) => (JSON.parse(line) as Record<string, unknown>)['level'])).toEqual([
      'error',
      'warn',
      'info',
      'debug',
      'trace',
    ]);
  });
});

/**
 * THE CROSS-RUNTIME CONTRACT. These five strings exist in two languages, and
 * nothing mechanical keeps them in agreement: if the Python side spells the
 * baggage key differently, every worker log line silently loses `requestId`, the
 * span is still correctly parented, and no test on either side fails. That is
 * the exact defect shape ADR-0029 records for baggage.
 *
 * This file is read from OUTSIDE this package, so
 * `apps/api/turbo.json` declares it under `$TURBO_ROOT$` in `test:unit`'s
 * `inputs`. Without that declaration Turbo hashes only this package's own files
 * and the gate reports success FROM CACHE while the file it validates has
 * drifted — measured six times across Plans 0B-2 and 0B-3, and measured again
 * here before the declaration was added.
 */
describe('the field names apps/workers reads', () => {
  const workersTelemetry = readFileSync(
    path.join(
      import.meta.dirname,
      '../../workers/packages/metrika_core/src/metrika_core/telemetry.py',
    ),
    'utf8',
  );

  function pythonConstant(name: string): string {
    const match = new RegExp(`^${name} = "([^"]*)"$`, 'm').exec(workersTelemetry);
    if (match?.[1] === undefined) {
      throw new Error(
        `metrika_core/telemetry.py no longer declares ${name} as a module-level string. ` +
          'That is not a reason to relax this test: it is the cross-runtime contract moving.',
      );
    }
    return match[1];
  }

  it('agrees on the baggage key the request id travels under', () => {
    expect(pythonConstant('BAGGAGE_REQUEST_ID')).toBe(BAGGAGE_REQUEST_ID);
  });

  it('agrees on the log field names, camelCase on both sides', () => {
    expect(pythonConstant('FIELD_REQUEST_ID')).toBe(FIELD_REQUEST_ID);
    expect(pythonConstant('FIELD_TRACE_ID')).toBe(LOG_KEYS.traceId);
    expect(pythonConstant('FIELD_SPAN_ID')).toBe(LOG_KEYS.spanId);
  });

  /**
   * `docs/OBSERVABILITY.md` §3's example line is the contract, and
   * `@opentelemetry/instrumentation-pino` emits `trace_id`/`span_id`/
   * `trace_flags` unless `logKeys` says otherwise. This is ADR-0029 obligation 9
   * as an assertion: one Grafana query for `traceId` has to match a Pino line
   * from here and a structlog line from a worker.
   */
  it('keeps the Pino keys camelCase rather than the instrumentation`s default', () => {
    expect(LOG_KEYS).toEqual({ traceId: 'traceId', spanId: 'spanId', traceFlags: 'traceFlags' });
  });
});

/**
 * The span pipeline's redaction, at the level the integration suite cannot reach.
 *
 * `test/telemetry.integration.test.ts` grades this at the export boundary with a
 * real outbound fetch, which is the assertion that matters — but it can only
 * exercise the attributes an instrumentation actually emits. The KEY half of the
 * rule has no live fixture for that reason: nothing here sets
 * `headersToSpanAttributes`, so no span carries a redacted NAME today. It is
 * graded here instead, and the gap is stated rather than left to look covered.
 */
describe('span attribute redaction', () => {
  it('censors an attribute whose NAME is on the shared list', () => {
    const attributes: Record<string, unknown> = {
      'http.request.header.authorization': 'Bearer sk-live-1234',
      'http.route': '/quotes/:id',
    };
    redactSpanAttributes(attributes);

    expect(attributes['http.request.header.authorization']).toBe('[REDACTED]');
    // The negative, so this is not a fixture that would pass by censoring
    // everything: a route template is not a secret and must survive.
    expect(attributes['http.route']).toBe('/quotes/:id');
  });

  it('keeps the host and path of a URL value and censors its query', () => {
    const attributes: Record<string, unknown> = {
      'url.full': 'https://bucket.s3.amazonaws.com/models/m1.stl?X-Amz-Signature=deadbeef',
      'url.query': '?X-Amz-Signature=deadbeef',
      'url.path': '/models/m1.stl',
    };
    redactSpanAttributes(attributes);

    expect(attributes['url.full']).toBe('https://bucket.s3.amazonaws.com/models/m1.stl?[REDACTED]');
    expect(attributes['url.query']).toBe('[REDACTED]');
    expect(attributes['url.path']).toBe('/models/m1.stl');
  });

  /**
   * `url.full` is NOT a redacted name — `isRedactedKey` returns false for it, and
   * correctly, since it is not a spelling of `url`. That is why the URL close is
   * positional, and this asserts the two halves are really two.
   */
  it('is a positional rule, not a name on the shared list', () => {
    expect(isRedactedKey('url.full')).toBe(false);
    expect(isRedactedKey('url.query')).toBe(false);
  });

  it('leaves a URL with no query untouched, marker included', () => {
    expect(redactUrlValue('https://example.com/a/b')).toBe('https://example.com/a/b');
  });

  it('censors a fragment as well as a query', () => {
    expect(redactUrlValue('https://example.com/a#token=abc')).toBe(
      'https://example.com/a?[REDACTED]',
    );
  });

  /**
   * `http.target` is relative by definition, so `new URL(...)` would throw on it.
   * A redaction control that can throw on the export path is worse than the leak
   * it closes, which is why the implementation scans the string.
   */
  it('handles a relative target without throwing', () => {
    expect(redactUrlValue('/models/m1.stl?sig=abc')).toBe('/models/m1.stl?[REDACTED]');
  });

  it('leaves a non-string value alone rather than coercing it', () => {
    const attributes: Record<string, unknown> = { 'url.full': 42 };
    redactSpanAttributes(attributes);
    expect(attributes['url.full']).toBe(42);
  });
});

describe('span trace state redaction', () => {
  function traceStateOf(entries: Record<string, string>): {
    get: (key: string) => string | undefined;
    unset: (key: string) => unknown;
  } {
    const state = { ...entries };
    return {
      get: (key) => state[key],
      unset: (key) => {
        const { [key]: _removed, ...rest } = state;
        return traceStateOf(rest);
      },
    };
  }

  it('removes sentry.url, which is a second copy of the outbound URL', () => {
    const context = {
      traceState: traceStateOf({
        [SENTRY_URL_TRACE_STATE_KEY]: 'https://x/y?X-Amz-Signature=deadbeef',
        other: 'kept',
      }),
    };
    redactSpanTraceState(context);

    expect(context.traceState.get(SENTRY_URL_TRACE_STATE_KEY)).toBeUndefined();
    expect(context.traceState.get('other')).toBe('kept');
  });

  it('leaves a trace state that never carried it alone', () => {
    const before = traceStateOf({ other: 'kept' });
    const context = { traceState: before };
    redactSpanTraceState(context);
    expect(context.traceState).toBe(before);
  });

  it('does nothing when there is no trace state at all', () => {
    const context: { traceState?: ReturnType<typeof traceStateOf> } = {};
    expect(() => {
      redactSpanTraceState(context);
    }).not.toThrow();
  });
});

describe('the redacting span processor', () => {
  /**
   * The processor is a `SpanProcessor` rather than a `beforeSendTransaction` plus
   * an exporter wrapper because ONE hook has to cover two destinations. Its
   * lifecycle methods are asserted because `NodeSDK` calls all four, and one that
   * threw would take the export path down with it.
   */
  it('implements the whole SpanProcessor contract without throwing', async () => {
    const processor = new RedactingSpanProcessor();
    expect(() => {
      processor.onStart();
    }).not.toThrow();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});
