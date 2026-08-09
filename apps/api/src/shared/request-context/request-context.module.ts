import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RequestContextMiddleware } from './request-context.middleware.js';

/**
 * For Nest applications that have NO global prefix — in practice the standalone
 * module trees that tests assemble around a single controller.
 *
 * **Do not add this to `AppModule.imports`.** The composed app sets a global
 * prefix, and `MiddlewareConsumer` cannot escape it on platform-fastify:
 * `FastifyAdapter.createMiddlewareFactory` re-prefixes every mount path, so the
 * routes excluded from the prefix (`/health/*`), the bare `/`, and every 404
 * outside `/api/v1` would silently carry no request id. `bootstrap.ts`
 * registers the same middleware globally with `app.use()` for that reason, and
 * MEASURED, importing this module as well runs the middleware TWICE per request
 * under `/api/v1`: the outer `app.use()` run mints an id and the inner run
 * immediately replaces it. Nothing on the wire changes, so the first thing to
 * surface it would be Plan 0C's access log recording a different id than the
 * error body carried.
 *
 * TWO guards, covering different spellings — neither is redundant:
 *
 * - `test/request-context.test.ts` asserts `AppModule.imports` does not contain
 *   this module. MEASURED: that catches a direct import and a
 *   `[...BASE, RequestContextModule]` spread, and MISSES a dynamic
 *   `RequestContextModule.forRoot()` and a transitive import through another
 *   module — both of which leave `imports` without this class in it.
 * - `test/request-context.integration.test.ts` asserts the middleware runs
 *   exactly once per request under the prefix. That is the general guard: it
 *   sees every spelling, including the two the unit test cannot.
 *
 * This is no longer a local-only control. Task 13 added the `test:integration`
 * job, so a direct import now exits 1 in CI on both counts rather than on
 * neither.
 */
@Module({})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Braced named wildcard. Verified against @nestjs/platform-fastify@11.1.28
    // with path-to-regexp@8.4.2:
    //
    //   '{*splat}'  matches '/' AND every nested path.        <- what we want
    //   '*splat'    starts cleanly and SILENTLY never matches the bare '/'.
    //   '*'         also works, but only because an undocumented
    //               LegacyRouteConverter inside the Fastify adapter rewrites it
    //               to '{*path}' and deliberately suppresses the deprecation
    //               warning. That is an internal compatibility shim, not a
    //               contract, and it can be tightened in any Nest minor.
    //
    // The literal is pinned by a test, because two of the three forms above are
    // wrong in ways that produce no error.
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
