import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { bootApiForTest, stopDatabase } from './support.js';
import { buildOpenApiDocument } from '../src/openapi/build-document.js';
import { HealthLiveDto } from '../src/modules/health/health.dto.js';

let app: NestFastifyApplication;
let baseUrl: string;

/**
 * The statuses a GET operation documents, in the document's own key form
 * (strings — OpenAPI response keys are not numbers).
 *
 * Every accessor here reads the REAL document through `@nestjs/swagger`'s own
 * types and returns `undefined` where the shape is not what it expects, rather
 * than asserting a hand-built object into place. A cast-shaped fixture that has
 * drifted from the real object is precisely how an emission test passes while
 * emitting nothing.
 */
function documentedStatuses(document: OpenAPIObject, path: string): readonly string[] {
  return Object.keys(document.paths[path]?.get?.responses ?? {});
}

/** The `$ref` a documented response points its JSON body at, if it points at one. */
function responseSchemaRef(
  document: OpenAPIObject,
  path: string,
  status: string,
): string | undefined {
  const response = document.paths[path]?.get?.responses[status];
  if (response === undefined || '$ref' in response) return undefined;
  const schema = response.content?.['application/json']?.schema;
  if (schema === undefined || !('$ref' in schema)) return undefined;
  return schema.$ref;
}

/** The security schemes a GET operation requires, flattened to their names. */
function securitySchemes(document: OpenAPIObject, path: string): readonly string[] {
  return (document.paths[path]?.get?.security ?? []).flatMap((requirement) =>
    Object.keys(requirement),
  );
}

beforeAll(async () => {
  ({ app, baseUrl } = await bootApiForTest());
});

afterAll(async () => {
  await app.close();
  await stopDatabase();
});

describe('buildOpenApiDocument', () => {
  it('declares OpenAPI 3.1, not the 3.0 the generator defaults to', () => {
    expect(buildOpenApiDocument(app).openapi).toBe('3.1.1');
  });

  it('documents the three health routes', () => {
    // No `?? {}`: `OpenAPIObject.paths` is non-optional, and the fallback is a
    // `@typescript-eslint/no-unnecessary-condition` error.
    const paths = Object.keys(buildOpenApiDocument(app).paths);
    expect(paths).toContain('/health/live');
    expect(paths).toContain('/health/ready');
    expect(paths).toContain('/health/deep');
  });

  it('emits populated response schemas — an empty schema object is the ts-rest failure mode', () => {
    const document = buildOpenApiDocument(app);
    const schemas = document.components?.schemas ?? {};
    const deep = schemas['HealthDeepDto'];

    expect(deep).toBeDefined();
    expect(Object.keys((deep as { properties?: object }).properties ?? {})).toContain('checks');
  });

  /**
   * The 200 test above only notices a `@ZodResponse` removed from /health/deep,
   * because that is the only DTO it names. This one notices it on ANY of the
   * three: a route whose decorator is gone still appears in `paths` (the `@Get`
   * is what puts it there) and still documents a 200 — with no `content` at all.
   * MEASURED: dropping `@ZodResponse` from /health/live leaves the emitted
   * operation as `{"200": {"description": ""}}`, which every test that only
   * checks for the PATH is happy with.
   */
  it('binds every documented probe response to its DTO schema', () => {
    const document = buildOpenApiDocument(app);

    expect(responseSchemaRef(document, '/health/live', '200')).toBe(
      '#/components/schemas/HealthLiveDto',
    );
    expect(responseSchemaRef(document, '/health/ready', '200')).toBe(
      '#/components/schemas/HealthReadyDto',
    );
    expect(responseSchemaRef(document, '/health/deep', '200')).toBe(
      '#/components/schemas/HealthDeepDto',
    );
  });

  /**
   * A document that describes only the happy path is wrong in the way that
   * matters to a client: `packages/api-client` is generated from this file, so a
   * probe documented as 200-only produces a client that models the 503 a
   * degraded deployment really answers as an unmodelled error.
   */
  it('documents the 503 the probes answer when a dependency is down', () => {
    const document = buildOpenApiDocument(app);

    expect(documentedStatuses(document, '/health/ready')).toEqual(
      expect.arrayContaining(['200', '503']),
    );
    expect(documentedStatuses(document, '/health/deep')).toEqual(
      expect.arrayContaining(['200', '503']),
    );

    // …and carrying the body the handler really sends, not a bare status.
    expect(responseSchemaRef(document, '/health/ready', '503')).toBe(
      '#/components/schemas/HealthReadyDto',
    );
    expect(responseSchemaRef(document, '/health/deep', '503')).toBe(
      '#/components/schemas/HealthDeepDto',
    );

    // Liveness has no dependency to be unavailable for, so it must NOT claim a
    // 503 — see the comment on HealthController.live.
    expect(documentedStatuses(document, '/health/live')).toEqual(['200']);
  });

  it('documents /health/deep as bearer-authenticated and able to reject', () => {
    const document = buildOpenApiDocument(app);

    expect(securitySchemes(document, '/health/deep')).toContain('bearer');
    expect(Object.keys(document.components?.securitySchemes ?? {})).toContain('bearer');
    expect(documentedStatuses(document, '/health/deep')).toContain('401');

    // The unauthenticated probes must not acquire a security requirement: a
    // generated client that starts sending credentials to /health/ready is a
    // load balancer that cannot reach it.
    expect(securitySchemes(document, '/health/ready')).toEqual([]);
    expect(securitySchemes(document, '/health/live')).toEqual([]);
  });

  it('is served at /api/v1/openapi.json', async () => {
    const response = await fetch(`${baseUrl}/api/v1/openapi.json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { openapi: string };
    expect(body.openapi).toBe('3.1.1');
  });
});

/**
 * ADR-0019 obligation 3's other half: "a controller whose return omits a
 * required field or supplies the wrong base type must fail `tsc`".
 *
 * That is a COMPILE-time property, so this is a compile-time fixture. Each
 * expect-error directive below is the assertion — it says the decorator
 * application under it does not type-check, and `tsc -b --force` fails with
 * TS2578 ("Unused directive") the day it starts type-checking. Removing
 * `{ codec: true }` from `metrikaDto()` is exactly that day: `@ZodResponse`
 * then checks the schema's INPUT type, `.brand()` is output-only in Zod, and
 * every branded-ID response field in this app silently stops being checked.
 * Nothing at runtime can observe that, which is why the fixture is here and not
 * in an `expect`.
 *
 * The directive goes on the line above `@ZodResponse`, not above the method:
 * MEASURED, TypeScript reports TS1241 "Unable to resolve signature of method
 * decorator when called as an expression" at the DECORATOR, and a directive one
 * line lower is both unused and useless.
 *
 * `correct()` is not padding. Without a handler that does satisfy the DTO, a
 * change that made `@ZodResponse` reject EVERY return — a broken overload, a
 * Zod major bump — would leave both directives happily "used" and this fixture
 * green while the decorator had stopped working entirely.
 */
describe('@ZodResponse return typing', () => {
  it('rejects a handler that omits a required field or gets a base type wrong', () => {
    class Handlers {
      // @ts-expect-error -- ADR-0019 obligation 3: HealthLiveSchema requires `environment`, so a handler that omits it must not compile. If this directive ever becomes unused, response typing has stopped working.
      @ZodResponse({ status: 200, type: HealthLiveDto })
      omitsRequiredField(): { status: 'ok' } {
        return { status: 'ok' };
      }

      // @ts-expect-error -- ADR-0019 obligation 3: `environment` is a string enum, so a number must not compile. If this directive ever becomes unused, response typing has stopped working.
      @ZodResponse({ status: 200, type: HealthLiveDto })
      wrongBaseType(): { status: 'ok'; environment: number } {
        return { status: 'ok', environment: 1 };
      }

      @ZodResponse({ status: 200, type: HealthLiveDto })
      correct(): { status: 'ok'; environment: 'test' } {
        return { status: 'ok', environment: 'test' };
      }
    }

    // The runtime assertion is deliberately trivial: the one that matters
    // already ran, in `tsc`. This exists so the class is constructed rather
    // than merely declared, which keeps `no-unused-vars` honest and proves the
    // decorated methods are still callable.
    expect(new Handlers().correct()).toEqual({ status: 'ok', environment: 'test' });
  });
});
