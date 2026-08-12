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
 * Three, and the third is not padding: `pino-http`'s default request serialiser
 * puts headers at `req.headers.authorization`, which is depth 3, and it is the
 * single most important key on the whole list. MEASURED with only the first two
 * forms — an `Authorization: Bearer …` header went out verbatim on every
 * request line. The superseded blueprint block in `docs/OBSERVABILITY.md` §3
 * named `req.headers.authorization` explicitly for exactly this reason, so
 * stopping at two forms would have been a regression against the list it
 * replaces.
 *
 * Deeper than three is left to {@link redactLogObject}, which has no depth
 * limit. That split is stated rather than discovered: `fast-redact` compiles a
 * function per path, and a fourth form would be another seventeen of them for a
 * shape the walk already covers.
 */
const DEPTHS = ['', '*.', '*.*.'] as const;

/**
 * The paths, DERIVED — never authored.
 *
 * A hand-written array of thirty-four entries goes stale the first time
 * `RedactedFieldName` moves, and nothing detects it: the sink keeps emitting a
 * line that looks exactly like the two sinks that did not drift. Deriving is
 * what makes "add a name to the shared enum" a complete change.
 *
 * `err.message` and `err.stack` are appended rather than derived, and could not
 * be derived: `message` and `stack` are not field names and must never be on
 * the shared list — `*.message` would censor every domain error detail one
 * level deep in every runtime. They are ADR-0029 obligation 7, they are scoped
 * to the one key that holds a serialised Error, and they are what stops an
 * exception's stack — which begins with its message — from reaching the sink.
 */
export const REDACTION_PATHS: readonly string[] = [
  ...RedactedFieldName.options.flatMap((name) => DEPTHS.map((depth) => `${depth}${name}`)),
  'err.message',
  'err.stack',
];

/**
 * Whether a value serialises itself, in which case rebuilding it from its own
 * enumerable keys would destroy it.
 *
 * `Date` and `Buffer` both carry `toJSON`, and both have NO own enumerable
 * keys — so a walk that rebuilt them would emit `{}` and silently empty every
 * timestamp in the log. The named limit: a class whose `toJSON` returns
 * something sensitive is not reached here. Nothing in this application has one,
 * and closing it would mean calling `toJSON` during redaction, i.e. running
 * arbitrary application code inside the logger.
 */
function serialisesItself(node: object): boolean {
  return typeof (node as { toJSON?: unknown }).toJSON === 'function';
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
 * **An `Error` is passed through untouched.** MEASURED: `formatters.log` runs
 * BEFORE `serializers`, so rebuilding an Error into a plain object hands pino's
 * `err` serialiser `{}` — `type` disappeared and every stack frame with it.
 * Errors belong to {@link import('./logger.js')}'s serialiser; this walk owns
 * plain data. Their own enumerable properties are still covered to depth three
 * by {@link REDACTION_PATHS}.
 *
 * **Cycles are rebuilt as cycles**, via the `rebuilt` map: a node reached twice
 * yields the SAME rebuilt object both times, so pino's own safe stringifier
 * marks it `[Circular]` exactly as it would have. Returning the original on the
 * second visit would have been the obvious shape and leaks — the parent would
 * then point at an uncensored graph. There is deliberately no depth cap: a
 * finite object is finite, and the map is what bounds the infinite one.
 */
export function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return redactValue(object, new Map<object, unknown>()) as Record<string, unknown>;
}

function redactValue(node: unknown, rebuilt: Map<object, unknown>): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (node instanceof Error || serialisesItself(node)) return node;

  const already = rebuilt.get(node);
  if (already !== undefined) return already;

  if (Array.isArray(node)) {
    const copy: unknown[] = [];
    rebuilt.set(node, copy);
    for (const item of node) copy.push(redactValue(item, rebuilt));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  rebuilt.set(node, copy);
  for (const [key, value] of Object.entries(node)) {
    copy[key] = isRedactedKey(key) ? REDACTION_CENSOR : redactValue(value, rebuilt);
  }
  return copy;
}
