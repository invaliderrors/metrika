import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { assertDockerAvailable } from './docker.js';
import { POSTGRES_IMAGE } from './images.js';

const run = promisify(execFile);

/**
 * The Prisma CLI's own entry point, resolved from the caller's
 * `databasePackageRoot`, to be run as `node <entry>`.
 *
 * NOT `pnpm exec prisma`: `pnpm` on Windows is `pnpm.CMD`, and `execFile`
 * cannot start a `.cmd` without a shell — the call rejects with
 * `Error: spawn pnpm ENOENT`, so every integration suite in the repository
 * fails at container start with an error naming the package manager rather than
 * anything about the database.
 *
 * Resolving from `databasePackageRoot` rather than from this file keeps the
 * one-way edge intact: `prisma` is `@metrika/database`'s devDependency, this
 * package must not depend on it (Turbo's `^build` graph would be cyclic), and a
 * runtime lookup rooted at a path the caller supplies is not a dependency.
 */
function prismaCli(databasePackageRoot: string): string {
  const require = createRequire(path.join(databasePackageRoot, 'package.json'));
  const manifest = require.resolve('prisma/package.json');
  const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> }).bin;
  const entry = bin['prisma'];
  if (entry === undefined) {
    throw new Error(`prisma, resolved from ${databasePackageRoot}, declares no "prisma" bin.`);
  }
  return path.resolve(path.dirname(manifest), entry);
}

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
/** Set only while a container start is in flight; see `startDatabase`'s concurrency guard. */
let inFlight: Promise<DatabaseHandle> | undefined;

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

const HEALTH_CHECK_TIMEOUT_MS = 10_000;

/**
 * Dials `host:port` from THIS process — the same one every real caller of
 * `applicationUrl` connects from — and resolves once the TCP handshake
 * completes. A bare connect, not a Postgres handshake: cheap, and enough to
 * prove the address in the URL this function is about to hand out is not a
 * dead port.
 */
async function assertTcpReachable(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `timed out connecting to ${host}:${String(port)} within ${String(HEALTH_CHECK_TIMEOUT_MS)}ms`,
        ),
      );
    }, HEALTH_CHECK_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * Confirms `applicationUrl` is a real, migrated, connectable database before
 * `startDatabase` hands it to anyone — not just that `.start()` and
 * `prisma migrate deploy` both exited 0. Two independent checks, because
 * either one alone misses half of what can go wrong:
 *
 * 1. {@link assertTcpReachable} against `applicationUrl`'s own host and
 *    port. Catches a broken URL — e.g. the mapped port read wrong — exactly
 *    where it would bite a real caller: this same process, dialling this
 *    same string.
 * 2. `docker exec` into the container, authenticating as `metrika_app` over
 *    TCP against the container's OWN internal port (5432 — not the mapped
 *    one `applicationUrl` uses) and querying `HealthCheck`, a table that
 *    only exists once migrations have actually run. This catches "the
 *    `prisma migrate deploy` step silently stopped happening" specifically
 *    — a check that queried nothing, or queried a table sql/00-app-role.sql
 *    itself does not gate on, would not: `metrika_app` is created by that
 *    file at container INIT, independently of whether any migration ever
 *    ran, so a bare `SELECT 1` would keep passing even with zero migrations
 *    applied.
 *
 * Why not have (2) alone dial `applicationUrl`'s mapped port directly,
 * skipping (1) entirely? MEASURED, not assumed: a container cannot reach its
 * own published host port from inside itself on this Docker Desktop setup —
 * there is no hairpin NAT back to the originating container — so
 * `docker exec <container> psql "$applicationUrl"` reliably fails with
 * ECONNREFUSED regardless of whether the port is right or wrong. Confirmed
 * directly, against a container's own known-good mapped port, before
 * settling on the two-check split above.
 */
async function assertDatabaseReachable(
  started: StartedPostgreSqlContainer,
  applicationUrl: string,
): Promise<void> {
  const url = new URL(applicationUrl);
  await assertTcpReachable(url.hostname, Number(url.port));

  const probe = await started.exec(
    [
      'psql',
      '--set=ON_ERROR_STOP=1',
      '--host=127.0.0.1',
      '--port=5432',
      `--username=${APPLICATION_ROLE}`,
      `--dbname=${DATABASE}`,
      '--command=SELECT 1 FROM "HealthCheck"',
    ],
    { env: { PGPASSWORD: APPLICATION_PASSWORD } },
  );
  if (probe.exitCode !== 0) {
    throw new Error(
      `metrika_app cannot query a migrated table after "prisma migrate deploy" ` +
        `(exit ${String(probe.exitCode)}): ${probe.output}`,
    );
  }
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

  // Concurrency guard. Unreachable when `globalSetup` runs first (the
  // `published` branch above returns before this point is ever reached by a
  // second caller) — but this function is also the one an editor plugin's
  // `it.concurrent` can call directly, with no `globalSetup` in front of it
  // at all. Without this, two callers racing the first, container-less call
  // would each start their own container, and the loser's would be orphaned
  // with nothing left to stop it. `??=` only evaluates `startContainer(...)`
  // on the first call reaching this line; JS's synchronous-until-first-await
  // semantics mean every other caller in the same race sees `inFlight`
  // already set before it can start a second one — no lock needed.
  inFlight ??= startContainer(options);
  try {
    handle = await inFlight;
  } finally {
    inFlight = undefined;
  }
  return handle;
}

async function startContainer(options: StartDatabaseOptions): Promise<DatabaseHandle> {
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
  await run(process.execPath, [prismaCli(options.databasePackageRoot), 'migrate', 'deploy'], {
    cwd: options.databasePackageRoot,
    env: { ...process.env, DATABASE_ADMIN_URL: adminUrl },
  });

  // `.start()` and `migrate deploy` both exiting 0 proves the container
  // came up and the CLI ran without error — it does not prove `applicationUrl`
  // is a connectable, migrated database. Both have failed silently in
  // practice: a URL-construction bug can hand out a dead port while everything
  // above still exits 0, and this call itself could be deleted or short-
  // circuited without either of the two prior steps noticing. Verifying here,
  // once, in the process that started the container, means every caller
  // downstream gets a URL that has actually been dialled — never a "mystery
  // connection error" surfacing three layers away in a test that has nothing
  // to do with the real cause.
  await assertDatabaseReachable(container, applicationUrl);

  return { adminUrl, applicationUrl };
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
 * exactly as production is. The client is disposed of even when the callback
 * throws: a leaked connection here exhausts a small container's pool a dozen
 * tests later, where the cause is invisible.
 *
 * Deliberately NOT a bare `try { ... } finally { await db.$disconnect(); }`:
 * if `fn` throws AND `$disconnect()` also throws while cleaning up after it,
 * a `finally` lets the disconnect error silently replace the callback's own
 * error — the one thing a caller actually needs to see. Both are kept, via
 * `AggregateError`, rather than choosing one to drop.
 */
export async function withDatabase<TClient extends DisposableClient, T>(
  options: WithDatabaseOptions<TClient>,
  fn: (db: TClient) => Promise<T>,
): Promise<T> {
  const started = await startDatabase(options);
  const db = options.createClient(started.applicationUrl);

  let result: T;
  try {
    result = await fn(db);
  } catch (error: unknown) {
    try {
      await db.$disconnect();
    } catch (disconnectError: unknown) {
      throw new AggregateError(
        [error, disconnectError],
        'withDatabase: the callback failed, and $disconnect() also failed while cleaning up after it',
        { cause: disconnectError },
      );
    }
    throw error;
  }

  await db.$disconnect();
  return result;
}
