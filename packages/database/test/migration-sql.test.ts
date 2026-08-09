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

  it('FORCES row-level security, so the table owner is not exempt', () => {
    expect(allSql).toContain('ALTER TABLE "RlsProbe" FORCE ROW LEVEL SECURITY');
  });

  it('constrains writes as well as reads — a USING-only policy lets a caller plant a foreign row', () => {
    expect(allSql).toContain('WITH CHECK ("organizationId" = app_current_org_id())');
  });
});
