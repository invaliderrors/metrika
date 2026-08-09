import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { assertDockerAvailable } from './docker.js';
import { POSTGRES_IMAGE } from './images.js';

const run = promisify(execFile);

export interface DatabaseHandle {
  /** metrika_app — NOSUPERUSER NOBYPASSRLS. What the API uses. */
  readonly applicationUrl: string;
  /** The owner. What `prisma migrate deploy` uses. */
  readonly adminUrl: string;
}

export interface StartDatabaseOptions {
  /**
   * Absolute path to the directory holding `sql/00-app-role.sql` and
   * `prisma/`. A PARAMETER, not `require.resolve('@metrika/database')`: this
   * package must not depend on packages/database, because packages/database
   * depends on it and Turbo's `^build` graph would be cyclic. Callers pass
   * their own root.
   */
  readonly databasePackageRoot: string;
}

/** The narrowest shape this harness needs from whatever the caller builds. */
export interface DisposableClient {
  $disconnect(): Promise<void>;
}

export interface WithDatabaseOptions<
  TClient extends DisposableClient,
> extends StartDatabaseOptions {
  readonly createClient: (databaseUrl: string) => TClient;
}

const OWNER = 'metrika';
const OWNER_PASSWORD = 'metrika';
const DATABASE = 'metrika_test';
const APPLICATION_ROLE = 'metrika_app';
const APPLICATION_PASSWORD = 'metrika_app';

/** Written by the globalSetup, read by every worker it forks. */
export const APPLICATION_URL_VAR = 'METRIKA_TEST_DATABASE_URL';
export const ADMIN_URL_VAR = 'METRIKA_TEST_DATABASE_ADMIN_URL';

let container: StartedPostgreSqlContainer | undefined;
let handle: DatabaseHandle | undefined;

function urlFor(started: StartedPostgreSqlContainer, user: string, password: string): string {
  const host = started.getHost();
  const port = started.getMappedPort(5432);
  return `postgresql://${user}:${password}@${host}:${String(port)}/${DATABASE}?schema=public`;
}

function publishedHandle(): DatabaseHandle | undefined {
  const applicationUrl = process.env[APPLICATION_URL_VAR];
  const adminUrl = process.env[ADMIN_URL_VAR];
  if (applicationUrl === undefined || adminUrl === undefined) return undefined;
  return { applicationUrl, adminUrl };
}

/**
 * Returns the container the Vitest `globalSetup` already started, if there is
 * one; otherwise starts its own.
 *
 * The fallback is not redundant. `globalSetup` is what gives a whole run ONE
 * container — `fileParallelism: false` only serialises files, it does not merge
 * their module registries, so a module-level `let container` alone yields one
 * container per FILE. (MEASURED, not assumed: three files without `globalSetup`
 * started three containers, one per freshly forked worker process. See Task 8
 * Step 3 of Plan 0B-1.) But a
 * developer running `vitest run test/one.test.ts`
 * through an editor plugin may bypass the project config entirely, and failing
 * with "no database" there would be hostile. The env-var check keeps both paths
 * working and keeps them honest: the harness never starts a second container
 * when a published one exists.
 */
export async function startDatabase(options: StartDatabaseOptions): Promise<DatabaseHandle> {
  if (handle !== undefined) return handle;

  const published = publishedHandle();
  if (published !== undefined) {
    handle = published;
    return handle;
  }

  await assertDockerAvailable();

  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername(OWNER)
    .withPassword(OWNER_PASSWORD)
    .withDatabase(DATABASE)
    // The SAME file docker compose mounts into docker-entrypoint-initdb.d.
    // Copying it here rather than re-declaring the role in TypeScript is what
    // keeps local and CI from drifting on the one thing that decides whether
    // RLS applies at all.
    //
    // Signature verified against the installed testcontainers@12.1.0 types —
    // `withCopyFilesToContainer(filesToCopy: FileToCopy[]): this`, where
    // `FileToCopy = { source, target, mode? }`. It takes an ARRAY of objects
    // with NAMED keys, not positional (source, target) arguments. Verified end
    // to end, not just read: a role created by a file copied to
    // /docker-entrypoint-initdb.d/ was found by a live `SELECT rolname FROM
    // pg_roles` after `.start()`, so the image really does execute what lands
    // there.
    .withCopyFilesToContainer([
      {
        source: path.join(options.databasePackageRoot, 'sql/00-app-role.sql'),
        target: '/docker-entrypoint-initdb.d/00-app-role.sql',
      },
    ])
    .start();

  const adminUrl = urlFor(container, OWNER, OWNER_PASSWORD);
  const applicationUrl = urlFor(container, APPLICATION_ROLE, APPLICATION_PASSWORD);

  // The one sanctioned exception to "all Prisma CLI calls go through
  // scripts/prisma.mjs": the URL is a container port that does not exist until
  // now, so it is passed explicitly in the child environment rather than read
  // from a file.
  await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: options.databasePackageRoot,
    env: { ...process.env, DATABASE_ADMIN_URL: adminUrl },
  });

  handle = { adminUrl, applicationUrl };
  return handle;
}

/**
 * Stops the container **only if this module registry started it**. When the
 * URLs came from the globalSetup's environment variables `container` is
 * undefined here, so a per-file `afterAll(stopDatabase)` is a no-op on the
 * shared container instead of pulling it out from under the next file.
 */
export async function stopDatabase(): Promise<void> {
  if (container !== undefined) {
    await container.stop();
    container = undefined;
  }
  handle = undefined;
}

/**
 * Runs `fn` against a client the CALLER knows how to build, connected as
 * metrika_app — so anything the callback does is subject to row-level security
 * exactly as production is. The client is disposed of in a `finally`, including
 * when the callback throws: a leaked connection here exhausts a small
 * container's pool a dozen tests later, where the cause is invisible.
 */
export async function withDatabase<TClient extends DisposableClient, T>(
  options: WithDatabaseOptions<TClient>,
  fn: (db: TClient) => Promise<T>,
): Promise<T> {
  const started = await startDatabase(options);
  const db = options.createClient(started.applicationUrl);
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}
