export type { Prisma, PrismaClient as MetrikaPrismaClient } from '@prisma/client';
export {
  createPrismaClient,
  withIdentityContext,
  withOrganizationContext,
  withTenantContext,
  type DatabaseConfig,
  type IdentityScope,
  type TenantScope,
} from './client.js';
export { HardDeleteForbiddenError } from './errors.js';
export { SOFT_DELETABLE_MODELS, withDeleted } from './extensions/soft-delete.js';
