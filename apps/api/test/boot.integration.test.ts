import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootApiForTest, stopDatabase } from './support.js';
import { EnvService } from '../src/config/env.service.js';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service.js';

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  ({ app, baseUrl } = await bootApiForTest());
});

afterAll(async () => {
  await app.close();
  await stopDatabase();
});

describe('application boot', () => {
  it('resolves every provider in the real module tree', () => {
    // Constructing the graph is what proves DI: a provider whose constructor
    // parameter type was erased by an `import type` throws
    // UnknownDependenciesException before this line is ever reached.
    expect(app.get(EnvService)).toBeInstanceOf(EnvService);
    expect(app.get(PrismaService)).toBeInstanceOf(PrismaService);
  });

  it('gives PrismaService a working client, not just a resolved token', async () => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.client.$queryRaw<{ one: number }[]>`SELECT 1 AS one`;
    expect(rows[0]?.one).toBe(1);
  });

  it('serves GET /health/live over a real socket', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', environment: 'test' });
  });

  it('does not prefix the health routes — probes must not track the API version', async () => {
    const prefixed = await fetch(`${baseUrl}/api/v1/health/live`);
    expect(prefixed.status).toBe(404);
  });
});
