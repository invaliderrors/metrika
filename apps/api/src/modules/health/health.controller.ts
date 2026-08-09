import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';
import { ZodResponse } from 'nestjs-zod';
import { EnvService } from '../../config/env.service.js';
import { DeepHealthGuard } from './deep-health.guard.js';
import { HealthDeepDto, HealthLiveDto, HealthReadyDto } from './health.dto.js';
import { HealthService } from './health.service.js';

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
  @ZodResponse({ status: 200, type: HealthLiveDto })
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
   */
  @Get('ready')
  @ZodResponse({ status: 200, type: HealthReadyDto })
  async ready(): Promise<HealthReadyDto> {
    const results = await this.health.checkAll();
    const status = results.every((r) => r.status === 'ok') ? 'ok' : 'down';
    return { status, checks: [...results] };
  }

  @Get('deep')
  @UseGuards(DeepHealthGuard)
  @HttpCode(200)
  @ZodResponse({ status: 200, type: HealthDeepDto })
  async deep(): Promise<HealthDeepDto> {
    const checks = await this.health.checkAll();
    const status = checks.every((c) => c.status === 'ok') ? 'ok' : 'down';
    return { status, checks: [...checks] };
  }
}
