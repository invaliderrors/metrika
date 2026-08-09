# Local image pins

`pnpm infra:up` must resolve the same bytes on every machine. These are the
images resolved when `infra/docker/docker-compose.yml` was last updated, captured
with `docker compose -f infra/docker/docker-compose.yml images`.

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

`postgres`'s tag additionally has a second consumer — `POSTGRES_IMAGE` in
`packages/testing/src/images.ts` — and a test that fails when the two diverge.

| Service  | Image           | Tag                          | Image ID     |
| -------- | --------------- | ---------------------------- | ------------ |
| postgres | postgres        | 16-alpine                    | 57c72fd2a128 |
| redis    | redis           | 7-alpine                     | e7723ff73d96 |
| minio    | minio/minio     | RELEASE.2025-09-07T16-13-09Z | 14cea493d9a3 |
| mailpit  | axllent/mailpit | v1.30.7                      | d5ecbb067db3 |
