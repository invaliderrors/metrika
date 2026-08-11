/**
 * The single definition of the Postgres image, used by the Testcontainers
 * harness. `infra/docker/docker-compose.yml` carries the same string with a
 * KEEP IN SYNC comment, because YAML cannot import TypeScript, and
 * packages/database/test/postgres-image.test.ts fails when the two diverge. A
 * local stack on one Postgres major and a test run on another is a green CI
 * with a broken laptop.
 */
export const POSTGRES_IMAGE = 'postgres:16-alpine';

/**
 * The Temporal server image, pinned by
 * [ADR-0027](../../../docs/adr/0027-python-toolchain.md). Same KEEP IN SYNC
 * contract as {@link POSTGRES_IMAGE}, and the same test enforces it.
 *
 * `auto-setup` rather than `temporalio/server`, because it provisions the
 * `default` namespace and the search attributes on first boot — the harness
 * has nothing else that could. It is a local/test image only; production is
 * Temporal Cloud (ADR-0006).
 *
 * Never `:latest`. MEASURED 2026-08-10: that tag resolves to 1.29.3, four
 * patch releases BEHIND this one — so "latest" would pin older than a version
 * does, while reading as newer.
 */
export const TEMPORAL_IMAGE = 'temporalio/auto-setup:1.29.7';
