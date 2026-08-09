import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { HealthModule } from './modules/health/health.module.js';

// The request-context middleware is deliberately NOT a module imported here.
// It has to run before every request on every path, including the health
// probes that are excluded from the global prefix, and `MiddlewareConsumer`
// cannot express that on platform-fastify — see the comment in bootstrap.ts.
@Module({ imports: [ConfigModule, PersistenceModule, HealthModule] })
export class AppModule {}
