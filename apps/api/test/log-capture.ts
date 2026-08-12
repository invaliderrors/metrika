import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import type { Env } from '../src/config/env.js';
import { createLogger } from '../src/infrastructure/telemetry/logger.js';

/**
 * The REAL logger, writing into memory.
 *
 * Deliberately built through `createLogger` rather than by calling `pino()`
 * with the same options: a fixture that reconstructs the configuration grades
 * a copy of the control, and the copy cannot drift the way the original can.
 * The only thing this fixture supplies is the destination, which is why
 * `createLogger` takes one.
 */
export interface CapturedLog {
  readonly logger: Logger;
  /** Every line emitted so far, parsed. */
  readonly lines: () => readonly Record<string, unknown>[];
  /** The raw bytes, for "this secret is nowhere in the output" assertions. */
  readonly raw: () => string;
  /** The single line emitted, which fails loudly if there is not exactly one. */
  readonly only: () => Record<string, unknown>;
}

export function captureLogger(env: Pick<Env, 'LOG_LEVEL'> = { LOG_LEVEL: 'info' }): CapturedLog {
  let written = '';
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, done): void {
      written += chunk.toString();
      done();
    },
  });

  const lines = (): readonly Record<string, unknown>[] =>
    written
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    logger: createLogger(env, destination),
    lines,
    raw: () => written,
    only: () => {
      const emitted = lines();
      if (emitted.length !== 1) {
        throw new Error(`expected exactly one log line, got ${String(emitted.length)}: ${written}`);
      }
      // Non-null: the length check above is what establishes it, and
      // `noUncheckedIndexedAccess` cannot see through it.
      return emitted[0] as Record<string, unknown>;
    },
  };
}

/** The `err` field of the single emitted line, as a record. */
export function errorField(line: Record<string, unknown>): Record<string, unknown> {
  const err = line['err'];
  if (err === null || typeof err !== 'object') {
    throw new Error(`expected an object at \`err\`, got ${JSON.stringify(err)}`);
  }
  return err as Record<string, unknown>;
}
