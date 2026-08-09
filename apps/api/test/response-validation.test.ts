import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ZodSerializerInterceptor } from 'nestjs-zod';
import { AppModule } from '../src/app.module.js';

/**
 * ADR-0019 obligation 1 says response validation is ON project-wide, and names
 * two registrations that both have to be present. This file pins the runtime
 * half.
 *
 * Sibling of the `Reflect.getMetadata('imports', AppModule)` assertion in
 * test/request-context.test.ts, and for the same reason: a `@Module()`
 * decorator's argument is data, so a deletion from it is invisible to `tsc` and
 * to eslint, and the only thing that reads it is Nest at boot.
 *
 * It exists because the OTHER guard on this provider is indirect. The canary in
 * test/health.integration.test.ts fires only because `HealthController.ready()`
 * deliberately over-returns `latencyMs` and lets the response schema strip it —
 * so a tidy-up of the CONTROLLER disarms the test that protects the MODULE.
 * MEASURED, both steps green: rewriting `ready()` as
 * `checks: results.map(({ name, status }) => ({ name, status }))` leaves the
 * suite at 100%, and deleting the interceptor provider afterwards ALSO leaves it
 * at 100%. Two innocuous commits, project-wide response validation off, nothing
 * red. This assertion breaks that chain at the module, and the `latencyMs`
 * assertion in the health suite breaks it at the controller.
 *
 * What it does NOT cover, deliberately: this reads decorator metadata and never
 * boots Nest, so it cannot prove the interceptor RUNS. Nothing here pins
 * AppModule as the root passed to NestFactory.create — swap the root module and
 * this stays green. Runtime proof is the health suite's job.
 *
 * It also pins the SHAPE of the registration, not the fact of validation being
 * on: an equivalent `useFactory` binding of the same interceptor, or
 * registration from a submodule (Nest hoists any APP_INTERCEPTOR regardless of
 * declaring module), fails here while validation is genuinely on. MEASURED.
 * That is a false positive in the safe direction — but if you arrive here after
 * such a refactor, update the assertion; you have not found a real bug.
 */
describe('AppModule providers', () => {
  it('registers ZodSerializerInterceptor globally — @ZodResponse validates nothing without it', () => {
    const providers: unknown = Reflect.getMetadata('providers', AppModule);
    expect(Array.isArray(providers)).toBe(true);
    expect(providers).toContainEqual({
      provide: APP_INTERCEPTOR,
      useClass: ZodSerializerInterceptor,
    });
  });

  /**
   * `APP_INTERCEPTOR` bound to something ELSE would satisfy a looser assertion
   * that only looked for the token, and `ZodSerializerInterceptor` registered
   * under a different token would satisfy one that only looked for the class.
   * Nest hoists ANY `APP_INTERCEPTOR` provider to application scope, so the pair
   * is the fact, not either half.
   */
  it('binds it to APP_INTERCEPTOR specifically, not merely provides it', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    const bound = providers.filter(
      (provider): provider is { provide: unknown; useClass: unknown } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === APP_INTERCEPTOR,
    );
    expect(bound).toHaveLength(1);
    expect(bound[0]?.useClass).toBe(ZodSerializerInterceptor);
  });
});
