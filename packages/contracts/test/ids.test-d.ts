import { describe, expectTypeOf, it } from 'vitest';
import type {
  MaterialId,
  ModelId,
  ModelVersionId,
  OrderId,
  OrganizationId,
  PrinterProfileVersionId,
  PrintJobId,
  ProjectId,
  QuoteId,
  SliceJobId,
  UserId,
} from '../src/index.js';

describe('branded IDs are nominally distinct', () => {
  it('does not let a ProjectId satisfy ModelId', () => {
    expectTypeOf<ProjectId>().not.toEqualTypeOf<ModelId>();
  });

  it('does not let a bare string satisfy ModelId', () => {
    expectTypeOf<string>().not.toEqualTypeOf<ModelId>();
  });

  it('lets a ModelId be used as a string', () => {
    expectTypeOf<ModelId>().toExtend<string>();
  });

  // --- Every one of the eleven IDs, individually ---
  //
  // Each ID must be distinct from a bare `string` on its own: comparing two
  // still-branded siblings pairwise would pass even if BOTH had silently lost
  // their brand (two plain strings still "equal" each other), so the
  // per-brand-vs-`string` check is what actually catches a brand quietly
  // degrading to unbranded.

  it('does not let UserId satisfy a bare string', () => {
    expectTypeOf<UserId>().not.toEqualTypeOf<string>();
  });

  it('does not let OrganizationId satisfy a bare string', () => {
    expectTypeOf<OrganizationId>().not.toEqualTypeOf<string>();
  });

  it('does not let ProjectId satisfy a bare string', () => {
    expectTypeOf<ProjectId>().not.toEqualTypeOf<string>();
  });

  it('does not let ModelId satisfy a bare string', () => {
    expectTypeOf<ModelId>().not.toEqualTypeOf<string>();
  });

  it('does not let ModelVersionId satisfy a bare string', () => {
    expectTypeOf<ModelVersionId>().not.toEqualTypeOf<string>();
  });

  it('does not let QuoteId satisfy a bare string', () => {
    expectTypeOf<QuoteId>().not.toEqualTypeOf<string>();
  });

  it('does not let OrderId satisfy a bare string', () => {
    expectTypeOf<OrderId>().not.toEqualTypeOf<string>();
  });

  it('does not let SliceJobId satisfy a bare string', () => {
    expectTypeOf<SliceJobId>().not.toEqualTypeOf<string>();
  });

  it('does not let PrintJobId satisfy a bare string', () => {
    expectTypeOf<PrintJobId>().not.toEqualTypeOf<string>();
  });

  it('does not let MaterialId satisfy a bare string', () => {
    expectTypeOf<MaterialId>().not.toEqualTypeOf<string>();
  });

  it('does not let PrinterProfileVersionId satisfy a bare string', () => {
    expectTypeOf<PrinterProfileVersionId>().not.toEqualTypeOf<string>();
  });

  // --- Every one of the eleven IDs, against at least one sibling ---
  //
  // A ring over all eleven brands, in declaration order from src/ids.ts, so
  // every ID is asserted distinct from its neighbour and the ring closes back
  // to the first. This is what catches two IDs sharing a brand — e.g.
  // `PrintJobId = brandedUuid('SliceJobId')` — which the "vs bare string"
  // checks above cannot: both sides are still branded there, just with the
  // same brand, so they are NOT "just a string" and those checks pass right
  // past the collision. SliceJobId and PrintJobId are adjacent in src/ids.ts,
  // so this ring includes that exact pair.

  it('does not let UserId satisfy OrganizationId', () => {
    expectTypeOf<UserId>().not.toEqualTypeOf<OrganizationId>();
  });

  it('does not let OrganizationId satisfy ProjectId', () => {
    expectTypeOf<OrganizationId>().not.toEqualTypeOf<ProjectId>();
  });

  it('does not let ProjectId satisfy ModelId', () => {
    expectTypeOf<ProjectId>().not.toEqualTypeOf<ModelId>();
  });

  it('does not let ModelId satisfy ModelVersionId', () => {
    expectTypeOf<ModelId>().not.toEqualTypeOf<ModelVersionId>();
  });

  it('does not let ModelVersionId satisfy QuoteId', () => {
    expectTypeOf<ModelVersionId>().not.toEqualTypeOf<QuoteId>();
  });

  it('does not let QuoteId satisfy OrderId', () => {
    expectTypeOf<QuoteId>().not.toEqualTypeOf<OrderId>();
  });

  it('does not let OrderId satisfy SliceJobId', () => {
    expectTypeOf<OrderId>().not.toEqualTypeOf<SliceJobId>();
  });

  it('does not let SliceJobId satisfy PrintJobId', () => {
    expectTypeOf<SliceJobId>().not.toEqualTypeOf<PrintJobId>();
  });

  it('does not let PrintJobId satisfy MaterialId', () => {
    expectTypeOf<PrintJobId>().not.toEqualTypeOf<MaterialId>();
  });

  it('does not let MaterialId satisfy PrinterProfileVersionId', () => {
    expectTypeOf<MaterialId>().not.toEqualTypeOf<PrinterProfileVersionId>();
  });

  it('does not let PrinterProfileVersionId satisfy UserId — closes the ring', () => {
    expectTypeOf<PrinterProfileVersionId>().not.toEqualTypeOf<UserId>();
  });
});
