import { setTimeout as sleep } from 'node:timers/promises';
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
 */
describe('the Prisma 7 connection pool', () => {
  /** Comfortably above every ceiling under test, so each one is what binds. */
  const PARALLEL_QUERIES = 24;
  /** Low enough to be unmistakably below `pg.Pool`'s default of 10. */
  const CEILING = 3;
  const POLL_INTERVAL_MS = 10;

  interface BackendCount {
    readonly backends: number;
  }

  /**
   * How many backends are executing the probe query right now.
   *
   * `pg_stat_activity` exposes `state` and `query` for other sessions only to
   * superusers, members of `pg_read_all_stats`, and the role that owns the
   * session. The observer and the subjects are all `metrika_app`, so this is
   * the third case and both columns are readable — which is also why this
   * cannot be rewritten to observe from the owner's URL without thought.
   *
   * The observer's own backend is excluded twice over: by `pg_backend_pid()`,
   * and by the `pg_stat_activity` text that only this query contains. The
   * second guard is what keeps the count correct if the observer's own pool
   * ever opens more than one connection.
   */
  async function countProbeBackends(observer: MetrikaPrismaClient): Promise<number> {
    const rows = await observer.$queryRaw<BackendCount[]>`
      SELECT count(*)::int AS backends
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND pid <> pg_backend_pid()
        AND query LIKE '%metrika_pool_probe_backend%'
        AND query NOT LIKE '%pg_stat_activity%'
    `;
    return rows[0]?.backends ?? 0;
  }

  /**
   * Fires `PARALLEL_QUERIES` sleeps at once and samples the backend count
   * while they are in flight, returning the highest sample. The ceiling is the
   * only thing that can stop all of them from running at the same time, so the
   * peak IS the ceiling.
   *
   * `SELECT 1 ... FROM pg_sleep(0.3)` rather than `SELECT pg_sleep(0.3)`: the
   * latter returns a `void` column, and there is no reason to make the result
   * decoder part of what this test depends on.
   *
   * The column alias `metrika_pool_probe_backend` is the marker the observer
   * greps for. It has to be written literally into the SQL — a tagged template
   * interpolates VALUES, not identifiers — which is why the same string
   * appears in both queries rather than in one shared constant.
   */
  async function peakConcurrentBackends(
    subject: MetrikaPrismaClient,
    observer: MetrikaPrismaClient,
  ): Promise<number> {
    const finished = Promise.all(
      Array.from({ length: PARALLEL_QUERIES }, async () => {
        await subject.$queryRaw`SELECT 1 AS metrika_pool_probe_backend FROM pg_sleep(0.3)`;
      }),
    ).then(() => 'finished' as const);

    // A promise race rather than a boolean the `.finally` flips: the flag
    // version reads fine and is wrong under `no-unnecessary-condition`, which
    // cannot see a closure assignment and so believes the loop never ends.
    let peak = 0;
    let phase: 'finished' | 'polling' = 'polling';
    while (phase === 'polling') {
      peak = Math.max(peak, await countProbeBackends(observer));
      phase = await Promise.race([finished, sleep(POLL_INTERVAL_MS, 'polling' as const)]);
    }

    return peak;
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

    const observer = createPrismaClient({ databaseUrl: plainUrl });

    const measure = async (subject: MetrikaPrismaClient): Promise<number> => {
      try {
        return await peakConcurrentBackends(subject, observer);
      } finally {
        // Ends the pool, so the next measurement starts from zero backends
        // rather than inheriting the previous one's.
        await subject.$disconnect();
      }
    };

    try {
      baseline = await measure(createPrismaClient({ databaseUrl: plainUrl }));
      withUrlParameter = await measure(createPrismaClient({ databaseUrl: limitedUrl }));
      withAdapterOption = await measure(
        createPrismaClient({ databaseUrl: plainUrl, maxPoolConnections: CEILING }),
      );
    } finally {
      await observer.$disconnect();
    }
  });

  it('observes real concurrency, so the two findings below can fail', () => {
    // Without this, an apparatus that measured nothing at all would report
    // 0 / 0 / 0 — and "0 is equal to 0" would read as a passing finding about
    // Prisma while actually being a passing finding about a broken probe.
    // Equality alone cannot tell those apart; this can.
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
