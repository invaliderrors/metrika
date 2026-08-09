import path from 'node:path';
import { createDatabaseGlobalSetup } from '@metrika/testing';

export default createDatabaseGlobalSetup({
  databasePackageRoot: path.resolve(import.meta.dirname, '..'),
});
