import { PrismaClient } from '@prisma/client/edge';
import { schema } from '@metrika/database/testing';

export function describe(): string {
  return `${String(PrismaClient)} ${String(schema)}`;
}
