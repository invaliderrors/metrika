import { describe, expect, it } from 'vitest';
import { ModelId } from '../src/index.js';

describe('branded IDs', () => {
  it('accepts a UUIDv4', () => {
    const raw = '9f1c2b3a-4d5e-4f60-8a1b-2c3d4e5f6071';
    expect(ModelId.parse(raw)).toBe(raw);
  });

  it('accepts a UUIDv7', () => {
    const raw = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4051';
    expect(ModelId.parse(raw)).toBe(raw);
  });

  it('rejects a non-UUID', () => {
    expect(ModelId.safeParse('not-a-uuid').success).toBe(false);
  });

  it('rejects the nil UUID', () => {
    expect(ModelId.safeParse('00000000-0000-0000-0000-000000000000').success).toBe(false);
  });
});
