import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { EnvService } from '../src/config/env.service.js';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service.js';
import { HealthService } from '../src/modules/health/health.service.js';

/**
 * A port nothing listens on, so the round trip fails with ECONNREFUSED rather
 * than after a connect timeout. Port 1 is reserved and unbindable by an
 * unprivileged process, which is the point: this test must not depend on
 * whatever happens to be running on the machine.
 */
const REFUSED_URL = 'postgresql://nobody:nobody@127.0.0.1:1/nothing?schema=public';

/**
 * A REAL PrismaService over a REAL EnvService, not a cast fixture with a
 * `$queryRaw` that rejects. `createPrismaClient` opens nothing in the
 * constructor — the connection is made by `onModuleInit`, which is deliberately
 * never called here — so the client is genuine and the failure it produces is
 * the one production would produce. A hand-built `{ client: { $queryRaw() } }`
 * cast would assert against this test's idea of Prisma rather than Prisma.
 */
function healthServiceAgainst(databaseUrl: string): HealthService {
  const config = new EnvService(
    parseEnv({ DATABASE_URL: databaseUrl, HEALTH_DEEP_TOKEN: 'unit-test-health-deep-token' }),
  );
  return new HealthService(new PrismaService(config));
}

describe('HealthService', () => {
  /**
   * The only thing in the repository that fails when `checkAll` stops asking the
   * database anything.
   *
   * MEASURED: replacing the body of `checkAll` with a hardcoded
   * `[{ name: 'database', status: 'ok', latencyMs: 0 }]` leaves `pnpm test:unit`
   * AND all 43 integration tests green — every one of them runs against a live
   * container, so "reports ok" and "always reports ok" are indistinguishable
   * there. A readiness probe that cannot fail is worse than no readiness probe:
   * it is a green signal an orchestrator will act on.
   */
  it('reports the database down when the round trip fails', async () => {
    const results = await healthServiceAgainst(REFUSED_URL).checkAll();
    expect(results).toEqual([
      { name: 'database', status: 'down', latencyMs: expect.any(Number) as number },
    ]);
  });

  /**
   * `checkDatabase` swallows the driver error on purpose — a probe that throws
   * would reach DomainExceptionFilter as a 500 INTERNAL_ERROR and report nothing
   * about WHICH dependency failed. This pins that it resolves rather than
   * rejects, which is what lets the controller report per-dependency status.
   */
  it('resolves rather than rejecting when the driver throws', async () => {
    await expect(healthServiceAgainst(REFUSED_URL).checkDatabase()).resolves.toMatchObject({
      name: 'database',
      status: 'down',
    });
  });
});
