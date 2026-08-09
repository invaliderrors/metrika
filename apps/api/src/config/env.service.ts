import type { Env } from './env.js';

/**
 * Deliberately NOT decorated with @Injectable(): ConfigModule provides it
 * through `useFactory`, so Nest never resolves its constructor parameters. A
 * class token with a factory is the simplest thing that gives the rest of the
 * app a single injectable handle on validated configuration.
 */
export class EnvService {
  constructor(readonly values: Env) {}
}
