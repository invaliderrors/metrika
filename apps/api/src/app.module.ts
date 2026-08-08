import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { RequestContextMiddleware } from './infrastructure/telemetry/request-context.middleware.js';
import { HealthModule } from './modules/health/health.module.js';
import { DomainExceptionFilter } from './shared/exception-filter.js';

@Module({
  imports: [HealthModule],
  providers: [
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
