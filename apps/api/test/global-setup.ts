import { createDatabaseGlobalSetup } from '@metrika/testing';
import { DATABASE_PACKAGE_ROOT } from './database-root.js';

export default createDatabaseGlobalSetup({ databasePackageRoot: DATABASE_PACKAGE_ROOT });
