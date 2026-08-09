import {
  ADMIN_URL_VAR,
  APPLICATION_URL_VAR,
  startDatabase,
  stopDatabase,
  type StartDatabaseOptions,
} from './database.js';

/**
 * Builds the default export of a Vitest `globalSetup` file.
 *
 * Vitest runs globalSetup exactly ONCE per run, in its own module registry,
 * before it forks any worker — which makes it the only place a container can
 * live if every test file in the run is to share it. `fileParallelism: false`
 * does not achieve this on its own: it serialises files, it does not merge
 * their module graphs, so a module-level `let container` gives one container
 * per file, plus one `prisma migrate deploy` per file. (MEASURED on Docker
 * 29.6.2 / Vitest 4.1.10: three files, three containers, three worker PIDs.
 * `fileParallelism: false` forces maxWorkers to 1 but the default
 * `isolate: true` still respawns a fresh fork per file, so nothing at module
 * level survives the file boundary. See Task 8 Step 3 of Plan 0B-1.)
 *
 * The two URLs travel to the workers through `process.env` because the workers
 * are forked after this function returns and inherit it. `startDatabase()`
 * reads them and starts nothing.
 */
export function createDatabaseGlobalSetup(
  options: StartDatabaseOptions,
): () => Promise<() => Promise<void>> {
  return async function setup(): Promise<() => Promise<void>> {
    const started = await startDatabase(options);
    process.env[APPLICATION_URL_VAR] = started.applicationUrl;
    process.env[ADMIN_URL_VAR] = started.adminUrl;

    return async function teardown(): Promise<void> {
      // `delete process.env[VAR]` trips @typescript-eslint/no-dynamic-delete
      // because VAR is a computed key, not a literal property name.
      // Reflect.deleteProperty is the idiomatic escape: same effect, no
      // dynamic `delete` expression for the rule to flag.
      Reflect.deleteProperty(process.env, APPLICATION_URL_VAR);
      Reflect.deleteProperty(process.env, ADMIN_URL_VAR);
      await stopDatabase();
    };
  };
}
