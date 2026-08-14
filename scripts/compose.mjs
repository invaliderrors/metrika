#!/usr/bin/env node
// The entry point for `pnpm infra:up`, `infra:down` and `infra:reset`, and the
// reason none of them is a bare `docker compose -f …` any more.
//
// `docker compose` interpolates `${…}` in the compose file from its own
// environment, and its `--env-file` defaults to `.env` in the PROJECT
// DIRECTORY — which, because `-f infra/docker/docker-compose.yml` is passed
// explicitly, is `infra/docker/`, not the repository root. So the root `.env`,
// the only environment file this project has, is invisible to compose unless
// something puts it into the environment first. That is this file, via
// `--env-file-if-exists` on the npm script, exactly as `scripts/turbo.mjs` and
// `scripts/prisma.mjs` do it. A real environment variable still wins over the
// file, so exporting `POSTGRES_HOST_PORT` for one command also works.
//
// Passing `-f` also disables compose's automatic `docker-compose.override.yml`
// pickup, which is the other route a per-machine port change might have taken
// and does not work here. One knob in one committed file, defaulted, is the
// substitute — see the `ports` comment on the `postgres` service.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(repoRoot, 'infra/docker/docker-compose.yml');

// `docker` is a real executable on every platform this repository targets, so
// it needs neither a shell nor the `.cmd` handling in `run-bin.mjs`.
const result = spawnSync('docker', ['compose', '-f', composeFile, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`Could not run \`docker\`: ${result.error.message}\nIs Docker installed?\n`);
}

process.exit(result.status ?? 1);
