import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Phase 0: nothing to seed. Phase 1 seeds identity; Phase 5 seeds manufacturing config.
  console.log('seed: no-op (Phase 0)');
  await prisma.$disconnect();
}

void main();
