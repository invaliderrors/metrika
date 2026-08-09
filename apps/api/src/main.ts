import { createApiApp } from './bootstrap.js';
import { EnvService } from './config/env.service.js';

async function main(): Promise<void> {
  const app = await createApiApp();
  const { values } = app.get(EnvService);
  await app.listen({ port: values.API_PORT, host: '0.0.0.0' });
}

await main();
