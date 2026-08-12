import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopDatabase } from './support.js';
import { createPrismaClient, type MetrikaPrismaClient } from '../src/index.js';

afterAll(async () => {
  await stopDatabase();
});

/**
 * On Prisma 6 the connection ceiling was `?connection_limit=` in the URL, and
 * its default was `num_cpus * 2 + 1`. On Prisma 7 behind a driver adapter the
 * URL parameter is INERT — `pg` has never heard of it and Prisma no longer
 * parses it out — and the default is whatever `pg.Pool` uses, currently 10.
 * Measured by the upgrade spike, 20 parallel 300 ms queries on an 8-core host:
 *
 *     prisma 7.9.1 : {"noLimit":10,"connectionLimit3":10}
 *     prisma 6.19.3: {"noLimit":17,"connectionLimit3":3}
 *
 * The 6.19.3 row is INHERITED and is not reproducible from this tree — that
 * version is no longer installed, and `17` was a function of that host's core
 * count besides. Only the 7.9.1 row is re-measured on every run, and this
 * fixture uses 24 parallel queries rather than the spike's 20 (see
 * PARALLEL_QUERIES below) — so the numbers above are the provenance of the
 * finding, not a prediction of what this file will print.
 *
 * Nothing in the toolchain reports that change: `?connection_limit=3` is still
 * a legal URL, `pnpm verify` is green, and the only symptom is a service that
 * quietly holds a different number of backends than its operator believes.
 *
 * This file asserts the RELATIONSHIP between three measured ceilings, never
 * the number 10 — `pg.Pool`'s default is not ours to pin, and Prisma 6's
 * default moved with the core count, so a hard number here would go red on a
 * CI runner with a different CPU count for no reason worth anyone's time.
 *
 * ── How the ceiling is observed, and why it changed ──────────────────────
 *
 * Each of the parallel queries reports ITS OWN backend, and the ceiling is the
 * size of the distinct set. The measurement is therefore carried by the same
 * queries that create the load, and there is nothing to sample.
 *
 * The previous design polled `pg_stat_activity` from a separate observer
 * client every 10 ms and kept the highest sample. It was replaced because a
 * starved observer UNDER-COUNTS, and the assertions here are equalities:
 * MEASURED, with the poll loop forcibly delayed by 250/400/700 ms, 7 runs —
 * the sampler reported `{base: 4, url: 3, opt: 3}`, i.e. it reported the URL
 * parameter as HONOURED. That is not flakiness; it is a false positive in the
 * exact shape of a genuine Prisma regression, and no one-sided bound fixes it.
 * The design below measured 10/10/3 in all 22 runs of the same comparison,
 * including 6 under 28 CPU burners at load 35 and 5 under the real root gate
 * at load 40-50.
 *
 * What it gives up, stated because it is a different concept and not a
 * strictly better one:
 *
 *   1. It counts the connections the pool OPENED over the run, not the
 *      backends simultaneously ACTIVE. For `pg.Pool` the two coincide — it
 *      never exceeds `max` and hands out an idle connection before opening a
 *      new one — but a pool that recycled connections mid-run would inflate
 *      the count. `pg.Pool`'s `maxLifetimeSeconds` defaults to disabled (0),
 *      which is what keeps that hypothetical from being a real one; passing it
 *      through `PrismaPg` would invalidate this fixture.
 *   2. It loses the independent cross-check. `pg_stat_activity` was a second
 *      source of truth about the connection: the pid now comes from the same
 *      session whose existence it is evidence of.
 */
describe('the Prisma 7 connection pool', () => {
  /** Comfortably above every ceiling under test, so each one is what binds. */
  const PARALLEL_QUERIES = 24;
  /** Low enough to be unmistakably below `pg.Pool`'s default of 10. */
  const CEILING = 3;

  interface BackendPid {
    readonly pid: number;
  }

  /**
   * How many distinct backends `PARALLEL_QUERIES` simultaneous queries were
   * spread across. All of them are issued at once and each holds its
   * connection for 300 ms, so the pool has to open every connection it is
   * willing to open; the ceiling is the only thing that can stop it opening
   * one per query, and so the size of the distinct set IS the ceiling.
   *
   * `SELECT pg_backend_pid() ... FROM pg_sleep(0.3)` rather than
   * `SELECT pg_sleep(0.3)`: the latter returns a `void` column, and there is
   * no reason to make the result decoder part of what this test depends on.
   */
  async function distinctBackends(subject: MetrikaPrismaClient): Promise<number> {
    const seen = new Set<number>();

    await Promise.all(
      Array.from({ length: PARALLEL_QUERIES }, async () => {
        const rows = await subject.$queryRaw<BackendPid[]>`
          SELECT pg_backend_pid()::int AS pid FROM pg_sleep(0.3)
        `;
        const pid = rows[0]?.pid;
        // A query that returned no row would silently shrink the set, which
        // reads as a lower ceiling — the finding, arrived at by not measuring.
        if (pid === undefined) {
          throw new Error('the pool probe returned no backend pid');
        }
        seen.add(pid);
      }),
    );

    return seen.size;
  }

  /**
   * The harness's URL already carries a query string, so `${url}?x=y` would
   * produce one parameter with a nonsense value rather than two parameters —
   * and a malformed URL would make the "inert" finding below vacuous.
   */
  function withConnectionLimit(databaseUrl: string, limit: number): string {
    const url = new URL(databaseUrl);
    url.searchParams.set('connection_limit', String(limit));
    return url.toString();
  }

  let baseline = -1;
  let withUrlParameter = -1;
  let withAdapterOption = -1;

  beforeAll(async () => {
    const handle = await startTestDatabase();
    const plainUrl = handle.applicationUrl;
    const limitedUrl = withConnectionLimit(plainUrl, CEILING);

    // Guards the "inert" finding against the way it would most plausibly be
    // faked: a URL that never carried the parameter in the first place would
    // measure identically to one whose parameter is ignored.
    if (!limitedUrl.includes(`connection_limit=${String(CEILING)}`)) {
      throw new Error(`the probe URL lost its connection_limit parameter: ${limitedUrl}`);
    }

    const measure = async (subject: MetrikaPrismaClient): Promise<number> => {
      try {
        return await distinctBackends(subject);
      } finally {
        // Ends the pool, so the next measurement starts from zero backends
        // rather than inheriting the previous one's.
        await subject.$disconnect();
      }
    };

    baseline = await measure(createPrismaClient({ databaseUrl: plainUrl }));
    withUrlParameter = await measure(createPrismaClient({ databaseUrl: limitedUrl }));
    withAdapterOption = await measure(
      createPrismaClient({ databaseUrl: plainUrl, maxPoolConnections: CEILING }),
    );
  });

  it('observes real concurrency, so the two findings below can fail', () => {
    // Without this, an apparatus that measured nothing at all would report
    // 1 / 1 / 1 — every query serialised onto one connection — and "1 is equal
    // to 1" would read as a passing finding about Prisma while actually being
    // a passing finding about a broken probe. Equality alone cannot tell those
    // apart; this can.
    expect(baseline).toBeGreaterThan(CEILING);
  });

  it('ignores ?connection_limit= in the connection URL', () => {
    // Red here means a future Prisma restored URL parsing. That is good news,
    // but it means `?connection_limit=` is load-bearing again everywhere it
    // appears, and ADR-0037 says the opposite.
    expect(withUrlParameter).toBe(baseline);
  });

  it('honours a ceiling passed through the adapter', () => {
    // The other half of the same finding: the ceiling did not disappear, it
    // moved. `toBe(CEILING)` rather than a bare inequality — "fewer than the
    // default" would also be satisfied by a pool that broke in some other way,
    // and the claim being pinned is that the number we asked for is the number
    // we got.
    expect(withAdapterOption).toBe(CEILING);
    expect(withAdapterOption).toBeLessThan(baseline);
  });
});
