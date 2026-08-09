import { Controller, Get, HttpCode, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ZodResponse } from 'nestjs-zod';
import { EnvService } from '../../config/env.service.js';
import { BEARER_SCHEME } from '../../openapi/build-document.js';
import { DeepHealthGuard } from './deep-health.guard.js';
import { HealthDeepDto, HealthLiveDto, HealthReadyDto } from './health.dto.js';
import { HealthService } from './health.service.js';

/**
 * What a probe answers when a dependency it checks is not usable.
 *
 * A readiness probe that reports `{"status":"down"}` at HTTP **200** is a probe
 * that does not work: docs/OBSERVABILITY.md has this route feeding the load
 * balancer, and an ALB target group — like every other health check in the
 * industry — decides on the STATUS LINE and never parses the body. MEASURED
 * against a really-killed Postgres before this constant existed: `200
 * {"status":"down",…}`, i.e. a task with no database staying in rotation and
 * taking traffic.
 */
const UNAVAILABLE = 503;
const AVAILABLE = 200;
const UNAUTHENTICATED = 401;

/**
 * `@ZodResponse` documents ONE status — the one it also enforces at runtime —
 * so every other status a handler can really answer has to be declared beside
 * it with `@ApiResponse` or it is absent from the emitted document.
 *
 * That absence is not cosmetic. `apps/api/openapi/openapi.json` is what
 * `packages/api-client` is generated from, so a probe documented as 200-only
 * produces a client whose types say the call either succeeds or throws — and
 * the 503 that a real degraded deployment answers arrives as an unmodelled
 * error. The status these routes exist to communicate would be the one status
 * the contract omits. `test/openapi.integration.test.ts` asserts both are
 * present.
 *
 * Both statuses carry the SAME schema, which is correct rather than lazy: the
 * handler returns the same DTO either way and only the status line changes —
 * that is the whole design (see `UNAVAILABLE`).
 */
const UNAVAILABLE_DESCRIPTION = 'At least one dependency is not usable. Do not route traffic here.';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: EnvService,
    private readonly health: HealthService,
  ) {}

  /**
   * Liveness must never check a dependency. A liveness probe that fails because
   * Redis is slow makes the orchestrator kill healthy tasks and turns a
   * degradation into an outage — see docs/OBSERVABILITY.md.
   */
  @Get('live')
  @ZodResponse({
    status: AVAILABLE,
    description: 'The process is running. Says nothing about its dependencies.',
    type: HealthLiveDto,
  })
  live(): HealthLiveDto {
    return { status: 'ok', environment: this.config.values.NODE_ENV };
  }

  /**
   * `checks: [...results]` hands the DTO the FULL DependencyResult, `latencyMs`
   * included, and lets `HealthReadySchema` — which omits that field — be the
   * thing that removes it. Deliberate, not sloppy: hand-stripping the field here
   * would make the schema decorative and would make the global
   * ZodSerializerInterceptor deletable with every test still green. As written,
   * `test/health.integration.test.ts` fails the moment response validation stops
   * running, which is what ADR-0019 obligation 1 requires of it.
   *
   * Readiness is unauthenticated, so it reports WHICH dependencies are up and
   * nothing more. Per-dependency latency is internal topology and lives on
   * /health/deep, behind the token.
   *
   * `@Res({ passthrough: true })` sets the status WITHOUT taking over the
   * response, which is what keeps both halves of the contract intact: the
   * handler still returns a value, so `ZodSerializerInterceptor` still parses it
   * and `HealthReadySchema` still strips `latencyMs`. Nothing is thrown, so
   * `DomainExceptionFilter` never sees this and its `>= 500 → INTERNAL_ERROR`
   * branch — which would flatten the per-dependency body into a generic
   * envelope — never engages. `nestjs-zod` sanctions exactly this shape:
   * `ZodResponse` applies `RequirePassthrough()`, which throws loudly if `@Res()`
   * is used WITHOUT `passthrough`. The `status: 200` on the decorator is the
   * documented success case and does not clobber a status set here.
   */
  @Get('ready')
  @ZodResponse({
    status: AVAILABLE,
    description: 'Every dependency answered. Safe to route traffic here.',
    type: HealthReadyDto,
  })
  @ApiResponse({
    status: UNAVAILABLE,
    description: UNAVAILABLE_DESCRIPTION,
    type: HealthReadyDto,
  })
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReadyDto> {
    const results = await this.health.checkAll();
    const status = results.every((r) => r.status === 'ok') ? 'ok' : 'down';
    reply.status(status === 'ok' ? AVAILABLE : UNAVAILABLE);
    return { status, checks: [...results] };
  }

  @Get('deep')
  @UseGuards(DeepHealthGuard)
  @HttpCode(AVAILABLE)
  @ApiBearerAuth(BEARER_SCHEME)
  @ZodResponse({
    status: AVAILABLE,
    description: 'Every dependency answered, with per-dependency latency.',
    type: HealthDeepDto,
  })
  @ApiResponse({
    status: UNAVAILABLE,
    description: UNAVAILABLE_DESCRIPTION,
    type: HealthDeepDto,
  })
  // No `type` on the 401: the error envelope has no DTO yet. `ApiErrorResponse`
  // is specified in docs/CONTRACTS_AND_API.md §3 but lives nowhere as a schema,
  // and defining a second one here — in a feature module, next to a health probe
  // — is how an envelope ends up with two definitions that drift. The status is
  // declared so a client knows the route can reject; the body arrives with the
  // shared error DTO, in the task that adds it.
  @ApiResponse({
    status: UNAUTHENTICATED,
    description: 'Missing or invalid bearer token. Carries `WWW-Authenticate: Bearer`.',
  })
  async deep(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthDeepDto> {
    const checks = await this.health.checkAll();
    const status = checks.every((c) => c.status === 'ok') ? 'ok' : 'down';
    reply.status(status === 'ok' ? AVAILABLE : UNAVAILABLE);
    return { status, checks: [...checks] };
  }
}
