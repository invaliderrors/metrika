import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import { parseEnv } from '../src/config/env.js';
import { EnvService } from '../src/config/env.service.js';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service.js';
import { HealthController } from '../src/modules/health/health.controller.js';
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
function envFor(databaseUrl: string): EnvService {
  return new EnvService(
    parseEnv({ DATABASE_URL: databaseUrl, HEALTH_DEEP_TOKEN: 'unit-test-health-deep-token' }),
  );
}

function healthServiceAgainst(databaseUrl: string): HealthService {
  return new HealthService(new PrismaService(envFor(databaseUrl)));
}

/**
 * Records what the handler asks for on the reply. `status(code)` returning the
 * reply is Fastify's own contract, and it is the ONLY member either handler
 * touches — deliberately, because a fixture that drifts from the real object
 * makes a test pass that should fail. The real `FastifyReply` is exercised on
 * every request in test/health-unavailable.integration.test.ts, which asserts
 * the 200 and the 503 on the wire; if `.status()` were the wrong call, that
 * suite is what goes red, not this one. This double exists to observe the
 * handler's RETURN VALUE, which no HTTP-level test can see — the interceptor has
 * already rewritten it by the time it reaches the socket.
 */
function replyRecorder(): { reply: FastifyReply; statuses: number[] } {
  const statuses: number[] = [];
  const reply = {
    status(code: number): unknown {
      statuses.push(code);
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, statuses };
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

/**
 * These call the handlers DIRECTLY rather than over HTTP, because the two facts
 * below are invisible from the socket: by the time a response reaches a client,
 * `ZodSerializerInterceptor` has already rewritten it.
 *
 * The obvious alternative does not work, and fails in a way worth recording:
 * `vi.spyOn(HealthController.prototype, 'ready')` before boot MEASURED as
 * `/health/ready → 404`. Nest's decorators store route metadata on the METHOD
 * FUNCTION itself (`Reflect.defineMetadata(PATH_METADATA, …, descriptor.value)`),
 * and `RouterExplorer` reads it off `prototype[methodName]` while scanning. A
 * spy replaces that function, the metadata goes with it, and the route is never
 * registered at all — the suite fails loudly, but a spy on a NON-routed method
 * would silently observe a handler Nest had already closed over. Prototype spies
 * are the right tool on services; on controllers they are not.
 */
describe('HealthController', () => {
  const config = envFor(REFUSED_URL);

  /**
   * The other half of ADR-0019's canary, and the half nothing else defends.
   *
   * `test/health.integration.test.ts` proves `latencyMs` is ABSENT from
   * /health/ready's body, which only means something because the handler put it
   * there and the schema took it out. Tidy `ready()` into
   * `checks: results.map(({ name, status }) => ({ name, status }))` and that
   * assertion still passes — MEASURED at 117/117 — and from there the global
   * ZodSerializerInterceptor can be deleted with the suite still at 117/117.
   * Two innocuous commits, response validation off project-wide, nothing red.
   *
   * This is the assertion that breaks the chain at the controller;
   * test/response-validation.test.ts breaks it at the module.
   */
  it('hands the DTO the full result and lets the response schema strip latencyMs', async () => {
    const controller = new HealthController(config, healthServiceAgainst(REFUSED_URL));
    const { reply } = replyRecorder();

    const returned = await controller.ready(reply);

    // Typed `unknown` on purpose. `HealthReadyDto`'s output type has no
    // `latencyMs` — `returned.checks[0].latencyMs` is `error TS2339`, MEASURED —
    // and that mismatch IS the assertion: the static type says the field is
    // gone, the runtime value still has it, and the response schema is the only
    // thing that closes the gap.
    const check: unknown = returned.checks[0];
    expect(check).toHaveProperty('latencyMs', expect.any(Number));
  });

  /**
   * 503, not 200-with-a-sad-body. docs/OBSERVABILITY.md has /health/ready
   * feeding the load balancer, and an ALB target group decides on the status
   * line and never parses the body. Asserted here per-handler; asserted on the
   * wire, against a really-unreachable database, in
   * test/health-unavailable.integration.test.ts.
   */
  it('sets 503 on both probes when a dependency is down, and 200 when it is not', async () => {
    const down = new HealthController(config, healthServiceAgainst(REFUSED_URL));
    const downReady = replyRecorder();
    const downDeep = replyRecorder();

    await down.ready(downReady.reply);
    await down.deep(downDeep.reply);

    expect(downReady.statuses).toEqual([503]);
    expect(downDeep.statuses).toEqual([503]);
  });

  /**
   * Liveness takes no reply and checks no dependency — it cannot go 503, by
   * construction. Pinned because "make the probes consistent" is a plausible
   * change, and a liveness probe that fails on a dependency makes the
   * orchestrator kill healthy tasks and turns a degradation into an outage.
   */
  it('leaves liveness independent of every dependency', () => {
    const controller = new HealthController(config, healthServiceAgainst(REFUSED_URL));
    expect(controller.live()).toEqual({ status: 'ok', environment: 'development' });
  });
});
