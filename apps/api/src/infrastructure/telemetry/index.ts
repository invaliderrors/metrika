/**
 * The telemetry entry point, and the reason it is an entry point rather than a
 * convenience re-export.
 *
 * Two of the three instrumentations this process installs patch their target AT
 * REQUIRE TIME, so `startTelemetry()` has to run before the application graph is
 * loaded — and ESM hoists every `import` above every statement, which means the
 * ordering cannot be expressed by import position alone. `main.ts` imports THIS
 * module statically, calls `startTelemetry()`, and only then reaches
 * `./bootstrap.js` through a dynamic `import()`. Anything that wants telemetry
 * running should follow the same two steps and import this file, not
 * `./tracing.js`, so the constraint is stated by the module it imports.
 *
 * `logger.ts` and `redaction.ts` are deliberately NOT re-exported here. They are
 * imported directly by the things that use them, and adding them would give this
 * module a `pino` import — which is precisely the module load that
 * `startTelemetry()` refuses to run after.
 */
export {
  BAGGAGE_REQUEST_ID,
  FIELD_REQUEST_ID,
  LOG_KEYS,
  REQUIRED_SENTRY_OTEL_PIECES,
  SENTRY_KEPT_INTEGRATIONS,
  SERVICE_NAME,
  buildPropagator,
  createDiagLogger,
  loadedTooEarly,
  missingSentryOtelPieces,
  sentryIntegrations,
  startTelemetry,
  withRequestBaggage,
  type TelemetryEnv,
  type TelemetryHandle,
} from './tracing.js';
