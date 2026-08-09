import { Controller, Get } from '@nestjs/common';
import { EnvService } from '../../config/env.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly config: EnvService) {}

  /**
   * Liveness must never check a dependency. A liveness probe that fails
   * because Redis is slow makes ECS kill healthy tasks and turns a degradation
   * into an outage. See docs/OBSERVABILITY.md §7 (Health checks).
   */
  @Get('live')
  live(): { status: 'ok'; environment: string } {
    return { status: 'ok', environment: this.config.values.NODE_ENV };
  }
}
