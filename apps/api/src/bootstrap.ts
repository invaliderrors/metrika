import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { DomainExceptionFilter } from './shared/errors/domain-exception.filter.js';
import { RequestContextMiddleware } from './shared/request-context/request-context.middleware.js';

export const API_PREFIX = 'api/v1';

/**
 * One bootstrap, used by main.ts and by every integration test. Tests that
 * construct their own module graph cannot catch a wiring mistake in the real
 * one, and wiring mistakes are the defect class this app is most exposed to.
 */
export async function createApiApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health/live', 'health/ready', 'health/deep'] });
  app.useGlobalFilters(new DomainExceptionFilter());

  // The request id is established here, at the adapter, rather than through a
  // module with `consumer.apply(...).forRoutes('{*splat}')` — which is the
  // obvious shape and does not work under a global prefix on platform-fastify.
  //
  // MEASURED against @nestjs/platform-fastify@11.1.28 + @nestjs/core@11.1.28.
  // Nest's core RouteInfoPathExtractor resolves the wildcard route correctly,
  // INCLUDING the prefix-excluded probes:
  //
  //   ['/api/v1$', '/api/v1/{*splat}', '/health/live', '/health/ready', '/health/deep']
  //
  // and then FastifyAdapter.createMiddlewareFactory unconditionally re-prefixes
  // any mount path that does not already start with the global prefix, giving:
  //
  //   ['/api/v1', '/api/v1/{*splat}', '/api/v1/health/live', '/api/v1/health/ready', ...]
  //
  // The last three are paths that do not exist, so the probes — and `/`, and
  // any 404 outside the prefix — would carry no request id at all, silently.
  // `app.use()` takes a different route through the adapter: it forwards
  // straight to middie with no path, so it matches every request, and
  // `httpAdapter.init()` flushes it before `registerModules()` runs, which puts
  // it ahead of every other middleware. Nothing that logs or throws runs
  // without an id.
  //
  // Keep the assertions in test/request-context.integration.test.ts that hit
  // `/health/live` and `/`: they are what caught this, and they are what would
  // catch a well-meaning move back to `MiddlewareConsumer`.
  const requestContext = new RequestContextMiddleware();
  app.use(requestContext.use.bind(requestContext));

  app.enableShutdownHooks();
  return app;
}
