import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

import { createPrismaClient } from '@metrika/database';

/**
 * Liveness — process is up. Used by orchestrator.
 * Readiness — can serve traffic (DB reachable).
 * Deep — full dependency check, used for on-call debugging only.
 */
@Controller('health')
export class HealthController {
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, 'up' | 'down'> }> {
    const checks: Record<string, 'up' | 'down'> = { database: 'down' };
    try {
      const prisma = createPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
      await prisma.$disconnect();
      checks['database'] = 'up';
    } catch {
      checks['database'] = 'down';
    }
    const status = Object.values(checks).every((v) => v === 'up') ? 'ok' : 'degraded';
    return { status, checks };
  }

  @Get('deep')
  async deep(): Promise<{
    status: 'ok' | 'degraded';
    checks: Record<string, 'up' | 'down'>;
    uptime: number;
  }> {
    const ready = await this.ready();
    return { ...ready, uptime: process.uptime() };
  }
}
