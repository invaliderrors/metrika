import path from 'node:path';
import { createDatabaseGlobalSetup } from '../src/index.js';

// A filesystem path, deliberately not a package specifier. See the comment in
// test/database.integration.test.ts.
export default createDatabaseGlobalSetup({
  databasePackageRoot: path.resolve(import.meta.dirname, '../../database'),
});
