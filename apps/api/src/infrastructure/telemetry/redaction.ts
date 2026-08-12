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
function framesOf(error: Error): readonly string[] {
  // PROBED, not read: `stack` is an accessor on a V8 Error and an application
  // can replace it with one that throws — measured escaping `logger.info()` and
  // costing the whole line, which is the failure mode the third redact depth was
  // removed for. A stack that cannot be read yields no frames.
  const stack = probe(error, 'stack');
  if (typeof stack !== 'string') return [];
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
    frames: framesOf(value),
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
  // Both reads are PROBED. `constructor` is inherited and an application can
  // define it as `undefined` — measured, `value.constructor.name` then threw a
  // TypeError out of `logger.info()` and the line was lost. `name` is the
  // documented fallback and `'Error'` is the fallback for a value that answers
  // neither, which is a stricter contract than the one an `Error` guarantees.
  const constructor = probe(value, 'constructor');
  const candidates = [
    typeof constructor === 'function' ? probe(constructor, 'name') : undefined,
    probe(value, 'name'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return 'Error';
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
 * The keys that hold an error, and are therefore reduced whatever sits in them.
 *
 * `err` alone was the first version of this rule, and one key is narrower than
 * the shapes that reach a log line. MEASURED going out verbatim through a merged
 * object, `child()` and `setBindings()` alike:
 *
 * ```
 * { errs:   [{ message: '…PASSWORD…' }] }
 * { errors: [{ message: '…PASSWORD…' }] }
 * { error:  {  message: '…PASSWORD…'  } }
 * { ctx: { cause: { message: '…PASSWORD…' } } }
 * ```
 *
 * `errors` is `AggregateError`'s own property name and `cause` is `Error`'s, so
 * a deserialised error from a worker — the shape this module already names as
 * real — arrives under one of them rather than under `err`. `errs` is the
 * spelling this module's own documentation used for the AggregateError case,
 * which is a fair measure of how reachable it is.
 *
 * **`err` is treated more strictly than the rest, and that is deliberate rather
 * than an oversight.** At `err` a STRING is reduced too, because ADR-0030
 * measured a string there leaking in full and it is pino's designated error
 * slot. At the other five a string is left alone, because they are ordinary
 * English words with ordinary values — `cause: 'user_cancelled'` and
 * `errors: 3` are real fields, and a control that turns a status enum into
 * `{ type: 'string' }` costs debuggability for nothing. Objects and arrays are
 * reduced at all six, because those are the shapes that carry a `message`.
 */
const ERROR_POSITIONS: ReadonlySet<string> = new Set([
  PINO_ERROR_KEY,
  'error',
  'errors',
  'errs',
  'cause',
  'exception',
]);

/**
 * Reduces whatever sits at an error position, mapping ARRAYS element by element
 * so that `errors: [a, b]` keeps its length — "two things failed" is the part of
 * an `AggregateError` worth reading, and collapsing the array to one shape
 * throws it away.
 *
 * A value that cannot carry text — a number, a boolean, `null` — is returned
 * unchanged. There is nothing to censor in `errors: 3`.
 */
function reduceAtErrorPosition(key: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => reduceAtErrorPosition(key, item));
  if (typeof value === 'object' && value !== null) return serialiseError(value);
  if (typeof value === 'string') {
    return key === PINO_ERROR_KEY ? serialiseError(value) : value;
  }
  return value;
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
 *
 * The read is PROBED, because `toJSON` can itself be a throwing accessor —
 * measured escaping `logger.info()` before this guard.
 */
function serialisesItself(node: object): node is SelfSerialising {
  return typeof probe(node, 'toJSON') === 'function';
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
 * `rebuilt` CANNOT bound this, and that is worth stating because it looks as
 * though it should: marking the node before the call only catches a `toJSON`
 * that returns its own receiver, and `toJSON() { return new W() }` returns a
 * FRESH node every time, so the map never hits. MEASURED:
 * `RangeError: Maximum call stack size exceeded`, zero lines emitted, where
 * baseline pino emits `{}`. What bounds it is {@link redactLogObject}'s
 * per-entry boundary, which turns any non-terminating walk into one censored
 * field instead of a lost line.
 */
function redactSelfSerialising(node: SelfSerialising, state: WalkState): unknown {
  state.rebuilt.set(node, REDACTION_CENSOR);
  let json: unknown;
  try {
    json = node.toJSON();
  } catch {
    return REDACTION_CENSOR;
  }
  const redacted = redactValue(json, state);
  state.rebuilt.set(node, redacted);
  return redacted;
}

/**
 * What one walk knows: the node it has finished, and the nodes it is still
 * half-way through.
 *
 * `inProgress` is the whole of the second one, and it exists because a memo that
 * records a VISIT rather than an OUTCOME hands a later reader a half-built
 * object and no way to tell. MEASURED, with the per-entry boundary in place and
 * a node shared between two entries:
 *
 * ```
 * const shared = { first: 'A', boom: <6000 deep>, second: 'B' };
 * logger.info({ outer: { shared }, later: shared }, 'm');
 * → "outer":"[REDACTED]","later":{"first":"A"}
 * ```
 *
 * `second` is gone with no censor beside it and `later` reads as COMPLETE.
 * That is data loss rather than exposure — the partial copy holds redacted
 * values — but it is silent, which is worse than either. It is also this
 * round's version of the defect `apps/web`'s sink was fixed for, arriving from
 * a different direction: the boundary that stopped the walk losing the LINE
 * introduced a way for it to lose a FIELD without saying so.
 *
 * So a node is recorded as in progress on the way down and removed on the way
 * out, and when an entry fails, every node it left half-built is overwritten
 * with the censor. A later alias then reads `[REDACTED]` — the outcome — rather
 * than a plausible fragment.
 */
interface WalkState {
  readonly rebuilt: Map<object, unknown>;
  readonly inProgress: Set<object>;
}

export function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  const state: WalkState = { rebuilt: new Map<object, unknown>(), inProgress: new Set<object>() };
  const copy: Record<string, unknown> = {};
  state.rebuilt.set(object, copy);
  for (const key of Object.keys(object)) {
    copy[key] = redactTopLevelEntry(object, key, state);
  }
  return copy;
}

function redactTopLevelEntry(
  object: Record<string, unknown>,
  key: string,
  state: WalkState,
): unknown {
  if (isRedactedKey(key)) return REDACTION_CENSOR;
  try {
    const value = read(object, key);
    // THE one value pino's own serialiser reaches, whatever its type — measured
    // running for an Error, a plain object and a string, through a merged
    // object, `child` and `setBindings` alike, and asserted in
    // `test/redaction.test.ts` so the pass-through is not resting on an
    // unpinned property of somebody else's package. Left WHOLE rather than
    // reduced here: reducing it twice loses the type the first reduction
    // recorded (`{ err: <string> }` reported `object`), and reducing an Error
    // here loses its frames.
    //
    // Every OTHER error position — and `err` itself below the top level — is
    // reduced by this module, because pino's serialiser reaches exactly one key.
    if (key === PINO_ERROR_KEY) return value;
    if (ERROR_POSITIONS.has(key)) return reduceAtErrorPosition(key, value);
    return redactValue(value, state);
  } catch {
    // RECORD THE OUTCOME. Everything this entry left half-built becomes the
    // censor, so a later entry aliasing the same node reads a refusal rather
    // than a fragment that looks whole.
    for (const abandoned of state.inProgress) state.rebuilt.set(abandoned, REDACTION_CENSOR);
    state.inProgress.clear();
    return REDACTION_CENSOR;
  }
}

/**
 * A property read that cannot escape, for a value that will be WRITTEN DOWN.
 *
 * Fails closed: a value that cannot be inspected cannot be cleared, so it is
 * censored rather than emitted.
 */
function read(node: object, key: string | number): unknown {
  try {
    return (node as Record<string | number, unknown>)[key];
  } catch {
    return REDACTION_CENSOR;
  }
}

/**
 * A property read that cannot escape, for a value this module will DECIDE on
 * rather than emit — `stack`, `constructor`, `name`, `toJSON`.
 *
 * Separate from {@link read} because the fail-closed answer differs: a decision
 * that cannot be made must fall through to its own default (no frames, the
 * class name `Error`, not self-serialising), and returning the censor STRING
 * into a decision would make `typeof x === 'function'` and `typeof x ===
 * 'string'` both answer about the failure rather than about the value.
 */
function probe(node: object, key: string): unknown {
  try {
    return (node as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function redactValue(node: unknown, state: WalkState): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (node instanceof Error) return serialiseError(node);

  // `has`, not `get(…) !== undefined`. A memo holding `undefined` — which
  // `{ toJSON: () => undefined }` produces — read as a MISS, so an aliased node
  // was walked once per alias and its `toJSON` invoked three times for three
  // references. Application code, run more often than the caller wrote it.
  if (state.rebuilt.has(node)) return state.rebuilt.get(node);

  if (serialisesItself(node)) return redactSelfSerialising(node, state);

  state.inProgress.add(node);
  const walked = Array.isArray(node) ? redactArray(node, state) : redactObject(node, state);
  state.inProgress.delete(node);
  return walked;
}

function redactArray(node: readonly unknown[], state: WalkState): unknown[] {
  const copy: unknown[] = [];
  state.rebuilt.set(node, copy);
  for (let index = 0; index < node.length; index += 1) {
    copy.push(redactValue(read(node, index), state));
  }
  return copy;
}

function redactObject(node: object, state: WalkState): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  state.rebuilt.set(node, copy);
  for (const key of Object.keys(node)) {
    if (isRedactedKey(key)) {
      copy[key] = REDACTION_CENSOR;
      continue;
    }
    const value = read(node, key);
    copy[key] = ERROR_POSITIONS.has(key)
      ? reduceAtErrorPosition(key, value)
      : redactValue(value, state);
  }
  return copy;
}
