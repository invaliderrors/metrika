import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/persistence/prisma.service.js';

export interface DependencyResult {
  readonly name: string;
  readonly status: 'ok' | 'degraded' | 'down';
  readonly latencyMs: number;
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A real round trip, not a connection check: a pool that has a socket open to
   * a database that is refusing queries is not ready, and `$connect()` alone
   * would report it as healthy.
   */
  async checkDatabase(): Promise<DependencyResult> {
    const startedAt = performance.now();
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      return { name: 'database', status: 'ok', latencyMs: performance.now() - startedAt };
    } catch {
      return { name: 'database', status: 'down', latencyMs: performance.now() - startedAt };
    }
  }

  async checkAll(): Promise<readonly DependencyResult[]> {
    return [await this.checkDatabase()];
  }
}
