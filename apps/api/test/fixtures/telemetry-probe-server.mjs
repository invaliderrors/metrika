// The REAL built application, in a REAL Node process, with one route added from
// the outside. `test/telemetry.integration.test.ts` spawns this.
//
// WHY A CHILD PROCESS AT ALL — this is a measurement, not a preference.
// `require-in-the-middle` is what `@opentelemetry/instrumentation-pino` and
// `-http` and `-nestjs-core` patch through, and it does NOT intercept module
// loading under Vitest: measured in this repository, `startTelemetry()` then
// `createLogger()` inside a Vitest worker emits
//   {"level":30,...,"msg":"hello"}
// with no `traceId` at all, while the identical five lines under plain `node`
// emit
//   {"level":"info",...,"traceId":"1a598b…","spanId":"3b89…","requestId":"unknown",…}
// So an in-process suite would have asserted the absence of the very mechanism
// this plan delivers, and would have been red for a reason that has nothing to
// do with the application. Only `@fastify/otel` and `-undici` survive in
// Vitest, because both hook `diagnostics_channel` rather than the module loader
// — which is precisely the shape of a harness that reports on itself instead of
// on its subject.
//
// WHY A ROUTE HAS TO BE ADDED. This application deliberately has no route that
// logs during a successful request: the only Pino call site is the exception
// filter, and `test/error-filter.integration.test.ts` records that there is
// deliberately no route that throws either. `pino-http` belongs to the task that
// wires request logging. So the correlation property needs a call site, and this
// is the smallest one that changes nothing else.
//
// WHY `diagnostics_channel` AND NOT AN EDIT TO `bootstrap.ts`. `fastify`
// publishes `fastify.initialization` when an instance is constructed, which is
// the same seam `@fastify/otel` registers through. Subscribing here means the
// child runs `dist/main.js` UNMODIFIED — the same entry point, the same
// telemetry-before-application ordering, the same bootstrap — and the probe is
// attached from outside it, the way an APM agent would be. Nothing in `src/`
// knows this file exists.
//
// `process.argv[2]` rather than an environment variable: `no-restricted-properties`
// bans `process.env` outside `src/config/env.ts`, and the ban is right — the
// child's own configuration reaches it through the environment `spawn` gives it,
// and is read by `loadEnv()` exactly once, in the application.
import diagnosticsChannel from 'node:diagnostics_channel';

const [, , echoUrl] = process.argv;
if (typeof echoUrl !== 'string' || echoUrl === '') {
  throw new Error('usage: node telemetry-probe-server.mjs <echo-url>');
}

/** Built on first use, which is AFTER `startTelemetry()` has patched `pino`. */
let logger;

diagnosticsChannel.subscribe('fastify.initialization', ({ fastify }) => {
  fastify.get('/telemetry-probe', async () => {
    // The REAL `createLogger`, writing to its own default destination, which is
    // stdout — the sink a deployment reads. A fixture that rebuilt Pino with the
    // same options would grade a copy of the control.
    logger ??= (await import('../../dist/infrastructure/telemetry/logger.js')).createLogger({
      LOG_LEVEL: 'info',
    });

    // THREE lines, and the second and third are the point. ADR-0029's question 3
    // was whether OpenTelemetry's context manager displaces the
    // `AsyncLocalStorage` the request context runs on. It measured 0 of 7 probes
    // lost — but that is a property of a version rather than of the design, so
    // it is re-asserted here across an `await` and after an instrumented
    // outbound call, which are the two places a context manager loses a store.
    logger.info('probe: in the handler');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    logger.info('probe: after an await');
    await fetch(echoUrl);
    logger.info('probe: after an outbound call');
    return { ok: true };
  });
});

// The unmodified entry point. It starts telemetry and only then reaches the
// application graph, and it resolves once the server is listening.
await import('../../dist/main.js');

// Facts that are only observable from INSIDE the process, reported on the same
// stdout the logs use. `openTelemetrySetupCheck()` is what separates "Sentry and
// OpenTelemetry share one provider" from the configuration where one of them
// silently owns the globals and the other's pipeline is dead at exit 0;
// `propagation.fields()` is what separates the composite propagator from
// `SentryPropagator` alone.
const { openTelemetrySetupCheck } = await import('@sentry/opentelemetry');
const { propagation, trace } = await import('@opentelemetry/api');
const Sentry = await import('@sentry/node');

// `trace.getTracerProvider()` ALWAYS returns the API's `ProxyTracerProvider`, so
// its own constructor name says nothing at all — a check against it would pass
// in every configuration, including the broken one it was written for.
// `getDelegate()` is what names the provider that actually registered.
const proxy = trace.getTracerProvider();
const provider = typeof proxy.getDelegate === 'function' ? proxy.getDelegate() : proxy;

// THE ACTIVE Sentry integrations, and they are reported from here because there
// is nowhere else they exist. `getDefaultIntegrations()` is what the allowlist is
// SUBTRACTED FROM; `client._integrations` is what the allowlist PRODUCED, and
// only the second one moves when the allowlist is removed.
//
// This is empty unless a DSN is set — `_setupIntegrations()` is not reached
// without one — which is why the suite that reads this line runs the child
// against a local Sentry sink. The first version of this fixture pinned
// `SENTRY_DSN: ''`, and every Sentry assertion in the suite was therefore
// grading a client with nothing installed.
const client = Sentry.getClient();
const integrations = client === undefined ? [] : Object.keys(client['_integrations'] ?? {});

// `getDsn()`, NOT `getOptions().dsn`. MEASURED, all three cases:
//
//   SENTRY_DSN=''          getOptions().dsn === ''          getDsn() undefined  integrations 0
//   SENTRY_DSN='not-a-dsn' getOptions().dsn === 'not-a-dsn' getDsn() undefined  integrations 0
//   a real DSN             the DSN                          getDsn() set        integrations 15
//
// `@sentry/node-core`'s `getClientOptions` does `dsn: options.dsn ?? process.env.SENTRY_DSN`,
// so an empty string is echoed straight back and `getOptions().dsn !== undefined`
// is TRUE for the exact state this field exists to catch — a client with no DSN,
// which constructs no integrations at all. `getDsn()` is the parsed value and is
// undefined for both the empty and the malformed case.
const dsnParsed = client?.getDsn() !== undefined;

process.stdout.write(
  `${JSON.stringify({
    probe: 'ready',
    installed: openTelemetrySetupCheck(),
    provider: provider.constructor.name,
    fields: propagation.fields(),
    integrations,
    dsnParsed,
  })}\n`,
);
