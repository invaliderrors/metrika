import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APPLICATION_URL_VAR,
  DockerUnavailableError,
  startDatabase,
  stopDatabase,
  withDatabase,
  type DisposableClient,
} from '../src/index.js';

/**
 * A filesystem path, deliberately NOT `require.resolve('@metrika/database')`.
 * packages/testing must not declare a dependency on packages/database —
 * packages/database depends on this package, and Turbo refuses the resulting
 * cycle with "Cyclic dependency detected". A sibling directory on disk is not
 * a package edge, and this path is only ever used by this package's own tests.
 */
const databasePackageRoot = path.resolve(import.meta.dirname, '../../database');

/** A recording stand-in. This package must not know what a Prisma client is. */
class StubClient implements DisposableClient {
  disconnected = false;

  constructor(readonly url: string) {}

  async $disconnect(): Promise<void> {
    this.disconnected = true;
    await Promise.resolve();
  }
}

afterAll(async () => {
  await stopDatabase();
});

describe('the Testcontainers Postgres harness', () => {
  it('exposes two URLs that use different roles', async () => {
    const handle = await startDatabase({ databasePackageRoot });
    expect(handle.applicationUrl).toContain('metrika_app:');
    expect(handle.adminUrl).toContain('metrika:');
    expect(handle.applicationUrl).not.toBe(handle.adminUrl);
  });

  it('reuses the container the globalSetup started rather than starting a second', async () => {
    const first = await startDatabase({ databasePackageRoot });
    const second = await startDatabase({ databasePackageRoot });
    expect(second.applicationUrl).toBe(first.applicationUrl);
    // The URL came from the globalSetup, not from a container this file
    // started. Without this line the test would also pass on a per-file
    // container, which is the exact regression it exists to catch.
    expect(first.applicationUrl).toBe(process.env[APPLICATION_URL_VAR]);
  });

  it('hands the caller-supplied factory the APPLICATION url, never the owner url', async () => {
    const handle = await startDatabase({ databasePackageRoot });

    const url = await withDatabase(
      { databasePackageRoot, createClient: (databaseUrl) => new StubClient(databaseUrl) },
      async (db) => Promise.resolve(db.url),
    );

    expect(url).toBe(handle.applicationUrl);
    expect(url).not.toBe(handle.adminUrl);
  });

  it('disposes of the client it created, even when the callback throws', async () => {
    const created: StubClient[] = [];

    await expect(
      withDatabase(
        {
          databasePackageRoot,
          createClient: (databaseUrl) => {
            const stub = new StubClient(databaseUrl);
            created.push(stub);
            return stub;
          },
        },
        async () => {
          await Promise.resolve();
          throw new Error('callback exploded');
        },
      ),
    ).rejects.toThrow('callback exploded');

    expect(created).toHaveLength(1);
    expect(created[0]?.disconnected).toBe(true);
  });

  it('names the fix in the Docker preflight error rather than the library default', () => {
    const error = new DockerUnavailableError('Cannot connect to the Docker daemon');
    expect(error.message).toContain('Docker Desktop');
    expect(error.message).toContain('pnpm test:unit');
    expect(error.message).toContain('Cannot connect to the Docker daemon');
  });
});
