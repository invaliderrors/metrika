import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type MetrikaPrismaClient } from '@metrika/database';
import { EnvService } from '../../config/env.service.js';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: MetrikaPrismaClient;

  // `EnvService` is imported as a VALUE, not with `import type`. An
  // `import type` here erases the binding that emitDecoratorMetadata writes
  // into design:paramtypes; Nest then reads the global `Function`, cannot
  // resolve it, and throws UnknownDependenciesException at boot. tsc reports
  // nothing and eslint reports nothing. test/boot.integration.test.ts is the
  // only thing that catches it. See the Global Constraints of Plan 0B-1.
  constructor(private readonly config: EnvService) {
    this.client = createPrismaClient({ databaseUrl: this.config.values.DATABASE_URL });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    // pg.Pool is lazy on Prisma 7, so $connect() alone opens no backend and the
    // process would report itself healthy with an unreachable database. One
    // round trip restores fail-fast at boot. See ADR-0037.
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
