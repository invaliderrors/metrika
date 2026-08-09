import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

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

export async function assertDockerAvailable(): Promise<void> {
  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  } catch (error: unknown) {
    throw new DockerUnavailableError(error instanceof Error ? error.message : String(error));
  }
}
