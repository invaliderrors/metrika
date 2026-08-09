import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createApiApp } from '../bootstrap.js';
import { buildOpenApiDocument } from '../openapi/build-document.js';

const OUTPUT = path.resolve(import.meta.dirname, '../../openapi/openapi.json');

/**
 * There is deliberately NO `await app.init()` here.
 *
 * `NestFactory.create()` already instantiates every module and provider, which
 * is all `SwaggerModule.createDocument` reads — it walks the modules container
 * for controller metadata. `app.init()` additionally fires the lifecycle hooks,
 * and `PrismaService.onModuleInit` calls `$connect()`. This script runs in CI
 * with no Postgres anywhere, so an `init()` would fail with "Can't reach
 * database server" on every run. Emitting a document is a static operation on
 * the module graph; it must not need a database, and this is the line that
 * keeps it that way.
 *
 * MEASURED, with every container stopped: without `init()` the script exits 0;
 * with it, `PrismaClientInitializationError: Can't reach database server at
 * 127.0.0.1:5432` and exit 1.
 *
 * `DATABASE_URL` and `HEALTH_DEEP_TOKEN` still have to be PRESENT and
 * well-formed in the environment, because `ConfigModule`'s factory validates
 * the environment while the module graph is built. They do not have to point at
 * anything that exists.
 *
 * `close()` is safe on an uninitialised app: it runs the destroy hooks, and
 * Prisma's `$disconnect()` on a client that never connected is a no-op.
 */
const app = await createApiApp();
const document = buildOpenApiDocument(app);
await app.close();

mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
