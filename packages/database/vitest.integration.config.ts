import type { TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';

/**
 * Vitest's default `BaseSequencer` does NOT run files in declaration or
 * alphabetical order. With no per-file duration cache it sorts by file SIZE,
 * largest first; once a cache exists it sorts by recorded duration, longest
 * first. MEASURED on Vitest 4.1.10: with a cold cache this package's two
 * integration files ran `soft-delete.integration.test.ts` (the larger file)
 * before `harness.integration.test.ts` in 3/3 runs — reproducing on every
 * attempt, not flaking occasionally — and once a duration cache exists the two
 * files flip-flop run to run because whichever ran first pays a cold-container
 * connection cost that makes it look slower next time.
 *
 * That matters here specifically: `harness.integration.test.ts`'s "has
 * applied the migrations, so the schema is queryable" test asserts the
 * `HealthCheck` table is empty, and `soft-delete.integration.test.ts`'s "does
 * not filter models that are not soft-deletable" test inserts a `HealthCheck`
 * row with no cleanup. Both files share the one container `globalSetup`
 * starts for the whole run, so whichever file's insert lands first is visible
 * to the other. The suite's tests were written assuming file declaration
 * order (harness before soft-delete); this sequencer is what actually
 * guarantees it, since nothing else in this config does.
 */
class AlphabeticalSequencer {
  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    return files;
  }

  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) =>
      a.moduleId === b.moduleId ? 0 : a.moduleId < b.moduleId ? -1 : 1,
    );
  }
}

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // One container for the whole run, owned by globalSetup — see the comment
    // in packages/testing/vitest.integration.config.ts, including why
    // `poolOptions` must not be added back. Without globalSetup, this
    // package's three integration files each start their own Postgres and run
    // their own `prisma migrate deploy` — measured, three containers; Task 8
    // Step 3 reproduces it.
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    sequence: { sequencer: AlphabeticalSequencer },
  },
});
