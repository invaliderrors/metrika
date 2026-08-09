/**
 * The single definition of the Postgres image, used by the Testcontainers
 * harness. `infra/docker/docker-compose.yml` carries the same string with a
 * KEEP IN SYNC comment, because YAML cannot import TypeScript, and
 * packages/database/test/postgres-image.test.ts fails when the two diverge. A
 * local stack on one Postgres major and a test run on another is a green CI
 * with a broken laptop.
 */
export const POSTGRES_IMAGE = 'postgres:16-alpine';
