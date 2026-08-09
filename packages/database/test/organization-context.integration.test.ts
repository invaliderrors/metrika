import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopDatabase } from './support.js';
import { createPrismaClient, withOrganizationContext } from '../src/index.js';

afterAll(async () => {
  await stopDatabase();
});

describe('organization context', () => {
  it('does not leak past its scope on a reused client', async () => {
    // Deliberately bypasses test/support.ts's withDatabase(), which builds a
    // fresh, single-use client per call — exactly the shape that made Task
    // 7's original Step 10 mutation (dropping the $transaction wrapper)
    // invisible to every test in this suite: each call got its own idle
    // connection, so the two sequential queries inside it were reused on the
    // same physical backend by accident, and the missing transaction never
    // got the chance to leak across a SECOND client acquisition.
    //
    // This test reuses ONE client across two separate operations instead:
    // a write inside withOrganizationContext(orgA), then a read OUTSIDE any
    // context on the same client. Under the shipped $transaction form,
    // `app.current_org_id` is transaction-local and reverts the moment the
    // transaction commits, so the unscoped read sees no context and RLS
    // denies every row. Under the Step 10 mutation (`SET` instead of a
    // transaction-scoped `set_config(..., true)`), the setting persists on
    // whichever connection the pool happens to hand back, and the unscoped
    // read can see the row that was just written — a silent cross-tenant
    // leak with no concurrency and no pool tuning required to observe it.
    const ORG = randomUUID();
    const handle = await startTestDatabase();
    const db = createPrismaClient({ databaseUrl: handle.applicationUrl });

    try {
      await withOrganizationContext(db, ORG, async (tx) => {
        await tx.rlsProbe.create({ data: { organizationId: ORG, label: 'gate-row' } });
      });

      const rows = await db.rlsProbe.findMany();
      expect(rows).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });
});
