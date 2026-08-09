import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({ imports: [ConfigModule, PersistenceModule, HealthModule] })
export class AppModule {}
