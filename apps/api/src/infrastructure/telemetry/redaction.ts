import { RedactedFieldName, isRedactedKey } from '@metrika/contracts';

/**
 * Pino's half of the redaction control.
 *
 * **NEITHER THE LIST NOR THE RULE IS HERE.** `RedactedFieldName` and
 * `isRedactedKey` both live in `packages/contracts/src/redaction.ts`, and this
 * module derives from the first and calls the second. That module's header
 * records why: three sinks read one list — Pino here, structlog in
 * `apps/workers`, Sentry's `beforeSend` in `apps/web` — and three
 * hand-maintained copies of a security control is how one of them silently
 * stops matching. It is not hypothetical for the RULE either: it was two
 * hand-written copies, and 27 of 140 probe names were measured disagreeing
 * before `isRedactedKey` took the decision over.
 *
 * What is genuinely this sink's own is TRAVERSAL, and this module is all
 * traversal. `apps/api` needs TWO traversals, because neither reaches what the
 * other does — MEASURED against `pino@10.3.1`:
 *
 * | shape                                     | `redact.paths` | `formatters.log` |
 * | ----------------------------------------- | -------------- | ---------------- |
 * | `logger.info({ signedUrl }, 'm')`         | yes            | yes              |
 * | `logger.child({ signedUrl }).info('m')`   | **yes**        | **never called** |
 * | `err.message` / `err.stack`               | **yes**        | non-enumerable   |
 * | `{ signed_url }`, `{ SIGNED_URL }`        | no             | **yes**          |
 * | `{ presignedUrls }`, `{ signedURLs2 }`    | no             | **yes**          |
 * | four levels down                          | no             | **yes**          |
 *
 * A path is a literal string, so `signedUrl` does not imply `signed_url`, and
 * the 956 spellings `redaction-corpus.json` declares could never be expressed
 * as a derived path list. A `formatters.log` walk cannot see a child binding or
 * a non-enumerable property. So both, and the suite asserts each through the
 * shape only it reaches, so that removing either goes red.
 */
export const REDACTION_CENSOR = '[REDACTED]';

/**
 * A `*` in a Pino path matches exactly ONE level, so a name needs one path per
 * depth it can occur at.
 *
 * **TWO, and a third was here and was removed — the reasoning is kept because
 * the removal reverses a claim this module used to make.** The third form
 * (`*.*.name`) was added on a measurement that `pino-http` puts headers at
 * `req.headers.authorization`, depth 3, and that two forms let an
 * `Authorization: Bearer …` header out verbatim. That measurement is correct
 * **of the paths in isolation**, and the paths are not what ships in isolation:
 * {@link redactLogObject} reaches that key at any depth, in any spelling, for
 * every binding mechanism this logger exposes. So the third form was covering a
 * configuration that does not exist.
 *
 * It was not free either. MEASURED, `pino@10.3.1`, attributed one path at a
 * time against a `Buffer`: one bare path is clean, ONE `*.name` wildcard makes a
 * top-level buffer emit `"[unable to serialize, circular reference is too
 * complex to analyze]"`, and a `*.*.name` makes `@pinojs/redact` throw
 * `TypeError: Method get %TypedArray%.prototype.buffer called on incompatible
 * receiver` with NOTHING emitted — a crash inside the logger, which for
 * availability is worse than the leak it was guarding.
 *
 * {@link redactSelfSerialising} now normalises a buffer to plain data before the
 * redactor ever sees one, so neither cost is reachable through this logger any
 * more, and the third depth could be restored. It is not, for two reasons that
 * survive the fix: it is behaviourally redundant, and its failure mode when some
 * *other* exotic receiver reaches the redactor is "no line at all". A redundant
 * control whose worst case is losing the line is a bad trade.
 *
 * Two lessons are recorded rather than fixed away, because this module made both
 * mistakes itself:
 *
 *   - "All 53 paths load" measured COMPILATION, not TRAVERSAL. A path list that
 *     constructs is not a path list that survives the values it will meet.
 *   - The third depth was justified by measuring the paths ALONE, which is not
 *     the configuration that ships — the identical error ADR-0030 exists to
 *     correct in ADR-0029, made again here, one document later.
 */
const DEPTHS = ['', '*.'] as const;

/**
 * The paths, DERIVED — never authored.
 *
 * A hand-written array goes stale the first time `RedactedFieldName` moves, and
 * nothing detects it: the sink keeps emitting a line that looks exactly like the
 * two sinks that did not drift. Deriving is what makes "add a name to the shared
 * enum" a complete change.
 *
 * `err.message` and `err.stack` are appended rather than derived, and could not
 * be derived: `message` and `stack` are not field names and must never be on
 * the shared list — `*.message` would censor every domain error detail one
 * level deep in every runtime. They are ADR-0029 obligation 7, they are scoped
 * to the one key that holds a serialised Error, and they are what stops an
 * exception's stack — which begins with its message — from reaching the sink.
 * They are also the ONLY entry here with a shape of its own: `message` and
 * `stack` are non-enumerable, so no walk can see them.
 */
export const REDACTION_PATHS: readonly string[] = [
  ...RedactedFieldName.options.flatMap((name) => DEPTHS.map((depth) => `${depth}${name}`)),
  'err.message',
  'err.stack',
];

/**
 * Pino's `errorKey` and `messageKey`, at their defaults.
 *
 * Named here rather than inlined because THREE separate decisions depend on
 * them agreeing with pino's configuration, and pino lets both be renamed:
 * the walk's exemption below, the `msg`-derivation guard in `logger.ts`, and
 * obligation 7's `err.*` paths above. `createLogger` deliberately does not
 * expose either option — renaming one silently detaches all three, which is
 * the coupling ADR-0029's Q5 measured for the paths alone.
 */
export const PINO_ERROR_KEY = 'err';
export const PINO_MESSAGE_KEY = 'msg';

/** The frame lines of a stack — `    at fn (file:line:col)` — and nothing else. */
const STACK_FRAME = /^\s*at /;

/**
 * The frames of a stack, with the message line removed.
 *
 * **This is the decision ADR-0030 handed to this task, and this is the answer.**
 * Obligation 7 censors `err.message` AND `err.stack`, and applied literally that
 * leaves an unhandled 500 emitting `{"type":"Error","message":"[REDACTED]",
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
 * The fixed shape ANY `Error` is reduced to, wherever it is found.
 *
 * This lives beside the key rule rather than beside the pino configuration
 * because it is a redaction decision: it is the allowlist mindset applied to the
 * one object that carries free text by construction. `logger.ts` wires it in two
 * places — as pino's `err` serialiser, and inside {@link redactLogObject} for
 * every Error the serialiser will never see.
 *
 * ADR-0029 obligation 7 asks for a serialiser as well as the paths because a
 * static `err.*` path is coupled to `errorKey` and to nesting depth and a
 * serialiser is coupled to neither. It goes one step further here and drops the
 * Error's OWN properties too: `*.password` reaches `err.password` today and
 * stops the day an error is nested one level deeper, and no path can reach a
 * free-text `err.detail` at all. Four fields go out and nothing else does.
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

interface SelfSerialising {
  toJSON: () => unknown;
}

/**
 * Whether a value serialises itself, in which case rebuilding it from its own
 * enumerable keys would destroy it.
 *
 * `Date` and `Buffer` both carry `toJSON`, and both have NO own enumerable
 * keys, so a walk that rebuilt them from their keys would emit `{}` and
 * silently empty every timestamp in the log.
 */
function serialisesItself(node: object): node is SelfSerialising {
  return typeof (node as { toJSON?: unknown }).toJSON === 'function';
}

/**
 * Such a value is replaced by the RESULT of its own `toJSON`, which is then
 * walked like any other data — rather than passed through untouched.
 *
 * Passing it through was the first version and it cost two things, both
 * measured against `pino@10.3.1`:
 *
 *   - **A `Buffer` reaching `@pinojs/redact` breaks the redactor.** With any
 *     `*.name` wildcard in the paths, a top-level `Buffer` emits
 *     `"[unable to serialize, circular reference is too complex to analyze]"`;
 *     with a `*.*.name` it throws
 *     `TypeError: Method get %TypedArray%.prototype.buffer called on
 *     incompatible receiver` and the line is LOST. Attributed precisely: one
 *     bare path is clean, one wildcard degrades, two wildcards throw. Walking
 *     `toJSON()` first means the redactor only ever sees the plain
 *     `{ type: 'Buffer', data: [...] }` it can handle, and the emitted line is
 *     byte-identical to pino with no redaction at all.
 *   - **It was a named hole**: a class whose `toJSON` returns something
 *     sensitive was not reached. Now the result is walked, so it is.
 *
 * The `toJSON` call is application code, so it is guarded exactly as a property
 * read is; and the node is marked in `rebuilt` BEFORE the call, so a `toJSON`
 * that returns a graph containing its own receiver terminates against the
 * censor rather than recursing.
 */
function redactSelfSerialising(node: SelfSerialising, rebuilt: Map<object, unknown>): unknown {
  rebuilt.set(node, REDACTION_CENSOR);
  let json: unknown;
  try {
    json = node.toJSON();
  } catch {
    return REDACTION_CENSOR;
  }
  const redacted = redactValue(json, rebuilt);
  rebuilt.set(node, redacted);
  return redacted;
}

/**
 * Rebuilds a log object with every sensitive key censored, at any depth and in
 * any spelling.
 *
 * **It REBUILDS rather than censoring in place, and that is measured rather
 * than tidy:** an in-place walk left the CALLER's object as
 * `{ password: '[REDACTED]' }` after `logger.info(payload, 'x')` returned. A
 * logger that edits the data it was handed changes program behaviour, and would
 * do it only on the lines that happened to be emitted at the configured level.
 *
 * **An `Error` is reduced to {@link serialiseError}'s fixed shape, EXCEPT at the
 * top-level `err` key.** Both halves are measured.
 *
 * The exception exists because `formatters.log` runs BEFORE `serializers`, so
 * rebuilding the Error pino is about to serialise hands its `err` serialiser a
 * plain object — `type` disappeared and every stack frame with it. That one
 * Error is left alone for the serialiser, which applies the same shape.
 *
 * Everywhere ELSE, an Error is reduced here, and passing it through was a leak:
 * pino's `err` serialiser reaches exactly one key, so an Error anywhere else is
 * `JSON.stringify`d with its own enumerable properties intact. MEASURED, all
 * three going out verbatim — `{ myError: <Error with signed_url> }`,
 * `{ a: { b: { err: <Error with password> } } }` (canonical spelling, depth 4)
 * and `{ errs: [<Error with signed_url>] }`, which is the AggregateError shape.
 * The comment that used to sit here claimed the paths covered them "to depth
 * three"; that was true only of the canonical spelling and only at two of the
 * three depths, which is the difference between a control and a coincidence.
 *
 * **Reads are guarded, because a property read is arbitrary application code.**
 * `Object.entries` invokes getters, and a throwing getter propagated straight
 * out of `logger.info()` — baseline pino survives one. A read that throws yields
 * the censor: fail CLOSED, since a value that cannot be inspected cannot be
 * cleared.
 *
 * **Cycles are rebuilt as cycles**, via the `rebuilt` map: a node reached twice
 * yields the SAME rebuilt object both times, so pino's own safe stringifier
 * marks it `[Circular]` exactly as it would have. Returning the original on the
 * second visit would have been the obvious shape and leaks — the parent would
 * then point at an uncensored graph. There is deliberately no depth cap: a
 * finite object is finite, and the map is what bounds the infinite one.
 */
export function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  const rebuilt = new Map<object, unknown>();
  const copy: Record<string, unknown> = {};
  rebuilt.set(object, copy);
  for (const key of Object.keys(object)) {
    if (isRedactedKey(key)) {
      copy[key] = REDACTION_CENSOR;
      continue;
    }
    const value = read(object, key);
    // THE one Error pino's own serialiser will reach. Everything else — including
    // an Error at `err` nested deeper, which the serialiser never sees — goes
    // through `redactValue` and is reduced there.
    copy[key] =
      key === PINO_ERROR_KEY && value instanceof Error ? value : redactValue(value, rebuilt);
  }
  return copy;
}

/** A property read that cannot escape. See the fail-closed note above. */
function read(node: object, key: string | number): unknown {
  try {
    return (node as Record<string | number, unknown>)[key];
  } catch {
    return REDACTION_CENSOR;
  }
}

function redactValue(node: unknown, rebuilt: Map<object, unknown>): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (node instanceof Error) return serialiseError(node);

  const already = rebuilt.get(node);
  if (already !== undefined) return already;

  if (serialisesItself(node)) return redactSelfSerialising(node, rebuilt);

  if (Array.isArray(node)) {
    const copy: unknown[] = [];
    rebuilt.set(node, copy);
    for (let index = 0; index < node.length; index += 1) {
      copy.push(redactValue(read(node, index), rebuilt));
    }
    return copy;
  }

  const copy: Record<string, unknown> = {};
  rebuilt.set(node, copy);
  for (const key of Object.keys(node)) {
    copy[key] = isRedactedKey(key) ? REDACTION_CENSOR : redactValue(read(node, key), rebuilt);
  }
  return copy;
}
