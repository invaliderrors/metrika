import { describe, expect, it } from 'vitest';
import { REDACTION_CENSOR } from '../src/infrastructure/telemetry/redaction.js';
import { toLoggableError } from '../src/infrastructure/telemetry/redaction.js';
import { captureLogger, errorField } from './log-capture.js';

/**
 * The secret this whole task exists for. `apps/api` has been writing an
 * unhandled exception's stack — which BEGINS with its message — to stdout since
 * Plan 0B-1, and a `DATABASE_URL` in a thrown message is the shape that
 * carries. Plan 0B-1's own comment on that call says so and says not to inherit
 * it silently.
 */
const DSN = 'DB_DSN=postgres://user:PASSWORD@host/db';

/**
 * Three frames deep, so "the frames survived" is a claim with a witness.
 *
 * `: void` rather than `: never` on the two inner functions, deliberately: with
 * `never` the shared profile's `allowUnreachableCode: false` rejects the guard
 * below as dead code, and the guard is what stops a silent change in this
 * helper from making every frame assertion vacuous.
 */
function throwFromThreeFramesDown(message: string): Error {
  function inner(): void {
    throw new Error(message);
  }
  function middle(): void {
    inner();
  }
  try {
    middle();
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error('middle() did not throw, so the frame assertions below prove nothing');
}

describe('the carry-forward this task closes', () => {
  it('writes no part of a DSN carried in an exception message', () => {
    const captured = captureLogger();

    captured.logger.error(
      { err: throwFromThreeFramesDown(DSN) },
      'Unhandled exception (requestId=req-1)',
    );

    // The strong form: not "this field is censored" but "this string is nowhere
    // in the emitted bytes". A per-field assertion passes while the same secret
    // sits in a sibling key nobody thought of.
    expect(captured.raw()).not.toContain('PASSWORD');
    expect(captured.raw()).not.toContain('postgres://');
  });

  it('censors err.message, err.stack and msg by name as well', () => {
    const captured = captureLogger();

    captured.logger.error({ err: new Error(DSN) }, 'Unhandled exception (requestId=req-1)');
    const line = captured.only();

    expect(errorField(line)['message']).toBe(REDACTION_CENSOR);
    expect(errorField(line)['stack']).toBe(REDACTION_CENSOR);
    expect(line['msg']).toBe('Unhandled exception (requestId=req-1)');
  });

  /**
   * ADR-0030's measured trap, asserted so it cannot come back: `describeCause`
   * returned a STRING, and `{ err: <string> }` serialises as a scalar — so
   * `err.message` and `err.stack` match nothing and the secret goes out in
   * full, with redaction on and every gate green.
   */
  it('does not leak when something puts a string in err', () => {
    const captured = captureLogger();

    captured.logger.error(
      { err: `Error: ${DSN}\n    at inner (/app/x.js:1:1)` },
      'a string in err',
    );

    expect(captured.raw()).not.toContain('PASSWORD');
    expect(errorField(captured.only())['type']).toBe('string');
  });

  /**
   * THE CALL-SHAPE DIMENSION, enumerated from `pino/lib/proto.js`'s `write()`
   * rather than from shapes anyone thought of.
   *
   * pino derives `msg` from the error in two branches — an Error as the whole
   * merged object, and an Error (or anything truthy) at `errorKey` inside it
   * with no `messageKey` present — and the first version of this suite covered
   * one of them. **The uncovered branch is the shape ADR-0030 PRESCRIBES**,
   * `logger.error({ err })`, with the message argument left off: it emitted a
   * perfectly censored `err` object beside a `msg` carrying the full DSN.
   *
   * The dimension is (what carries the error) × (is a message supplied), and
   * every cell of it is below. `[undefined]` is spread as an explicit argument
   * because `f(x)` and `f(x, undefined)` reach different `arguments.length`,
   * and only one of them was covered.
   */
  const ERROR_CARRIERS: Readonly<Record<string, unknown>> = {
    'the whole merged object': new Error(DSN),
    'the err key': { err: new Error(DSN) },
    'the err key beside other fields': { err: new Error(DSN), requestId: 'req-1' },
    'the err key holding a non-Error with a message': { err: { message: DSN } },
  };

  describe.each(['error', 'warn', 'fatal'] as const)('at %s level', (level) => {
    it.each(Object.keys(ERROR_CARRIERS))('does not leak through msg, carried by %s', (carrier) => {
      const captured = captureLogger();

      captured.logger[level](ERROR_CARRIERS[carrier] as Error);

      expect(captured.raw()).not.toContain('PASSWORD');
      expect(captured.only()['msg']).not.toContain('postgres');
    });

    it.each(Object.keys(ERROR_CARRIERS))(
      'does not leak with an explicit undefined message, carried by %s',
      (carrier) => {
        const captured = captureLogger();

        captured.logger[level](ERROR_CARRIERS[carrier] as Error, undefined);

        expect(captured.raw()).not.toContain('PASSWORD');
      },
    );
  });

  it('does not leak when the filter’s own contexted child logs it', () => {
    const captured = captureLogger();

    captured.logger.child({ context: 'DomainExceptionFilter' }).error({ err: new Error(DSN) });

    expect(captured.raw()).not.toContain('PASSWORD');
  });

  it.each(Object.keys(ERROR_CARRIERS))(
    'still lets a caller supply their own message, carried by %s',
    (carrier) => {
      const captured = captureLogger();

      captured.logger.error(ERROR_CARRIERS[carrier] as Error, 'slicing failed');

      expect(captured.only()['msg']).toBe('slicing failed');
      expect(captured.raw()).not.toContain('PASSWORD');
    },
  );

  it('leaves a caller-supplied msg FIELD alone, which is the declared gap', () => {
    // `msg` is free text by construction and there are three routes into it —
    // the second argument, an interpolation, and this: a `msg` key in the merged
    // object, which pino uses verbatim. None is closable by an allowlist;
    // closing them needs a secret detector, which is the weaker control
    // docs/OBSERVABILITY.md §3 rejected. Asserted so the gap is DECLARED rather
    // than discovered — if this ever goes red, the rule changed.
    const captured = captureLogger();

    captured.logger.info({ msg: DSN });

    expect(captured.only()['msg']).toBe(DSN);
  });
});

/**
 * The other half, and the half a redaction test passes trivially without: a
 * line that lost the cause is perfectly redacted. ADR-0030 measured two of nine
 * configurations silently DISCARDING it, so the arrival is asserted, not
 * assumed.
 */
describe('what an operator is left with once the control fires', () => {
  it('keeps the real stack frames, which is the whole diagnostic', () => {
    const captured = captureLogger();

    captured.logger.error({ err: throwFromThreeFramesDown(DSN) }, 'Unhandled exception');
    const frames = errorField(captured.only())['frames'];

    expect(Array.isArray(frames)).toBe(true);
    const lines = frames as string[];
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((frame) => frame.startsWith('at '))).toBe(true);
    expect(lines[0]).toContain('inner');
    expect(lines[1]).toContain('middle');
    expect(lines.join('\n')).toContain('logger.test');
  });

  it('names the error class, which the censored message no longer can', () => {
    // A subclass that does NOT assign `this.name`, which is the common shape:
    // `err.name` reports `Error` for it, and with the message censored the
    // class is the only thing left saying what failed.
    class QuoteEngineError extends Error {}
    const captured = captureLogger();

    captured.logger.error({ err: new QuoteEngineError(DSN) }, 'Unhandled exception');

    expect(errorField(captured.only())['type']).toBe('QuoteEngineError');
  });

  it('falls back to err.name for a genuinely anonymous subclass', () => {
    const captured = captureLogger();
    const anonymous = new (class extends Error {})('boom');
    anonymous.name = 'AnonymousDomainFailure';

    captured.logger.error({ err: anonymous }, 'Unhandled exception');

    expect(errorField(captured.only())['type']).toBe('AnonymousDomainFailure');
  });

  it('drops the error’s own properties rather than hoping a path reaches them', () => {
    // A path reaches `err.password` today and stops the day the error is nested
    // one level deeper. The serialiser emits a fixed shape instead, so an
    // arbitrary property somebody attached to an Error has no route out at all —
    // including a free-text one no allowlist could match.
    const captured = captureLogger();
    const error = Object.assign(new Error('boom'), {
      detail: `connection to ${DSN} refused`,
      code: 'ECONNREFUSED',
    });

    captured.logger.error({ err: error }, 'Unhandled exception');

    expect(captured.raw()).not.toContain('PASSWORD');
    expect(Object.keys(errorField(captured.only())).sort()).toStrictEqual([
      'frames',
      'message',
      'stack',
      'type',
    ]);
  });
});

describe('toLoggableError', () => {
  it('returns the very same Error, so nothing about a real throw is reconstructed', () => {
    const thrown = new Error('boom');

    expect(toLoggableError(thrown)).toBe(thrown);
  });

  it('describes a thrown non-Error instead of stringifying it', () => {
    // A thrown plain object is arbitrary data — a payload carrying a password is
    // a real shape this has been probed with — so it is DESCRIBED. The coercion
    // is what keeps `{ err }` holding an Error instance, which is the only shape
    // ADR-0030 measured clean under both candidate adapters.
    const described = toLoggableError({ password: 'hunter2' });

    expect(described).toBeInstanceOf(Error);
    expect(described.message).toBe('non-Error thrown (typeof object)');
    expect(JSON.stringify(described.message)).not.toContain('hunter2');
  });

  it('emits no frames for a thrown non-Error, because the only stack is ours', () => {
    // ADR-0030 measured 10 synthetic frames here — every one of them pointing
    // at the serialiser rather than at anything that went wrong. Frames that
    // describe the logger are worse than no frames.
    const captured = captureLogger();

    captured.logger.error({ err: toLoggableError('a bare string') }, 'Unhandled exception');

    expect(errorField(captured.only())['frames']).toStrictEqual([]);
  });

  it('emits no frames for an Error that has no stack', () => {
    // `Reflect.deleteProperty` rather than `= undefined`: `stack` is declared
    // `string | undefined` but the shared profile sets
    // `exactOptionalPropertyTypes`, so the assignment is a type error while the
    // state it describes is perfectly reachable at runtime — ADR-0030 names it
    // as one of the two cases where the old call shape lost the cause.
    const captured = captureLogger();
    const stackless = new Error('boom');
    Reflect.deleteProperty(stackless, 'stack');

    captured.logger.error({ err: stackless }, 'Unhandled exception');

    expect(errorField(captured.only())['frames']).toStrictEqual([]);
  });

  it('keeps no part of a multi-line message, which the frame filter is what handles', () => {
    // A stack is `<message>\n    at …`, and a message may itself contain
    // newlines — so "drop the first line" leaks the rest of it. The filter keeps
    // only lines that ARE frames.
    const captured = captureLogger();

    captured.logger.error({ err: new Error(`line one\nline two ${DSN}`) }, 'Unhandled exception');

    expect(captured.raw()).not.toContain('PASSWORD');
  });
});

describe('createLogger', () => {
  it('emits the shape docs/OBSERVABILITY.md §3 documents', () => {
    const captured = captureLogger();

    captured.logger.info({ requestId: 'req_01H' }, 'geometry analysis completed');
    const line = captured.only();

    expect(line['level']).toBe('info');
    expect(line['msg']).toBe('geometry analysis completed');
    expect(line['requestId']).toBe('req_01H');
    expect(typeof line['time']).toBe('string');
    expect(new Date(line['time'] as string).toISOString()).toBe(line['time']);
  });

  it('honours LOG_LEVEL', () => {
    const captured = captureLogger({ LOG_LEVEL: 'warn' });

    captured.logger.info('not emitted');
    captured.logger.warn('emitted');

    expect(captured.only()['msg']).toBe('emitted');
  });
});

/**
 * The three `child()` options that switch the control off, REJECTED rather than
 * documented.
 *
 * Measured before the guard: `{ formatters: { log } }` replaces the walk and a
 * `signed_url` went out verbatim on that child; `{ redact }` replaces the paths
 * that are all that still reaches `err.message` and `err.stack`; and
 * `{ serializers: { err } }` replaces the one serialiser obligation 7 requires.
 *
 * A control any caller can switch off with an options bag is not a control, and
 * CLAUDE.md asks for a fixture asserting rejection rather than a comment asking
 * for restraint. `child()` is wiring-time, so the throw is a boot failure with a
 * name on it.
 */
describe('child() options that would disable the control', () => {
  it.each(['redact', 'serializers', 'formatters'])('rejects %s', (option) => {
    const captured = captureLogger();

    expect(() => captured.logger.child({}, { [option]: {} })).toThrow(
      new RegExp(`may not override ${option}`),
    );
  });

  it('names every offending option at once, not just the first', () => {
    const captured = captureLogger();

    expect(() => captured.logger.child({}, { redact: { paths: [] }, formatters: {} })).toThrow(
      /redact, formatters/,
    );
  });

  it('leaves the options that do not disable anything alone', () => {
    const captured = captureLogger();

    const child = captured.logger.child({ requestId: 'req_1' }, { level: 'warn' });
    child.warn('emitted');

    expect(captured.only()['requestId']).toBe('req_1');
    expect(captured.only()['level']).toBe('warn');
  });

  it('accepts a child with no options at all, which is every call site today', () => {
    const captured = captureLogger();

    captured.logger.child({ context: 'DomainExceptionFilter' }).info('a line');

    expect(captured.only()['context']).toBe('DomainExceptionFilter');
  });
});

describe('the child-options guard, against a caller who is trying', () => {
  /**
   * `Object.hasOwn` was the wrong test: pino reads `options.redact` as a plain
   * property, so an option hidden on a prototype reached it while the guard said
   * it was absent — MEASURED, pino installed the replacement redactor. No leak
   * followed, because the walk and `serialiseError` cover everything those paths
   * do; a guard that can be stepped around is still not a guard.
   */
  it.each(['redact', 'serializers', 'formatters'])('rejects an inherited %s too', (option) => {
    const captured = captureLogger();
    const hidden: object = Object.create({ [option]: { paths: ['zzz'] } }) as object;

    expect(() => captured.logger.child({}, hidden)).toThrow(
      new RegExp(`may not override ${option}`),
    );
  });

  it('still accepts an inherited option that disables nothing', () => {
    const captured = captureLogger();
    const inherited: object = Object.create({ level: 'warn' }) as object;

    expect(() => captured.logger.child({ requestId: 'req_1' }, inherited)).not.toThrow();
  });
});
