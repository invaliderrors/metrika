import { PrismaClient } from '@prisma/client';

/**
 * `pnpm db:reset` — drop schema, re-apply migrations, seed.
 * Refuses to run when NODE_ENV=production.
 */
async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    console.error('db:reset refused — NODE_ENV=production');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  console.log('db:reset — dropping schema public CASCADE');
  await prisma.$executeRawUnsafe('DROP SCHEMA public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  console.log('db:reset — done. Run `pnpm db:migrate && pnpm db:seed` to finish.');
}

void main();
