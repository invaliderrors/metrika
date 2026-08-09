import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import type { INestApplication } from '@nestjs/common';

export const OPENAPI_VERSION = '3.1.1';

/**
 * The name `DocumentBuilder.addBearerAuth()` registers the security scheme
 * under, and therefore the name `@ApiBearerAuth()` on a controller has to quote
 * to reference it. Both default to `'bearer'`; naming the constant once is what
 * keeps a rename from silently producing an operation whose `security` entry
 * points at a scheme that does not exist — OpenAPI has no validation for that
 * and the generated client simply stops sending the header.
 */
export const BEARER_SCHEME = 'bearer';

/**
 * The ONLY document generator in this repository, deliberately.
 *
 * `SwaggerModule.createDocument` hardcodes `openapi: "3.0.0"`, and
 * `cleanupOpenApiDoc({ version: '3.1' })` converts the schema bodies to
 * JSON Schema 2020-12 without touching that field. A second generator that
 * skipped the override would emit a document claiming 3.0 while containing
 * 3.1-only constructs (Zod 4's `anyOf`-based nullable, for one), which breaks
 * strict 3.0 consumers in a way no test of ours would notice. One function,
 * called by bootstrap.ts and by scripts/emit-openapi.ts.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Metrika API')
    .setDescription('Manufacturing quotes for 3D-printed architectural models.')
    .setVersion('1.0.0')
    // `addSecurity`, not `addBearerAuth`. The latter hardcodes
    // `bearerFormat: 'JWT'` and spreads it BEFORE its options argument, so the
    // default cannot be overridden through it — and the claim would be false:
    // the only route on this scheme today is /health/deep, guarded by a
    // timingSafeEqual over the SHA-256 of a static shared secret, never a JWT.
    // No generator codegens from `bearerFormat`, so nothing breaks either way,
    // but it is the one field where the document could assert something untrue
    // about a real route, and it would collide the day real JWT auth shares
    // this scheme name.
    .addSecurity(BEARER_SCHEME, {
      type: 'http',
      scheme: 'bearer',
      description: 'Static shared secret, compared in constant time. Not a JWT.',
    })
    .build();

  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config), {
    version: '3.1',
  });

  return { ...document, openapi: OPENAPI_VERSION };
}
