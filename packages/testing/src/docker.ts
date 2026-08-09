import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// A stale remote Docker context, a dropped VPN, or a firewall that DROPs
// rather than REJECTs all leave `docker info` hanging rather than failing
// fast. MEASURED against a blackholed DOCKER_HOST (a reserved, unroutable
// TEST-NET-1 address): the Docker CLI itself does not give up for ~32.8s.
// Bounding it here means a newcomer sees this package's readable error
// within seconds instead of waiting out the CLI's own timeout first.
const PREFLIGHT_TIMEOUT_MS = 10_000;

export class DockerUnavailableError extends Error {
  constructor(cause: string) {
    super(
      [
        'Docker is not reachable, so integration tests cannot run.',
        '',
        `  ${cause}`,
        '',
        'Fix: start Docker Desktop, OrbStack or Colima, then re-run.',
        'Unit tests (`pnpm test:unit`) do not need Docker and are unaffected.',
      ].join('\n'),
    );
    this.name = 'DockerUnavailableError';
  }
}

// KNOWN LIMITATION, not fixed in this round: this shells out to the `docker`
// CLI binary specifically. Testcontainers itself talks to the daemon through
// `dockerode`, over a socket or `DOCKER_HOST`, and does not require the CLI
// to be on PATH at all — a rootless setup, a Podman Docker-API shim, or a
// remote host reachable only via `DOCKER_HOST` can all be a perfectly working
// target for Testcontainers while having no `docker` binary for this
// preflight to find, in which case this function refuses a setup that would
// actually have worked. Fixing this properly means replacing the `execFile`
// call below with `dockerode`'s own ping, matching what Testcontainers
// already does internally, rather than re-deriving daemon reachability
// through a second, CLI-shaped path — a larger change than this preflight's
// current job (a readable error for the documented, CLI-having local
// environment this repo's `docs/LOCAL_DEVELOPMENT.md` describes). Revisit if
// this repo ever needs to support a CLI-less runtime.
export async function assertDockerAvailable(): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: PREFLIGHT_TIMEOUT_MS,
    }));
  } catch (error: unknown) {
    throw new DockerUnavailableError(error instanceof Error ? error.message : String(error));
  }

  // MEASURED, not hypothetical: against a blackholed host (packets dropped,
  // not refused — e.g. a stale remote Docker context or a dead VPN tunnel),
  // the `docker` CLI itself exits 0 with empty stdout after its own ~32.8s
  // internal wait, rather than a non-zero exit `execFile` would reject on. A
  // live daemon always prints a version string for this format, so an empty
  // one is the daemon never having answered — the exact "unreachable" case
  // this preflight exists to name, just one `execFile` cannot detect through
  // its exit code alone.
  if (stdout.trim() === '') {
    throw new DockerUnavailableError(
      'docker info returned no server version — the command exited without an error, ' +
        'but the daemon never actually answered (a stale DOCKER_HOST, a dropped VPN, ' +
        'or a firewall silently dropping packets are the usual causes).',
    );
  }
}
