import { describe, expectTypeOf, it } from 'vitest';
import type { ModelId, ProjectId } from '../src/index.js';

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
});
