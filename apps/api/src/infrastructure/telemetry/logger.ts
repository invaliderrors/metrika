import { pino, stdTimeFunctions, type DestinationStream, type Logger, type LogFn } from 'pino';
import type { Env } from '../../config/env.js';
import { REDACTION_CENSOR, REDACTION_PATHS, redactLogObject } from './redaction.js';

/**
 * The application's log sink.
 *
 * `docs/OBSERVABILITY.md` §3 specifies structured JSON with a label level and
 * an ISO timestamp; ADR-0029 pins `pino@10.3.1` and obligation 7 requires the
 * redaction paths AND a custom `err` serialiser; ADR-0030 decides the call
 * shape at the one call site that exists. This module is those three documents
 * wired together, and every choice below is annotated with the measurement
 * behind it, because the same behaviour was stated wrongly three times before
 * it was measured at the shape the code actually has.
 *
 * NOT wired as Nest's `LoggerService` here. ADR-0030 row G measured a
 * hand-written raw-pino adapter silently DISCARDING the second argument of
 * `Logger.error(message, cause)`, which is the diagnostic Plan 0B-1 added the
 * filter's log line for. The `{ err }` shape this module is built around works
 * under `nestjs-pino` and under raw pino alike (rows H and I), which turns the
 * adapter from a prerequisite decision into a reversible one — so the filter
 * takes this logger directly and Nest's own boot output is left alone until a
 * task owns that choice.
 */

/** The frame lines of a stack — `    at fn (file:line:col)` — and nothing else. */
const STACK_FRAME = /^\s*at /;

/**
 * The frames of a stack, with the message line removed.
 *
 * **This is the decision ADR-0030 handed to this task, and this is the answer.**
 * Obligation 7 censors `err.message` AND `err.stack`, and applied literally
 * that leaves an unhandled 500 emitting `{"type":"Error","message":"[REDACTED]",
 * "stack":"[REDACTED]"}` — an Error happened, nothing else survives. Plan 0B-1
 * added that log line because an unexpected 500 otherwise produced literally
 * ZERO bytes of diagnostic, and "an Error happened" is barely more.
 *
 * A stack is `<message>\n    at <frame>\n    at <frame>…`. The SECRET is in the
 * message; the frames are file paths and function names. So the frames are kept
 * under a name of their own and the two fields obligation 7 names stay censored
 * — measured against the real `DomainExceptionFilter` in
 * `test/error-filter.test.ts`: 0 frames under obligation 7 as written, the real
 * throw site with this.
 *
 * FILTERED, not `split('\n').slice(1)`. An exception message may itself contain
 * newlines, and dropping only the first line puts the rest of it in the log —
 * `test/logger.test.ts` asserts a two-line message carrying a DSN.
 *
 * The residual risk, named rather than left to be discovered: a frame from
 * `eval`'d or `data:`-URL code carries source text in the frame itself. Nothing
 * in this application evaluates strings.
 */
function framesOf(stack: string | undefined): readonly string[] {
  if (stack === undefined) return [];
  return stack
    .split('\n')
    .filter((line) => STACK_FRAME.test(line))
    .map((line) => line.trim());
}

/**
 * Pino's `err` serialiser: a FIXED shape, which is the allowlist mindset
 * applied to the one object that carries free text by construction.
 *
 * ADR-0029 obligation 7 asks for this as well as the paths because a static
 * `err.*` path is coupled to `errorKey` and to nesting depth and a serialiser
 * is coupled to neither. It goes one step further here and drops the Error's
 * OWN properties too: `*.password` reaches `err.password` today and stops the
 * day an error is nested one level deeper, and no path can reach a free-text
 * `err.detail` at all. Four fields go out and nothing else does.
 *
 * `message` and `stack` are emitted as the censor rather than omitted, so an
 * operator reading the line can tell the control FIRED rather than that the
 * fields were absent. `REDACTION_PATHS` censors them a second time, from the
 * other direction; that redundancy is obligation 7's point.
 *
 * A non-`Error` value is described, never stringified — ADR-0030 measured
 * `{ err: <string> }` going out in full with redaction on, because
 * `err.message` and `err.stack` match nothing on a scalar. The call site is
 * supposed to coerce (see {@link toLoggableError}); this is what happens when
 * some future call site forgets.
 */
export function serialiseError(value: unknown): Record<string, unknown> {
  if (!(value instanceof Error)) {
    return { type: typeof value, message: REDACTION_CENSOR, stack: REDACTION_CENSOR, frames: [] };
  }
  return {
    type: classNameOf(value),
    message: REDACTION_CENSOR,
    stack: REDACTION_CENSOR,
    frames: framesOf(value.stack),
  };
}

/**
 * The same rule `pino-std-serializers` uses for `err.type`, so an operator
 * reads the field they already know.
 *
 * `err.name` alone reports `Error` for `class QuoteEngineError extends Error {}`
 * unless the subclass assigns `this.name` — and with the message censored, the
 * class is the only thing left saying WHAT failed, so getting it wrong costs
 * the whole line. The fallback is for a genuinely anonymous subclass, whose
 * constructor name is the empty string.
 */
function classNameOf(value: Error): string {
  const constructed = value.constructor.name;
  return constructed === '' ? value.name : constructed;
}

/**
 * What goes in `err`, and it is always an `Error` INSTANCE.
 *
 * ADR-0030's measured table: `{ err: <Error instance> }` is redacted under
 * `nestjs-pino` and under raw pino alike, and `{ err: <string> }` LEAKS under
 * both. `describeCause` — the function this replaces — returned a string, so
 * passing its output would have been the leaking row.
 *
 * The coercion keeps the property that function existed for: a thrown
 * non-`Error` is arbitrary data (a plain object carrying a password is a shape
 * this has been probed with), so it is DESCRIBED by type and never
 * stringified.
 *
 * **The synthesised Error's stack is set to its own message**, which leaves it
 * with no frames. ADR-0030 measured 10 frames for this case and every one of
 * them pointed at the logger rather than at anything that went wrong: the
 * throw site is not in the stack, because the thrown thing never had one.
 * Frames that describe the logger are worse than no frames.
 */
export function toLoggableError(exception: unknown): Error {
  if (exception instanceof Error) return exception;
  const described = new Error(`non-Error thrown (typeof ${typeof exception})`);
  described.stack = described.message;
  return described;
}

/**
 * Rewraps `logger.error(err)` — an Error as the ONLY argument — as
 * `logger.error({ err }, <fixed message>)`.
 *
 * MEASURED, and it is the one leak the rest of this module does not close:
 * pino takes `msg` from `err.message` when an Error arrives alone, so
 * `logger.error(new Error(dsn))` emits a perfectly censored `err` object beside
 * `"msg":"DB_DSN=postgres://user:PASSWORD@host/db"`. It is the shape a reader
 * reaches for first, at every level, and `redact` cannot help: it is
 * field-granular, so `paths:['msg']` censors every log message in the process.
 *
 * A caller who supplies their own message is left alone — pino uses that
 * message and routes the Error through the serialiser, which is already safe.
 *
 * What is still NOT closed, stated so nobody reads this as more than it is:
 * free text a caller interpolates into `msg` themselves. Removing a substring
 * of free text needs a secret DETECTOR, which is a weaker control than the
 * allowlist `docs/OBSERVABILITY.md` §3 chose and fails silently on the first
 * secret whose shape it does not match. The rule stands: do not put untrusted
 * text in `msg`, put the cause in `err`.
 */
function rewrapBareError(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
  const [first, second] = args;
  if (first instanceof Error && second === undefined) {
    method.call(this, { err: first }, 'an Error was logged with no message of its own');
    return;
  }
  method.apply(this, args);
}

/**
 * `Pick<Env, 'LOG_LEVEL'>` rather than `Env`, so the signature states what this
 * reads. `EnvService.values` satisfies it, and a test does not have to invent a
 * DATABASE_URL to build a logger.
 *
 * `destination` exists so the suite can grade the REAL logger rather than a
 * pino instance rebuilt with the same options — a fixture that reconstructs a
 * control grades a copy, and the copy cannot drift the way the original can.
 * Defaults to pino's own, which is stdout.
 */
export function createLogger(env: Pick<Env, 'LOG_LEVEL'>, destination?: DestinationStream): Logger {
  const options = {
    level: env.LOG_LEVEL,
    // `docs/OBSERVABILITY.md` §3's example line: a level LABEL and an ISO
    // timestamp, not pino's numeric level and epoch milliseconds.
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string): Record<string, unknown> => ({ level: label }),
      log: redactLogObject,
    },
    serializers: { err: serialiseError },
    redact: { paths: [...REDACTION_PATHS], censor: REDACTION_CENSOR },
    hooks: { logMethod: rewrapBareError },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
