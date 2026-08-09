import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { HealthModule } from './modules/health/health.module.js';

// `RequestContextModule` is deliberately NOT imported here, and adding it is a
// silent regression rather than an error: this app has a global prefix, so the
// module's middleware would be mounted under it (missing /health/*, / and every
// unprefixed 404) AND would run a second time on every /api/v1 request, minting
// an id that immediately replaces the one bootstrap.ts already established —
// MEASURED at 2 executions per request. The middleware is registered once,
// globally, in bootstrap.ts. A test in test/request-context.test.ts asserts
// this list stays free of it.
@Module({ imports: [ConfigModule, PersistenceModule, HealthModule] })
export class AppModule {}
