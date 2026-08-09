import { PrismaClient } from '@prisma/client';

export function make(): PrismaClient {
  return new PrismaClient();
}
