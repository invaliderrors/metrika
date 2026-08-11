# Local image pins

Exact-tag pinning guarantees the _major_ version cannot move under us and
gives every developer a comparable Image ID — it does not guarantee
byte-identical images (see below). These are the images resolved when
`infra/docker/docker-compose.yml` was last updated, captured with
`docker compose -f infra/docker/docker-compose.yml images`.

Digest pinning (`image: repo:tag@sha256:…`) applies to the **production** images
built in Plan 0D. Local dependencies are pinned by exact tag: a digest here would
have to be re-resolved per architecture, and these containers hold no production
data.

Two of these tags are **floating**, and this file does not change that.
`postgres:16-alpine` and `redis:7-alpine` track the newest patch of their
respective majors, so a fresh `docker pull` on a new machine can resolve
different bytes from the Image IDs recorded below. What tag pinning does buy is
that the _major_ cannot move under us, and the Image ID column below records
what a given machine actually resolved so a "works on mine" report can be
compared rather than argued about. Byte-identical local stacks would require
digests and a per-architecture refresh policy; that is deliberately out of scope
until Plan 0D, which does exactly that for the images that carry production
data.

`postgres` and `temporal` each additionally have a second consumer —
`POSTGRES_IMAGE` and `TEMPORAL_IMAGE` in `packages/testing/src/images.ts` — and
`packages/database/test/postgres-image.test.ts` fails when either pair diverges.
It also fails on any `:latest` in this file, for the reason in the next
paragraph.

**`temporal`'s tag is the one to leave alone.** [ADR-0027](../../docs/adr/0027-python-toolchain.md)
measured `temporalio/auto-setup:latest` resolving to **1.29.3** while **1.29.7**
was published — four patch releases stale. So "latest" here would pin _older_
than naming a version does, silently, with the word "latest" on screen saying
otherwise. `auto-setup` is a local/test image specifically: it provisions the
`default` namespace and search attributes on first boot. Production is Temporal
Cloud ([ADR-0006](../../docs/adr/0006-temporal.md)) and has no counterpart.

| Service     | Image                 | Tag                          | Image ID     |
| ----------- | --------------------- | ---------------------------- | ------------ |
| postgres    | postgres              | 16-alpine                    | 57c72fd2a128 |
| redis       | redis                 | 7-alpine                     | e7723ff73d96 |
| minio       | minio/minio           | RELEASE.2025-09-07T16-13-09Z | 14cea493d9a3 |
| temporal    | temporalio/auto-setup | 1.29.7                       | f14912b699cf |
| temporal-ui | temporalio/ui         | 2.53.2                       | 0c89f0e96b8d |
| mailpit     | axllent/mailpit       | v1.30.7                      | d5ecbb067db3 |
