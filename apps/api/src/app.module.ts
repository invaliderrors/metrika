import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ZodSerializerInterceptor } from 'nestjs-zod';
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
@Module({
  imports: [ConfigModule, PersistenceModule, HealthModule],
  // The runtime half of ADR-0019's obligation 1. `@ZodResponse` only ATTACHES
  // metadata (ZodSerializerDto + ApiResponse + HttpCode); this interceptor is
  // what reads it and parses the handler's return value. Measured on this exact
  // DTO shape: without this provider a handler returning an out-of-enum value
  // answers `200 {"status":"ok","environment":"staging"}`; with it, 500. The
  // readiness fixture in test/health.integration.test.ts is what goes red if
  // this line is removed — do not delete one without the other.
  //
  // It lives HERE, in the composition root, not in HealthModule. Nest hoists an
  // APP_INTERCEPTOR provider to application scope no matter which module
  // declares it, so both placements behave identically today — the difference is
  // what a reader finds and what a deletion takes with it. Declared inside a
  // feature module, a project-wide guarantee becomes a side effect of that
  // feature: retire or stop importing HealthModule in some later phase and every
  // OTHER controller in the app loses response validation as a side effect —
  // and the health fixture that would have caught it is gone in the same move.
  // ADR-0019 says project-wide, so it is registered project-wide.
  //
  // Not `app.useGlobalInterceptors(...)` in bootstrap.ts either (which is where
  // DomainExceptionFilter is registered): the interceptor takes `Reflector` in
  // its constructor, so the DI form is the one that does not require
  // hand-constructing framework internals.
  providers: [{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }],
})
export class AppModule {}
