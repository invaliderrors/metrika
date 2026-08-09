import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(import.meta.dirname, '../prisma/migrations');

function migrationFiles(): readonly string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(migrationsDir, entry.name, 'migration.sql'));
}

const allSql = migrationFiles()
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('the committed migrations', () => {
  it('finds at least one migration, so a broken reader cannot make this file vacuous', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
    expect(allSql.length).toBeGreaterThan(100);
  });

  it('creates the tenant-context function every policy reads', () => {
    expect(allSql).toContain('CREATE OR REPLACE FUNCTION app_current_org_id()');
  });

  it('enables row-level security on RlsProbe', () => {
    expect(allSql).toContain('ALTER TABLE "RlsProbe" ENABLE ROW LEVEL SECURITY');
  });

  // Generic rather than hard-coded to "RlsProbe": a hard-coded assertion only proves this one
  // table was ever done right, and cannot notice the next migration that ENABLEs row-level
  // security on a new table without FORCEing it — the exact silent hole this task exists to
  // close. Every table this suite finds enabling RLS must also FORCE it, by construction.
  it('FORCES row-level security for every table that ENABLEs it, so the table owner is never exempt', () => {
    // `noUncheckedIndexedAccess` makes match[1] `string | undefined`; the filter below narrows
    // it back to `string` without a non-null assertion — the capture group is only ever absent
    // if the whole pattern failed to match, which matchAll cannot report as a result.
    const enabledTables = [...allSql.matchAll(/ALTER TABLE "(\w+)" ENABLE ROW LEVEL SECURITY/g)]
      .map((match) => match[1])
      .filter((table): table is string => table !== undefined);
    // A vacuity guard for this assertion specifically: if the regex above ever stops matching
    // (a renamed statement shape, a broken migration reader), an empty array makes every()
    // trivially true and this test would pass while asserting nothing.
    expect(enabledTables.length).toBeGreaterThan(0);
    for (const table of enabledTables) {
      expect(allSql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
  });

  it('constrains reads as well as writes — a `USING (true)` policy would expose every row to every tenant', () => {
    expect(allSql).toContain('USING ("organizationId" = app_current_org_id())');
  });

  it('constrains writes as well as reads — a USING-only policy lets a caller plant a foreign row', () => {
    expect(allSql).toContain('WITH CHECK ("organizationId" = app_current_org_id())');
  });

  // Static approximation only: this is a substring check over the *concatenated* migration
  // history, so it can prove a guarantee was once written, never that a later migration didn't
  // reopen it — the closing text stays present in the join even if a subsequent migration
  // undoes it. The real guarantee is Task 8's behavioural RLS suite
  // (packages/database/test/rls.integration.test.ts), which runs against a live Postgres and
  // exercises the policy itself. This is a fast, Docker-free tripwire for the common case of a
  // careless hand-edit or regeneration, not a substitute for that suite.
  it('has no later migration that reopens what this one closed', () => {
    expect(allSql).not.toMatch(
      /DROP POLICY|NO FORCE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY/,
    );
  });
});
