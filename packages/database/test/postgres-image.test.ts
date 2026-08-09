import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { POSTGRES_IMAGE } from '@metrika/testing/images';

const composePath = path.resolve(import.meta.dirname, '../../../infra/docker/docker-compose.yml');

const imageTags = readFileSync(composePath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('image:'))
  .map((line) => line.slice('image:'.length).trim());

describe('the Postgres image has exactly one definition', () => {
  it('finds all four service images, so a moved file cannot make this vacuous', () => {
    expect(imageTags).toHaveLength(4);
  });

  it('brings up locally the same image the Testcontainers harness starts', () => {
    expect(imageTags.filter((tag) => tag.startsWith('postgres:'))).toEqual([POSTGRES_IMAGE]);
  });
});
