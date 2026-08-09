import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { HardDeleteForbiddenError } from '../errors.js';

/**
 * Soft delete applies to entities a customer can "delete" and might need
 * recovered, and whose disappearance would orphan history. It explicitly does
 * NOT apply to Quote, Order, SliceResult, GeometryAnalysis, AuditLog,
 * StatusTransition or Payment: those are immutable or ledger records, archived
 * by state and never deleted. A soft-delete flag on an immutable record invites
 * someone to hide commercial evidence. See docs/DOMAIN_MODEL.md §6.
 *
 * Phase 1 adds User, Organization, Project and Model. RlsProbe is here now so
 * the behaviour has a regression fixture from the first migration onward.
 */
export const SOFT_DELETABLE_MODELS: ReadonlySet<string> = new Set(['RlsProbe']);

const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const REFUSED_OPERATIONS: ReadonlySet<string> = new Set(['delete', 'deleteMany']);

interface QueryArgs {
  where?: Record<string, unknown>;
}

function isQueryArgs(value: unknown): value is QueryArgs {
  return typeof value === 'object' && value !== null;
}

const deletedVisible = new AsyncLocalStorage<true>();

/**
 * The explicit escape hatch docs/DOMAIN_MODEL.md §6 specifies for admin
 * queries. Everything the callback does — at any await depth — sees
 * soft-deleted rows.
 *
 * It is a scoped function rather than a flag or a second client because both
 * of those alternatives can be left switched on. `AsyncLocalStorage` restores
 * the previous state when the callback settles, including when it throws, so
 * "forgot to turn filtering back on" is not a reachable state.
 */
export async function withDeleted<T>(fn: () => Promise<T>): Promise<T> {
  return deletedVisible.run(true, fn);
}

/**
 * Applied through an extension rather than by convention, so it cannot be
 * forgotten — which matters more than usual when an agent is writing the
 * queries. There are exactly two ways past it, both deliberate: `withDeleted()`
 * above, and a caller that names `deletedAt` in its own `where`, which has
 * already said what it wants.
 */
export const softDeleteExtension = Prisma.defineExtension({
  name: 'metrika-soft-delete',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!SOFT_DELETABLE_MODELS.has(model)) {
          return query(args);
        }

        if (REFUSED_OPERATIONS.has(operation)) {
          throw new HardDeleteForbiddenError(model);
        }

        if (!FILTERED_OPERATIONS.has(operation) || deletedVisible.getStore() === true) {
          return query(args);
        }

        // Fail CLOSED on an unrecognised args shape. `findMany()` with no
        // arguments at all is the most common call in the codebase; treating a
        // missing `args` as "nothing to filter" and passing it through is the
        // one branch here that leaks rows, and it leaks them on the happy path.
        const safeArgs: QueryArgs = isQueryArgs(args) ? args : {};

        const where = safeArgs.where ?? {};
        if ('deletedAt' in where) {
          return query(safeArgs);
        }

        return query({ ...safeArgs, where: { ...where, deletedAt: null } });
      },
    },
  },
});
