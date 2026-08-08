import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { type NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';

import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './infrastructure/telemetry/logger.js';
import { startTelemetry } from './infrastructure/telemetry/otel.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const telemetry = startTelemetry(env);
  const logger = createLogger(env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );

  await app.register(fastifyHelmet, { contentSecurityPolicy: false });
  await app.register(fastifyCors, {
    origin: env.NODE_ENV === 'production' ? [] : true, // tightened in Phase 1
    credentials: false,
  });

  app.setGlobalPrefix('api/v1', { exclude: ['/health/(.*)'] });
  app.enableShutdownHooks();

  await app.listen(env.PORT, env.HOST);
  logger.info({ port: env.PORT, host: env.HOST }, 'metrika-api listening');

  const shutdown = async (): Promise<void> => {
    await app.close();
    if (telemetry) {
      await telemetry.shutdown();
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void bootstrap();
