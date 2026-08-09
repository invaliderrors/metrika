import { Module } from '@nestjs/common';
import { DeepHealthGuard } from './deep-health.guard.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService, DeepHealthGuard],
})
export class HealthModule {}
