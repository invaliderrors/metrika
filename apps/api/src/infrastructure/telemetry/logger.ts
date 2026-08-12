import {
  pino,
  stdTimeFunctions,
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type Logger,
  type LogFn,
} from 'pino';
import type { Env } from '../../config/env.js';
import {
  PINO_ERROR_KEY,
  PINO_MESSAGE_KEY,
  REDACTION_CENSOR,
  REDACTION_PATHS,
  redactLogObject,
  serialiseError,
} from './redaction.js';

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

/** What `msg` says when pino would otherwise have taken it from the error. */
const NO_MESSAGE_OF_ITS_OWN = 'an error was logged with no message of its own';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Stops pino deriving `msg` from the error, in EVERY shape where it would.
 *
 * The rule is not guessed and it is not a list of shapes somebody thought of —
 * it is `pino/lib/proto.js`'s own `write()`, transcribed:
 *
 * ```js
 * } else if (_obj instanceof Error) {
 *   obj = { [errorKey]: _obj }
 *   if (msg === undefined) msg = _obj.message
 * } else {
 *   obj = _obj
 *   if (msg === undefined && _obj[messageKey] === undefined && _obj[errorKey]) {
 *     msg = _obj[errorKey].message
 *   }
 * }
 * ```
 *
 * The two branches are the two cells, and the first version of this hook
 * implemented only the first. **The second is the shape ADR-0030 PRESCRIBES —
 * `logger.error({ err })` — with the message argument left off**, and it leaked
 * the full DSN into `msg` while `err` beside it was perfectly censored.
 * MEASURED at `error`, `warn` and `fatal`, with `{ err, requestId }`, with an
 * explicit `undefined` message, through the exception filter's own contexted
 * child, and with a non-Error `{ err: { message } }` — which the `instanceof`
 * guard could never have caught, because pino only requires `_obj[errorKey]` to
 * be truthy and reads `.message` off whatever is there.
 *
 * That was the SUM again: the suite covered `error(err)` bare and
 * `error({ err }, msg)`, and the leak is the cell where those two dimensions —
 * "the error is inside the merged object" and "no message argument" — meet.
 *
 * Mirroring pino's condition rather than approximating it is deliberate: the
 * one thing this hook must never do is disagree with the code it is guarding.
 * `PINO_ERROR_KEY` and `PINO_MESSAGE_KEY` are named constants for the same
 * reason, and `createLogger` does not expose either pino option.
 *
 * A caller who supplies their own message is left alone — pino uses it and
 * routes the error through the serialiser, which is already safe.
 *
 * **What is still NOT closed**, stated so nobody reads this as more than it is:
 * the message field is free text by construction, and there are three routes
 * into it — the second argument, an interpolation
 * (`` logger.info(`… ${dsn}`) ``), and a `msg` key in the merged object, which
 * pino uses verbatim. All three leak, and none is closable by an allowlist:
 * removing a substring of free text needs a secret DETECTOR, a weaker control
 * than the one `docs/OBSERVABILITY.md` §3 chose, failing silently on the first
 * secret whose shape it does not match. The rule stands, and it is about the
 * FIELD rather than about one argument: nothing untrusted goes in `msg` — put
 * the cause in `err`.
 */
function rewrapBareError(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
  const [first, second] = args;
  if (second !== undefined) {
    method.apply(this, args);
    return;
  }
  if (first instanceof Error) {
    method.call(this, { [PINO_ERROR_KEY]: first }, NO_MESSAGE_OF_ITS_OWN);
    return;
  }
  // `Boolean(...)`, not `instanceof Error`: pino's own guard is truthiness, and
  // it then reads `.message` off whatever is there. `{ err: { message: dsn } }`
  // is a real shape — it is what a deserialised error from a worker looks like.
  if (isRecord(first) && first[PINO_MESSAGE_KEY] === undefined && Boolean(first[PINO_ERROR_KEY])) {
    method.call(this, first, NO_MESSAGE_OF_ITS_OWN);
    return;
  }
  method.apply(this, args);
}

/**
 * Puts BINDINGS through the same walk a merged log object gets — through BOTH
 * of the two methods that create them.
 *
 * **`formatters.log` is never called for a binding**, and `REDACTION_PATHS`
 * matches literal names, so a binding in a non-canonical spelling is reached by
 * neither mechanism. MEASURED going out verbatim through the real
 * `createLogger`, twice, in the same defect class both times:
 *
 *   - `logger.child({ signed_url })` — found by grading the corpus through the
 *     product of (binding mechanism × spelling) instead of their sum. The
 *     fixtures covered child bindings in the canonical spelling and
 *     non-canonical spellings in a merged object; neither could see their
 *     combination.
 *   - `logger.setBindings({ signed_url })` — the SAME product with a third
 *     value in the first dimension, missed because the fix enumerated the
 *     mechanism it had just been shown rather than enumerating the dimension.
 *     `child` and `setBindings` are the complete set: `base` is set by
 *     `createLogger` itself, and a `mixin`'s output is merged before
 *     `formatters.log` runs, so it is already walked.
 *
 * Both are own properties shadowing pino's prototype methods, and both
 * **delegate on `this` rather than on a bound parent** — which was the second
 * bug in this function. pino builds a child with `Object.create(this)`, so a
 * child INHERITS these own properties; a wrapper closing over
 * `logger.child.bind(logger)` therefore sent `logger.child(a).child(b)` back to
 * the ROOT, and MEASURED, the grandchild silently lost `a` — a correlation
 * field vanishing from every line under it. Delegating on `this` fixes it and
 * makes recursion unnecessary: the inherited wrapper already applies at every
 * depth. `test/redaction.test.ts` asserts the chain keeps its parent's
 * bindings, which is the assertion whose absence let it through.
 *
 * Nothing inside pino calls either method, so the only caller is application
 * code.
 */
/**
 * The three `child()` options that switch the control off for that child, and
 * every logger descended from it.
 *
 * MEASURED, each disabling a different half: `{ formatters: { log } }` replaces
 * the walk and a `signed_url` went out verbatim; `{ redact }` replaces the
 * paths, which is what still reaches `err.message` and `err.stack`; and
 * `{ serializers: { err } }` replaces the one serialiser obligation 7 requires.
 *
 * REJECTED rather than documented, and loudly. `child()` is called at wiring
 * time rather than per request, so a throw here is a boot failure with a name
 * on it — the same trade `parseEnv` makes, and the reason CLAUDE.md asks for a
 * fixture asserting rejection rather than a comment asking for restraint. A
 * control any caller can switch off with an options bag is not a control.
 *
 * Silently dropping the override was the alternative and is worse: the caller
 * would get a logger that ignores what they asked for, with nothing to read.
 * A child that genuinely needs another serialiser adds it to `createLogger`,
 * where it is subject to the same review as the rest of the sink.
 */
const CONTROL_DISABLING_CHILD_OPTIONS = ['redact', 'serializers', 'formatters'] as const;

function rejectControlDisablingOptions(options: object | undefined): void {
  if (options === undefined) return;
  // `in`, not `Object.hasOwn`. pino reads `options.redact` as a plain property,
  // so `child({}, Object.create({ redact }))` reached it while `hasOwn` said the
  // option was absent — MEASURED, pino installed the replacement redactor. (No
  // leak followed, because the walk and `serialiseError` cover everything those
  // paths do; the guard is still the thing that must not be bypassable.) This is
  // stricter than pino for `serializers` and `formatters`, which it reads with
  // `hasOwnProperty` — rejecting an inherited one costs nothing, since no caller
  // has a reason to hide a logger option on a prototype.
  const disabled = CONTROL_DISABLING_CHILD_OPTIONS.filter((option) => option in options);
  if (disabled.length > 0) {
    throw new Error(
      `logger.child() may not override ${disabled.join(', ')}: each one switches off part of the ` +
        'redaction control for that child and everything descended from it. Configure the sink in ' +
        'createLogger instead — see apps/api/src/infrastructure/telemetry/logger.ts.',
    );
  }
}

function redactBindings(logger: Logger): Logger {
  /* eslint-disable @typescript-eslint/unbound-method -- reading these UNBOUND is the point, and binding them is the measured bug this function's doc records: each is re-invoked below with `.call(this, …)` so that a descendant delegates to ITSELF rather than to the root, which is what stops a chain losing its parent's bindings. */
  const inheritedChild = logger.child;
  const inheritedSetBindings = logger.setBindings;
  /* eslint-enable @typescript-eslint/unbound-method -- restored immediately; the two reads above are the only ones intended. */

  // Generic in the same parameter pino's own `child` is, so the assignment is
  // type-safe for a caller that declares custom levels. The cast is on the
  // RETURN only: `.call` erases the instantiation, and nothing in this
  // application declares a custom pino level, so the value is `never` at every
  // call site this repository contains.
  function child<ChildCustomLevels extends string = never>(
    this: Logger,
    bindings: Bindings,
    options?: ChildLoggerOptions<ChildCustomLevels>,
  ): Logger<ChildCustomLevels> {
    rejectControlDisablingOptions(options);
    const created: unknown = inheritedChild.call(this, redactLogObject(bindings), options);
    return created as Logger<ChildCustomLevels>;
  }

  function setBindings(this: Logger, bindings: Bindings): void {
    inheritedSetBindings.call(this, redactLogObject(bindings));
  }

  logger.child = child;
  logger.setBindings = setBindings;
  return logger;
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
  return redactBindings(destination === undefined ? pino(options) : pino(options, destination));
}
