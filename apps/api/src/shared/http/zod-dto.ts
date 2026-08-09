import { createZodDto, type ZodDto } from 'nestjs-zod';
import type { ZodType } from 'zod';

/**
 * The only sanctioned way to make a DTO in this app — and the only file allowed
 * to import `createZodDto`, per the lint rule in apps/api/eslint.config.js.
 *
 * `codec: true` turns on OUTPUT-side type checking at `@ZodResponse`. Without
 * it, both nestjs-zod and ts-rest type a controller's return against the
 * schema's *input* type, and `.brand()` is output-only in Zod — so a plain
 * unbranded string satisfies a branded-ID response field, compiles, and ships.
 * ADR-0019 makes this default an obligation rather than an option.
 *
 * THIS FILE IS ONLY HALF OF RESPONSE VALIDATION. `@ZodResponse` attaches
 * metadata (`ZodSerializerDto`, `ApiResponse`, `HttpCode`); it validates
 * nothing by itself. The other half is the global
 * `{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }` provider in
 * src/app.module.ts, which is what reads that metadata and parses the response
 * at request time. Delete that provider and every route in this app answers 200
 * with whatever the handler returned. Both halves, or neither works — the only
 * thing that notices is the readiness fixture in
 * test/health.integration.test.ts.
 *
 * The return type is written out rather than inferred. `apps/api`'s build
 * inherits `composite`/`declaration: true`, so TypeScript has to NAME
 * `createZodDto(...)`'s return in the emitted `.d.ts`; under pnpm's nested
 * node_modules layout an inferred type reaching into `nestjs-zod`'s internals
 * is the classic `TS2742: The inferred type of 'metrikaDto' cannot be named
 * without a reference to …`. `ZodDto` is exported from the package root, so
 * naming it explicitly is both the fix and the documentation.
 */
export function metrikaDto<T extends ZodType>(schema: T): ZodDto<T, true> {
  return createZodDto(schema, { codec: true });
}
