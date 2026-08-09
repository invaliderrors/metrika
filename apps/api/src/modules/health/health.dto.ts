import { z } from 'zod';
import { metrikaDto } from '../../shared/http/zod-dto.js';

export const HealthStatus = z.enum(['ok', 'degraded', 'down']);

export const DependencyCheck = z.object({
  name: z.string(),
  status: HealthStatus,
  latencyMs: z.number().nonnegative(),
});

export const HealthLiveSchema = z.object({
  status: z.literal('ok'),
  environment: z.enum(['development', 'test', 'production']),
});

export const HealthReadySchema = z.object({
  status: HealthStatus,
  checks: z.array(DependencyCheck.omit({ latencyMs: true })),
});

export const HealthDeepSchema = z.object({
  status: HealthStatus,
  checks: z.array(DependencyCheck),
});

export class HealthLiveDto extends metrikaDto(HealthLiveSchema) {}
export class HealthReadyDto extends metrikaDto(HealthReadySchema) {}
export class HealthDeepDto extends metrikaDto(HealthDeepSchema) {}
