import { loadEnv } from './config/env.js';
import { EnvService } from './config/env.service.js';
import { startTelemetry } from './infrastructure/telemetry/index.js';

/**
 * TELEMETRY FIRST, AND THE DYNAMIC IMPORT IS WHAT MAKES THAT TRUE.
 *
 * `@opentelemetry/instrumentation-pino` and `-nestjs-core` patch their target at
 * REQUIRE time, and ESM evaluates every static import before the first statement
 * of this module — so `import { createApiApp } from './bootstrap.js'` at the top
 * of this file would load `pino`, `fastify` and `@nestjs/core` before
 * `startTelemetry()` could run, and the only symptom would be `traceId` missing
 * from every log line. `import('./bootstrap.js')` below is evaluated where it is
 * written, which is the ordering this needs. `startTelemetry` also refuses to
 * run late rather than degrading quietly — see `loadedTooEarly`.
 *
 * `loadEnv()` is a SECOND parse of the same environment: `ConfigModule`'s
 * factory does the first, and neither can be the other's source, because
 * telemetry has to be running before the Nest injector exists. `parseEnv` is
 * pure and both calls read the same `process.env`, so the two results are
 * identical by construction; the port below still comes from `EnvService`, so
 * nothing about the application's configuration gains a second owner.
 */
async function main(): Promise<void> {
  startTelemetry(loadEnv());

  const { createApiApp } = await import('./bootstrap.js');
  const app = await createApiApp();
  const { values } = app.get(EnvService);
  await app.listen({ port: values.API_PORT, host: '0.0.0.0' });
}

await main();
