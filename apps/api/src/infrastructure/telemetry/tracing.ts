import { createRequire, register } from 'node:module';
import {
  DiagLogLevel,
  context,
  diag,
  propagation,
  type DiagLogger,
  type TextMapPropagator,
} from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions/incubating';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import * as Sentry from '@sentry/node';
import {
  SentryAsyncLocalStorageContextManager,
  SentryPropagator,
  SentrySampler,
  SentrySpanProcessor,
  openTelemetrySetupCheck,
  setupEventContextTrace,
} from '@sentry/opentelemetry';
import type { Env } from '../../config/env.js';
import { getRequestId } from '../../shared/request-context/request-context.js';

/**
 * The OpenTelemetry + Sentry bootstrap, and the correlation chain it carries.
 *
 * `docs/OBSERVABILITY.md` §2 is one promise: a request ID resolves to one trace
 * across the browser, this API, Temporal and both Python workers. Six things
 * here are load-bearing for that promise and **every one of them fails at exit
 * 0**, killing a different part of the picture with no error anywhere —
 * ADR-0029 measured all six:
 *
 *   1. the initialisation ORDER (Sentry first, `skipOpenTelemetrySetup: true`,
 *      then exactly one `NodeSDK`) — whichever SDK registers the OTel globals
 *      first wins them, and the loser's pipeline is silently dead;
 *   2. the `diag` logger, which is the ONLY thing that makes (1) visible when it
 *      goes wrong: `@opentelemetry/api`'s `registerGlobal` reports a duplicate
 *      registration through `diag`, whose default logger discards everything;
 *   3. the COMPOSITE propagator — `SentryPropagator` alone turns one request
 *      into three unrelated traces and drops baggage on the leg most likely to
 *      have failed;
 *   4. the propagator being passed THROUGH the SDK's own registration —
 *      `propagation.setGlobalPropagator` afterwards is a silent no-op, because
 *      registration has already installed one;
 *   5. Sentry's default integrations being reduced to an explicit allowlist —
 *      the one LOUD failure here (`FST_ERR_DEC_ALREADY_PRESENT`, exit 1, no
 *      boot), **but only once a DSN is configured**, because `@sentry/node`
 *      constructs no integrations at all without one. ADR-0032 mistook that for
 *      the collision being harmless; ADR-0034 carries the 2x2 and the suite now
 *      runs against a real DSN so the control is graded rather than assumed;
 *   6. an explicit `Resource` with no async attributes, so a span processor
 *      never defers an export waiting for detectors to settle.
 *
 * ADR-0031 corrects ADR-0029's obligation 2 for `@sentry/nextjs` only. On
 * `@sentry/node` — which is what this file uses — `defaultIntegrations: false`
 * plus an allowlist is the measured, working form, and the exported
 * `getDefaultIntegrations` IS the set `init` uses, so it can be pinned by a
 * snapshot test. `apps/web` is the one that needs the filter callback instead.
 */

/** `service.name` on every span this process emits. */
export const SERVICE_NAME = 'metrika-api';

/**
 * The baggage key the request ID travels under, spelled exactly as
 * `apps/workers`' `metrika_core.telemetry.BAGGAGE_REQUEST_ID` reads it.
 *
 * Dotted snake_case because it is a W3C `baggage` header value shared with
 * another runtime; the LOG FIELD it becomes on both sides is camelCase
 * (`requestId`), because that is what a single Grafana query has to match
 * across a Pino line and a structlog line. The two conventions meet here and in
 * `metrika_core.telemetry`, once each.
 *
 * MEASURED on the Python side, and worth knowing before writing an assertion
 * against it: dropping BAGGAGE leaves the worker's span correctly parented and
 * merely empties `requestId`, while dropping TRACE CONTEXT is what roots the
 * span. So "the request ID arrived" is not evidence that the trace joined.
 */
export const BAGGAGE_REQUEST_ID = 'metrika.request_id';

/**
 * What a log line calls the three correlation fields.
 *
 * `@opentelemetry/instrumentation-pino` emits `trace_id`, `span_id` and
 * `trace_flags` by default — snake_case — and `docs/OBSERVABILITY.md` §3's
 * example line says `traceId` / `spanId`. ADR-0029 obligation 9 is this
 * disagreement: the `logKeys` option below is what settles it, in favour of the
 * blueprint and of `apps/workers`, which already emits the camelCase spelling.
 */
export const LOG_KEYS = {
  traceId: 'traceId',
  spanId: 'spanId',
  traceFlags: 'traceFlags',
} as const;

/** The log field the request ID is bound to. `metrika_core.telemetry` agrees. */
export const FIELD_REQUEST_ID = 'requestId';

/**
 * The Sentry default integrations this process keeps.
 *
 * **An allowlist, not a denylist, and that is the whole point.** Both were
 * measured producing identical output (ADR-0029), and they differ only in what
 * happens when Sentry ships a new integration: a denylist admits it silently, an
 * allowlist excludes it. `sentryIntegrations` below drops anything not named
 * here, so a forty-fifth span-producing integration arrives switched off and
 * `test/telemetry.test.ts`'s snapshot of the full default set goes red, which is
 * how a human finds out.
 *
 * **The rule that produced this list: no Sentry integration that patches a
 * module.** Module patching in this process belongs to OpenTelemetry — it is
 * what produces the spans the OTLP pipeline exports. Applied to
 * `@sentry/node@10.70.0` that removes exactly two names from the seventeen
 * non-tracing defaults, `Http` and `NodeFetch`, whose OTel counterparts
 * (`instrumentation-http`, `instrumentation-undici`) are installed below. The
 * other twenty-seven of the forty-four appear only when tracing is enabled and
 * are all instrumentations.
 *
 * **REMOVING THIS LIST EXITS 1 — once a DSN is configured, and only then.**
 * Sentry's `Fastify` integration and `@fastify/otel` both
 * `decorateRequest('opentelemetry', …)`, and the second throws
 * `FastifyError: The decorator 'opentelemetry' has already been added!` before
 * the process listens. Measured 2×2, because the second variable is what makes
 * the first one gradeable: `@sentry/node` never reaches `_setupIntegrations()`
 * for a client with no DSN, so with `SENTRY_DSN` empty this list is subtracted
 * from an empty set and removing it changes nothing at all. ADR-0032 measured
 * exactly that and concluded the collision was harmless; ADR-0034 carries the 2x2.
 * `test/telemetry.integration.test.ts` now runs the child against a real DSN and
 * asserts the produced integration names, so this is a control with a fixture.
 *
 * **This list has FIFTEEN names and ADR-0029 says fourteen.** The count is not
 * reproduced and is not treated as a pin: ADR-0030's own correction records that
 * ADR-0029's round 1 stated "twenty-two names" which "was the size of the
 * exclusion set it happened to write rather than a fact about Sentry", and the
 * same reading applies to "fourteen error-side". What IS reproduced here, and is
 * asserted in `test/telemetry.test.ts`, is the measurement the obligation rests
 * on: `getDefaultIntegrations({ tracesSampleRate: 1 })` returns **44**, the bare
 * call returns **17**, and this set is a subset of both minus the two patchers.
 * Which of the fifteen a reader would call "error-side" is a judgement; that the
 * fifteen patch nothing is checkable.
 *
 * `ProcessSession` is deliberately kept even though it is release health rather
 * than errors: `docs/OBSERVABILITY.md` §1 names release health as one of the
 * three reasons this project pays for Sentry at all.
 */
export const SENTRY_KEPT_INTEGRATIONS: ReadonlySet<string> = new Set([
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
]);

/**
 * The modules whose instrumentation is installed by patching them AT REQUIRE
 * TIME, so that loading one before {@link startTelemetry} runs silently
 * un-instruments it.
 *
 * `@fastify/otel` is deliberately absent: its `init()` returns `[]` and it
 * registers through the `fastify.initialization` diagnostics channel instead, so
 * it only needs to be enabled before `fastify()` is CALLED, not before the
 * module is loaded. `pino`, `http` and `@nestjs/core` are the ones where load
 * order decides whether the instrumentation exists at all.
 */
const REQUIRE_TIME_INSTRUMENTED = ['pino', '@nestjs/core'] as const;

/**
 * The already-loaded modules among {@link REQUIRE_TIME_INSTRUMENTED}, given the
 * keys of the CommonJS require cache.
 *
 * Pure, and separated from the cache it reads for exactly one reason: the thing
 * it guards can only be exercised once per process, so a fixture that drove it
 * through `startTelemetry` could assert one outcome and never the other.
 *
 * The failure this exists to convert is silent. `require-in-the-middle` hooks
 * future `require` calls only, and nothing in `@opentelemetry/instrumentation`
 * warns about a module that was already resident: the SDK starts, exits 0,
 * produces spans from `@fastify/otel` — and every Pino line is missing `traceId`
 * because the module those fields come from was patched too late.
 */
export function loadedTooEarly(cacheKeys: Iterable<string>): readonly string[] {
  const found = new Set<string>();
  for (const key of cacheKeys) {
    for (const name of REQUIRE_TIME_INSTRUMENTED) {
      if (key.includes(`/node_modules/${name}/`)) found.add(name);
    }
  }
  return [...found];
}

/**
 * Keeps the Sentry defaults this process wants, by name.
 *
 * Pure and exported so the allowlist is graded against the REAL default set
 * rather than against a list a fixture restates — a hand-copied expectation is
 * green on the day a Sentry release renames something.
 */
export function sentryIntegrations<T extends { readonly name: string }>(
  defaults: readonly T[],
): T[] {
  return defaults.filter((integration) => SENTRY_KEPT_INTEGRATIONS.has(integration.name));
}

/**
 * The propagator, as a value, so a test can assert its MEMBERSHIP rather than
 * that "the SDK started".
 *
 * `SentryPropagator` alone was measured turning one Temporal round trip into
 * three unrelated traces with baggage `null` on the activity leg — at exit 0,
 * with every component reporting success. Nothing else in the system points at
 * it, so the composite is the control and this function exists to make it
 * assertable.
 *
 * Order is W3C trace context, W3C baggage, Sentry. `CompositePropagator.inject`
 * runs every member, so all three sets of headers go out; `extract` runs them in
 * order and each adds to the context the previous one produced.
 */
export function buildPropagator(): TextMapPropagator {
  return new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
      new SentryPropagator(),
    ],
  });
}

/**
 * The four pieces `@sentry/opentelemetry` reports as installed, which is how
 * "Sentry and OpenTelemetry are sharing one provider" is checked rather than
 * assumed.
 *
 * `Sentry.validateOpenTelemetrySetup()` exists and does this — but it returns
 * immediately unless the SDK is a debug build, so in a normal install it is a
 * no-op and asserts nothing. `openTelemetrySetupCheck()` is the underlying
 * function and works in every build.
 */
export const REQUIRED_SENTRY_OTEL_PIECES = [
  'SentryContextManager',
  'SentryPropagator',
  'SentrySpanProcessor',
  'SentrySampler',
] as const;

/** Which of {@link REQUIRED_SENTRY_OTEL_PIECES} the check did not report. */
export function missingSentryOtelPieces(installed: readonly string[]): readonly string[] {
  return REQUIRED_SENTRY_OTEL_PIECES.filter((piece) => !installed.includes(piece));
}

/**
 * A `diag` sink that does not depend on Pino, and that is a constraint rather
 * than a preference.
 *
 * The logger has to be installed BEFORE the first `registerGlobal` call, which
 * is inside `Sentry.init()`; and `createLogger` reaches `pino`, so building one
 * here would load the module `PinoInstrumentation` has to patch at require time
 * and take `traceId` off every log line in the process. Two structured sinks is
 * the price of seeing the failure class that has no other symptom.
 *
 * `process.stderr` rather than `console.*`: `no-console` is an error in this
 * repository, and these lines are the bootstrap's own diagnostics — they belong
 * on the error stream, before the application's sink exists.
 */
export function createDiagLogger(write: (line: string) => void): DiagLogger {
  const emit =
    (level: string) =>
    (message: string, ...args: unknown[]): void => {
      write(
        `${JSON.stringify({
          level,
          time: new Date().toISOString(),
          context: 'opentelemetry-diag',
          msg: message,
          // `String(...)` rather than the values: `diag`'s arguments are
          // whatever an instrumentation passed, and this sink runs before the
          // redaction control exists. A shape that cannot carry an object
          // cannot carry a secret inside one.
          args: args.map((arg) => String(arg)),
        })}\n`,
      );
    };
  return {
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    verbose: emit('trace'),
  };
}

export interface TelemetryHandle {
  /** Exports whatever is buffered. The suite uses it; a deployment does not. */
  readonly forceFlush: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

export type TelemetryEnv = Pick<
  Env,
  'NODE_ENV' | 'SENTRY_DSN' | 'OTLP_TRACES_ENDPOINT' | 'TRACES_SAMPLE_RATE'
>;

let started = false;

/**
 * Starts the one `NodeSDK` this process gets, with Sentry sharing its provider.
 *
 * **Call this before the application graph is loaded.** `main.ts` does it with a
 * dynamic `import()` of `bootstrap.js`, which is the only way to order a
 * side effect against ESM's hoisted imports. {@link loadedTooEarly} turns the
 * mistake into a thrown error instead of a quietly degraded process.
 */
export function startTelemetry(
  env: TelemetryEnv,
  options?: { readonly requireCache?: Iterable<string> },
): TelemetryHandle {
  if (started) {
    throw new Error(
      'startTelemetry() was called twice. The OpenTelemetry globals accept exactly one ' +
        'registration and refuse the second through `diag`, so a second call would leave ' +
        'half of this process reporting into a pipeline nothing reads.',
    );
  }

  // `createRequire(...).cache` is the CommonJS require cache, read from ESM.
  // There is no ESM equivalent to inspect, and there does not need to be: every
  // module in REQUIRE_TIME_INSTRUMENTED ships CommonJS.
  const late = loadedTooEarly(
    options?.requireCache ?? Object.keys(createRequire(import.meta.url).cache),
  );
  if (late.length > 0) {
    throw new Error(
      `startTelemetry() ran after ${late.join(', ')} had already been loaded. ` +
        'require-in-the-middle patches future requires only, so those modules are now ' +
        'permanently un-instrumented — for `pino` that means every log line in this ' +
        'process loses traceId and spanId, with no other symptom. Import this module and ' +
        'call this function before the application graph, as main.ts does.',
    );
  }
  started = true;

  // FIRST, and before anything can call `registerGlobal`. See createDiagLogger.
  diag.setLogger(
    createDiagLogger((line) => {
      process.stderr.write(line);
    }),
    DiagLogLevel.WARN,
  );

  // ESM loader hook. MEASURED NOT REQUIRED TODAY (ADR-0029 answer 1): with it
  // disabled the span set is byte-identical, because `fastify`, `@nestjs/*` and
  // `pino` all ship CommonJS and are reached through the CJS loader that
  // require-in-the-middle patches. It stays as insurance for the first
  // instrumented dependency that ships native ESM — and it is recorded here so
  // that nobody removes it believing it was load-bearing, or keeps it believing
  // it is.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  // Sentry FIRST, because `SentrySampler` and `setupEventContextTrace` need a
  // client — and `skipOpenTelemetrySetup`, because the ONE configuration in
  // which neither pipeline goes dark is a single `NodeSDK` carrying Sentry's
  // processor, propagator, sampler and context manager. Sentry-first WITHOUT the
  // flag kills OTLP export; OTel-first kills Sentry performance monitoring. Both
  // exit 0 and keep delivering Sentry errors, which is what makes the wrong one
  // so easy to ship.
  const client = Sentry.init({
    dsn: env.SENTRY_DSN === '' ? undefined : env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // Not optional plumbing: `SentrySampler` returns NOT_RECORD for every span
    // when `hasSpansEnabled(options)` is false, and a non-recording span still
    // carries a perfectly valid trace ID. So without a sample rate the log lines
    // would still show `traceId` and nothing would ever be exported — a broken
    // pipeline wearing the evidence of a working one.
    tracesSampleRate: env.TRACES_SAMPLE_RATE,
    skipOpenTelemetrySetup: true,
    defaultIntegrations: false,
    integrations: sentryIntegrations(Sentry.getDefaultIntegrations({})),
    // One ESM loader hook in this process, and it is the one registered above.
    // Sentry's exists so ITS instrumentations can patch ESM dependencies, and
    // the allowlist keeps none of those; ADR-0029 records the duplicate as a
    // benign `import-in-the-middle hook has already been initialized` warning at
    // boot, which is a line an operator would reasonably read as a fault.
    registerEsmLoaderHooks: false,
  });
  if (client === undefined) {
    throw new Error('Sentry.init() returned no client, so SentrySampler cannot be constructed.');
  }

  // Attaches the active trace to every ERROR event, which is what makes a Sentry
  // issue reachable from a trace ID and back. `@sentry/node-core@10.70.0` calls
  // this inside `init()` already (`sdk/index.js:90`) whether or not
  // `skipOpenTelemetrySetup` is set; ADR-0029 obligation 1 asks for it
  // explicitly, and the second registration adds one idempotent `preprocessEvent`
  // listener that writes the same trace context. Kept explicit so the obligation
  // does not depend on an internal call staying where it is.
  setupEventContextTrace(client);

  const flushable: SpanProcessor[] = [
    // Sentry's processor, on the SAME provider as the OTLP one below. This is
    // the shared-provider configuration in one line.
    new SentrySpanProcessor(),
  ];
  if (env.OTLP_TRACES_ENDPOINT !== '') {
    // Batch, not Simple: this is a long-lived server and one HTTP request per
    // span is a second workload. Constructed only when an endpoint is
    // configured — `NodeSDK` otherwise falls back to `getSpanProcessorsFromEnv`,
    // which builds an OTLP exporter pointed at localhost:4318 and fills a
    // developer's terminal with connection errors.
    flushable.push(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: env.OTLP_TRACES_ENDPOINT })),
    );
  }

  const sdk = new NodeSDK({
    // ADR-0029 obligation 11, and the mechanism is worth stating because the
    // obligation reads like tidiness: a resource with ASYNC attributes makes a
    // span processor defer every export until they settle, and a short-lived
    // process then exports nothing while looking identical to an SDK that never
    // started. `autoDetectResources: false` is what guarantees this resource has
    // none. The cost is that `OTEL_RESOURCE_ATTRIBUTES` is not merged; a
    // deployment that needs region or version adds a detector here, visibly.
    autoDetectResources: false,
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.NODE_ENV,
    }),
    sampler: new SentrySampler(client),
    spanProcessors: flushable,
    // THROUGH the SDK's registration. `propagation.setGlobalPropagator(...)`
    // after `start()` is a silent no-op — registration has already installed
    // one, and `registerGlobal` refuses the second while writing to `diag`.
    // ADR-0029 records a whole spike measurement that was invalid because of it.
    textMapPropagator: buildPropagator(),
    // Sentry's own ALS context manager, so a Sentry scope follows the OTel
    // context. Plan 0B-1's request context is a SEPARATE `AsyncLocalStorage`,
    // and question 3 of the spike was whether this displaces it: measured 0 of 7
    // probes lost. `test/telemetry.integration.test.ts` asserts it again here,
    // on this application's own middleware, because that answer is a property of
    // a version rather than of the design.
    //
    // NOT `wrapContextManagerClass(AsyncLocalStorageContextManager)`, which is
    // what ADR-0029 obligation 1 names: `@sentry/opentelemetry@10.70.0` marks it
    // `@deprecated` in favour of this class, which the SDK builds from
    // `node:async_hooks` directly and which calls the same
    // `setIsSetup('SentryContextManager')` in its constructor — so
    // `openTelemetrySetupCheck()` sees it identically. It is also why
    // `@opentelemetry/context-async-hooks` is NOT a dependency of this package,
    // against ADR-0029's table: nothing imports it any more, and ADR-0023's rule
    // is that a package is declared where it is imported and nowhere else.
    contextManager: new SentryAsyncLocalStorageContextManager(),
    instrumentations: [
      new HttpInstrumentation(),
      // Node 24's `fetch` is undici, `instrumentation-http` does not cover it,
      // and an uninstrumented outbound call was measured producing NO span at
      // all rather than a poor one.
      new UndiciInstrumentation(),
      new NestInstrumentation(),
      new PinoInstrumentation({
        logKeys: LOG_KEYS,
        // ADR-0029 obligation 9: decided, not defaulted. The default is `false`,
        // which ships every Pino record to the OpenTelemetry Logs SDK as well —
        // a second log path and a second exporter that nothing in this plan
        // builds, wrapping the application's only stream in a `multistream` on
        // the way. Turn it on with the pipeline that consumes it.
        disableLogSending: true,
        // THE CORRELATION CHAIN'S SECOND HALF. The mixin above supplies
        // `traceId`/`spanId` from the live span; this supplies the request ID
        // from Plan 0B-1's `AsyncLocalStorage`, so a single log line carries
        // both without any call site passing anything.
        //
        // `getRequestId()` and not `getRequestContext()?.requestId`: inside a
        // request span there is always a context, so `unknown` here means the
        // ALS binding was lost — and a field that says so is worth more than an
        // absent one, which reads as "this line is not from a request". That is
        // the distinction `NO_REQUEST_ID`'s own comment exists for.
        //
        // The hook runs only when the span context is valid, so lines outside a
        // request carry no `requestId` at all rather than a sentinel.
        logHook: (_span, record): void => {
          record[FIELD_REQUEST_ID] = getRequestId();
        },
      }),
      // NAMED import — it is CJS `export =`, and a default import is `TS2351:
      // this expression is not constructable` under nodenext.
      //
      // `registerOnInitialization` and a manual `.register(instrumentation
      // .plugin())` are mutually exclusive: both throws
      // `FST_ERR_DEC_ALREADY_PRESENT: The decorator 'Symbol(fastify otel
      // instance)' has already been added!` and exits 1. This one subscribes to
      // the `fastify.initialization` diagnostics channel, so it patches no
      // module and only has to be enabled before `new FastifyAdapter()` calls
      // `fastify()` — which is why it is the one instrumentation here that load
      // order cannot silently disable.
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });

  sdk.start();

  const missing = missingSentryOtelPieces(openTelemetrySetupCheck());
  if (missing.length > 0) {
    throw new Error(
      `Sentry and OpenTelemetry are not sharing a provider: ${missing.join(', ')} did not register. ` +
        'Sentry would keep delivering errors and the OTLP pipeline would export nothing, at exit 0.',
    );
  }

  return {
    forceFlush: async (): Promise<void> => {
      await Promise.all(flushable.map(async (processor) => processor.forceFlush()));
    },
    shutdown: async (): Promise<void> => {
      await sdk.shutdown();
    },
  };
}

/**
 * The request ID, as OTel baggage, so it crosses a process boundary.
 *
 * Separate from `runWithRequestContext` because the two mechanisms fail
 * separately and the Python side reads them separately: trace context is what
 * PARENTS a worker's span, baggage is what carries the request ID onto its log
 * lines. Dropping baggage leaves a correctly parented span with an empty
 * `requestId`; dropping trace context roots the span. A fixture that asserts
 * only the ID would pass through the second failure.
 */
export function withRequestBaggage<T>(requestId: string, fn: () => T): T {
  const active = context.active();
  const existing = propagation.getBaggage(active) ?? propagation.createBaggage();
  return context.with(
    propagation.setBaggage(active, existing.setEntry(BAGGAGE_REQUEST_ID, { value: requestId })),
    fn,
  );
}
