import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { POSTGRES_IMAGE, TEMPORAL_IMAGE } from '@metrika/testing/images';

const composePath = path.resolve(import.meta.dirname, '../../../infra/docker/docker-compose.yml');

const imageTags = readFileSync(composePath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('image:'))
  .map((line) => line.slice('image:'.length).trim());

// This file lives in packages/database rather than in packages/testing, which
// owns both constants, for one mechanical reason: it reads a file OUTSIDE its
// own package, which turbo does not hash, so it needs a `$TURBO_ROOT$` entry in
// a package-level turbo.json to avoid passing from cache against a drifted
// compose file. packages/database already has that declaration and a
// `test:unit` task to hang it on; packages/testing has neither. Moving it would
// mean re-deriving both, and a second place to get the same trap wrong.
describe('the compose file pins every image, and agrees with the Testcontainers harnesses', () => {
  it('finds all six service images, so a moved file cannot make this vacuous', () => {
    expect(imageTags).toHaveLength(6);
  });

  it('brings up locally the same Postgres image the Testcontainers harness starts', () => {
    expect(imageTags.filter((tag) => tag.startsWith('postgres:'))).toEqual([POSTGRES_IMAGE]);
  });

  it('brings up locally the same Temporal image the Testcontainers harness starts', () => {
    expect(imageTags.filter((tag) => tag.startsWith('temporalio/auto-setup:'))).toEqual([
      TEMPORAL_IMAGE,
    ]);
  });

  it('pins every image by an explicit tag, never :latest', () => {
    // ADR-0027 measured `temporalio/auto-setup:latest` resolving to 1.29.3
    // while 1.29.7 was published — so "latest" pins OLDER than a version does,
    // silently. A compose file that reintroduces it fails here.
    expect(imageTags.filter((tag) => tag.endsWith(':latest') || !tag.includes(':'))).toEqual([]);
  });
});
