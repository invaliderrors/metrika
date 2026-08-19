import { describe, expectTypeOf, it } from 'vitest';
import type {
  MaterialId,
  ModelId,
  ModelVersionId,
  OrderId,
  OrganizationId,
  OrganizationMemberId,
  PrintJobId,
  PrinterProfileVersionId,
  ProjectId,
  QuoteId,
  SliceJobId,
  UserId,
} from '../src/index.js';

/**
 * The complete 66-pair distinctness matrix, in 12 assertions.
 *
 * The previous version of this file asserted a declaration-order ring
 * (UserId≠OrganizationId, OrganizationId≠ProjectId, …). A ring catches an
 * ADJACENT collision only: `export const UserId = brandedUuid('QuoteId')`
 * left every ring assertion true and all 205 tests green at 100% coverage.
 *
 * `AssignableMember<U, T>` distributes over the union `U` and yields `true`
 * if ANY single member is assignable to `T`, `never` otherwise. Asserting the
 * result is `never` therefore fails on one collision anywhere in the matrix,
 * not just on a neighbouring one. Each of the 12 `NoCollision<K>` checks
 * compares one ID against the union of the other 11 in a single distributed
 * conditional; 12 checks × 11 others each covers all 66 unordered pairs, in
 * both assignability directions.
 *
 * `OrganizationMemberId` joined in Plan 1A Task 2 and is asserted here for the
 * reason the matrix exists: `brandedUuid('OrganizationId')` written where
 * `brandedUuid('OrganizationMemberId')` was meant emits an IDENTICAL JSON
 * Schema, so `pnpm contracts:emit`, the pydantic diff and every runtime test
 * stay green. The brand is only observable in the type system.
 *
 * Mutation-tested against four cases — each edit made to src/ids.ts, `pnpm
 * --filter @metrika/contracts typecheck` and `test:unit` re-run to confirm
 * `TS2344: Type 'false' does not satisfy the constraint 'true'.` on the
 * affected `_XIsUnique` alias(es), then reverted:
 *   - non-adjacent collision: `UserId := brandedUuid('QuoteId')` → fails
 *     `_UserIdIsUnique` and `_QuoteIdIsUnique`
 *   - a second, unrelated non-adjacent collision:
 *     `OrganizationId := brandedUuid('MaterialId')` → fails
 *     `_OrganizationIdIsUnique` and `_MaterialIdIsUnique`
 *   - adjacent collision (the one case the old ring also caught):
 *     `PrintJobId := brandedUuid('SliceJobId')` → fails
 *     `_SliceJobIdIsUnique` and `_PrintJobIdIsUnique`
 *   - total brand loss (schema stops calling `.brand()` entirely):
 *     `SliceJobId := z.string()` → fails `_SliceJobIdIsUnique` alone, because
 *     every remaining branded ID structurally extends bare `string`
 *
 * Read `vitest run --coverage` output carefully: a failure here surfaces as
 * `Test Files: N failed` and a `FAIL … TypeCheckError` block, and as a
 * non-zero exit code from both `pnpm typecheck` and `pnpm test:unit` — NOT
 * as a change to the "Tests passed" or "Type Errors" summary lines further
 * down. Those two lines are separate Vitest counters (runtime test results;
 * a distinct diagnostics tally) that stay unchanged even when every
 * assertion in this file fails, and reading only them looks like a pass.
 *
 * These are raw type-level assertions rather than `expectTypeOf`, because a
 * `type X = Expect<...>` is checked by BOTH `pnpm typecheck` (tsconfig.json
 * includes test/**) and `vitest --typecheck`. An `expectTypeOf` call is only
 * checked by the latter.
 */
interface IdMap {
  UserId: UserId;
  OrganizationId: OrganizationId;
  ProjectId: ProjectId;
  ModelId: ModelId;
  ModelVersionId: ModelVersionId;
  QuoteId: QuoteId;
  OrderId: OrderId;
  SliceJobId: SliceJobId;
  PrintJobId: PrintJobId;
  MaterialId: MaterialId;
  PrinterProfileVersionId: PrinterProfileVersionId;
  OrganizationMemberId: OrganizationMemberId;
}

type OtherIds<K extends keyof IdMap> = IdMap[Exclude<keyof IdMap, K>];

type AssignableMember<U, T> = U extends unknown ? (U extends T ? true : never) : never;

type Expect<T extends true> = T;

type NoCollision<K extends keyof IdMap> = [AssignableMember<OtherIds<K>, IdMap[K]>] extends [never]
  ? true
  : false;

type _UserIdIsUnique = Expect<NoCollision<'UserId'>>;
type _OrganizationIdIsUnique = Expect<NoCollision<'OrganizationId'>>;
type _ProjectIdIsUnique = Expect<NoCollision<'ProjectId'>>;
type _ModelIdIsUnique = Expect<NoCollision<'ModelId'>>;
type _ModelVersionIdIsUnique = Expect<NoCollision<'ModelVersionId'>>;
type _QuoteIdIsUnique = Expect<NoCollision<'QuoteId'>>;
type _OrderIdIsUnique = Expect<NoCollision<'OrderId'>>;
type _SliceJobIdIsUnique = Expect<NoCollision<'SliceJobId'>>;
type _PrintJobIdIsUnique = Expect<NoCollision<'PrintJobId'>>;
type _MaterialIdIsUnique = Expect<NoCollision<'MaterialId'>>;
type _PrinterProfileVersionIdIsUnique = Expect<NoCollision<'PrinterProfileVersionId'>>;
type _OrganizationMemberIdIsUnique = Expect<NoCollision<'OrganizationMemberId'>>;

describe('branded IDs', () => {
  it('lets a ModelId be used wherever a string is expected', () => {
    expectTypeOf<ModelId>().toExtend<string>();
  });

  it('does not let a bare string satisfy ModelId', () => {
    expectTypeOf<string>().not.toExtend<ModelId>();
  });
});
