import { describe, expectTypeOf, it } from 'vitest';
import type {
  MaterialId,
  ModelId,
  ModelVersionId,
  OrderId,
  OrganizationId,
  PrintJobId,
  PrinterProfileVersionId,
  ProjectId,
  QuoteId,
  SliceJobId,
  UserId,
} from '../src/index.js';

/**
 * The complete 55-pair distinctness matrix, in 11 assertions.
 *
 * The previous version of this file asserted a declaration-order ring
 * (UserId≠OrganizationId, OrganizationId≠ProjectId, …). A ring catches an
 * ADJACENT collision only: `export const UserId = brandedUuid('QuoteId')`
 * left every ring assertion true and all 172 tests green at 100% coverage.
 *
 * `AssignableMember<U, T>` distributes over the union `U` and yields `true`
 * if ANY single member is assignable to `T`, `never` otherwise. Asserting the
 * result is `never` therefore fails on one collision anywhere in the matrix,
 * not just on a neighbouring one.
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

describe('branded IDs', () => {
  it('lets a ModelId be used wherever a string is expected', () => {
    expectTypeOf<ModelId>().toExtend<string>();
  });

  it('does not let a bare string satisfy ModelId', () => {
    expectTypeOf<string>().not.toExtend<ModelId>();
  });
});
