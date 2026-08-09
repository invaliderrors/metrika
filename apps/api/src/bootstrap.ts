import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { DomainExceptionFilter } from './shared/errors/domain-exception.filter.js';
import { handleFrameworkError } from './shared/errors/framework-error.handler.js';
import { RequestContextMiddleware } from './shared/request-context/request-context.middleware.js';

export const API_PREFIX = 'api/v1';

/**
 * Fastify's `frameworkErrors` hook type, taken from the FastifyAdapter's own
 * constructor rather than by importing `FastifyServerOptions` from `fastify`.
 *
 * Not a flourish: there are TWO Fastify copies in this tree — `apps/api` depends
 * on 5.6.1 and `@nestjs/platform-fastify@11.1.28` resolves 5.10.0 — so the
 * identically-named types come from different packages and are not assignable to
 * one another (TS2322 naming both `.pnpm/fastify@5.6.1/...` and
 * `.pnpm/fastify@5.10.0/...`). Deriving the type from the adapter is what makes
 * this correct WHICHEVER copy `apps/api` is pinned to. Deduplicating the two is
 * the real fix and is a dependency decision, not this file's.
 */
type FrameworkErrorsHook = NonNullable<
  Extract<
    NonNullable<ConstructorParameters<typeof FastifyAdapter>[0]>,
    { frameworkErrors?: unknown }
  >['frameworkErrors']
>;

/**
 * One bootstrap, used by main.ts and by every integration test. Tests that
 * construct their own module graph cannot catch a wiring mistake in the real
 * one, and wiring mistakes are the defect class this app is most exposed to.
 */
export async function createApiApp(): Promise<NestFastifyApplication> {
  // `frameworkErrors` catches what find-my-way raises BEFORE Nest's pipeline
  // exists — a malformed percent-escape in the path, say. Those responses
  // bypass both the exception filter and the request-context middleware, and
  // MEASURED they went out in Fastify's own shape with no request id anywhere.
  // See handleFrameworkError.
  //
  // `handleFrameworkError` cannot be made assignable to Fastify's declared hook
  // type, and the assertion below is the whole of the workaround. MEASURED, all
  // of these are TS2322: annotating the handler with `FastifyRequest`/
  // `FastifyReply` (the hook's request is `FastifyRequest<RequestGeneric, …>`
  // while the alias defaults to `RouteGenericInterface`), narrowing the
  // parameters structurally, and making the handler generic over them. The
  // irreducible part is `FastifyReply['send']`, typed `(...args: SendArgs<ReplyType>)`
  // — a rest tuple that stays opaque until the hook's type parameters are
  // instantiated, so nothing concrete satisfies it. An inline arrow gets TS7006
  // instead, because `FastifyAdapter`'s constructor parameter is a UNION of
  // option shapes and suppresses contextual typing.
  //
  // What the assertion claims is proved at runtime, not believed:
  // test/framework-error.integration.test.ts drives a malformed URL through
  // THIS bootstrap and asserts the envelope, the status, the absence of Fastify
  // internals and the request id on both the body and the header.
  const frameworkErrors = handleFrameworkError as FrameworkErrorsHook;
  const adapter = new FastifyAdapter({ frameworkErrors });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
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
