import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * packages/database's own directory, found through Node's resolver rather than
 * by walking `..`. It holds the `sql/` and `prisma/` the Testcontainers harness
 * needs, and @metrika/testing takes it as an option because it must not depend
 * on @metrika/database itself.
 *
 * The subpath resolves only because `@metrika/database`'s `exports` map
 * declares `"./package.json"`. An `exports` map is a closed allow-list: Node
 * answers every unlisted subpath with ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * This is `require.resolve` of a JSON file, not an `import` of the module, so
 * it does not cross `prismaImportBoundary` — apps/api may only *import*
 * @metrika/database from src/infrastructure/persistence/**.
 */
export const DATABASE_PACKAGE_ROOT = path.dirname(
  require.resolve('@metrika/database/package.json'),
);
