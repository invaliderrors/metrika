import { isRedactedKey } from './redaction.js';

/**
 * The Sentry sink's traversal, for every runtime that has one.
 *
 * **THE THIRD TIME "THAT PART IS EACH SINK'S OWN" HAS BEEN WRONG, and it is
 * worth writing the sequence down because the next candidate will look just as
 * local as these two did.** `redaction.ts` first said the LIST was shared and
 * the matching rule was each sink's business; review measured 27 of 140 probe
 * names disagreeing between two carefully written matchers, and the rule moved
 * here. This module then said the list and the rule were shared and the
 * TRAVERSAL was each sink's business — and `apps/api` shipped a Sentry client
 * with no traversal at all, which is a stronger version of the same failure: not
 * two implementations drifting, but one existing and one missing. A traversal is
 * far more logic than a matching rule, so a second copy would have drifted
 * harder; there is now exactly one, graded once, in the package that already
 * crosses every boundary as generated code.
 *
 * What is genuinely per-sink is the SHAPE OF THE SINK: Pino matches paths and
 * needs `apps/api`'s two traversals for the shapes a path cannot reach,
 * structlog matches a flat event dict's keys, and Sentry hands `beforeSend` an
 * arbitrary object graph. This module is the third of those.
 *
 * **No dependency, and that was a constraint rather than an outcome.**
 * `packages/contracts` imports nothing but `zod`, and this walk imports nothing
 * at all beyond `isRedactedKey` from its own package — no Sentry types either.
 * `redactSentryEvent` is generic over the event, so `apps/api` passes
 * `@sentry/node`'s `ErrorEvent` and `apps/web` passes `@sentry/nextjs`'s, and
 * neither type reaches this package.
 *
 * `redaction-corpus.json` — emitted through `contracts:emit` with its verdicts
 * DECLARED rather than computed — grades this walk as well as the matcher:
 * `test/sentry-event.test.ts` runs every row through the traversal itself, so a
 * walk that stops reaching part of an event is red even though the shared rule
 * is untouched.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT BUILDS A CLEANED COPY. IT DOES NOT MUTATE THE EVENT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the third version of the traversal and the first one whose safety is
 * structural rather than argued, so the three that failed are worth naming —
 * every one of them was an in-place mutation with a bookkeeping mistake, and
 * each fix closed one door and left another open:
 *
 *  1. a depth cap that RETURNED from a subtree, leaving it intact;
 *  2. a visited-set that recorded "I have been here" and was read as "this is
 *     clean", so aliases of an unwritable node were handed back verbatim;
 *  3. an outcome map that recorded `clean` OPTIMISTICALLY so a cycle could
 *     terminate — and a BACK-EDGE (a descendant referring to an ancestor) read
 *     that optimism, kept the original node, and shipped it after the ancestor
 *     had failed. Measured on the wire:
 *     `const B = {}; const A = Object.freeze({ down: B, password: 'x' }); B.up = A`
 *     sent as `{ request: { a: A, b: B } }` produced
 *     `{"a":"[REDACTED]","b":{"up":{"down":"[Circular ~]","password":"x"}}}`.
 *
 * The reasoning error in (3) is exact and is the reason for the rewrite: *"the
 * failing node's subtree becomes unreachable" holds only when the descendant is
 * reachable solely through the failing node.* A back-edge is precisely a
 * descendant reachable from outside it. And circularity does not save it —
 * `@sentry/core`'s `envelope.js:56-61` catches the `JSON.stringify` throw and
 * re-serialises through `normalize()`, which writes `[Circular ~]` and keeps
 * every other value.
 *
 * Building a copy removes the premise all three shared. Nothing is ever written
 * to the event, so:
 *
 *   - **there is no such thing as a node that cannot be cleaned.** Frozen
 *     objects, setter-less getters, setters that silently ignore the assignment,
 *     and `Proxy` traps returning `true` without storing anything are all just
 *     values to READ. Two of those four were measured shipping secrets through
 *     the previous version's `write()`, which reported a success it had not
 *     achieved.
 *   - **a back-edge is safe by construction.** The output container is created
 *     and memoised BEFORE its children are filled, and it is never replaced, so
 *     whatever a back-edge captured is the same object that ends up complete.
 *   - **a getter that returns a fresh object each call cannot escape.** The
 *     previous version cleaned the copy it had just read, compared it to itself,
 *     wrote nothing, and left the transport to invoke the getter again and
 *     serialise a pristine one — measured, `request.data = {get body() { return
 *     { password } }}` shipped the password. Here the cleaned value goes into
 *     the OUTPUT, and the output is what Sentry sends.
 *   - a read that throws costs one PROPERTY rather than a whole node, which is
 *     both safer and a better diagnostic than the old node-wide censor.
 *
 * What a copy costs is fidelity, and the two places that matters are handled
 * explicitly below: `toJSON` and the object prototype.
 */
export const REDACTION_CENSOR = '[REDACTED]';

/**
 * The recursion limit, and it stands ON ITS OWN — Sentry's normalisation does
 * not back it up where it matters.
 *
 * MEASURED against `@sentry/core@10.70.0`, because the first version of this
 * comment asserted the opposite and used it as the justification:
 * `_processEvent` is `this._prepareEvent(…).then((prepared) => …
 * processBeforeSend(…))` (`client.js:586-595`), and `_prepareEvent` calls
 * `normalizeEvent` in its own `.then` (`utils/prepareEvent.js:52-53`). So
 * `normalizeDepth` runs **BEFORE** this hook, not after.
 *
 * That is worse than the wrong ordering suggested, because `normalizeEvent`
 * (`utils/prepareEvent.js:123-167`) touches only `breadcrumbs[].data`, `user`,
 * `contexts`, `contexts.trace.data`, `contexts.flags`, `extra` and
 * `spans[].data`. **`request`, `tags` and
 * `exception.values[].stacktrace.frames[].vars` are depth-limited NOWHERE** —
 * not before this hook, not after it.
 *
 * **RE-DERIVED FOR `apps/api` RATHER THAN CARRIED OVER**, because the browser's
 * answer is not evidence about the server's: the whole workspace resolves ONE
 * physical `@sentry/core@10.70.0`
 * (`node_modules/.pnpm/@sentry+core@10.70.0`), so `@sentry/node` and
 * `@sentry/nextjs` run the same `normalizeEvent` and the same regions are
 * uncovered on both. The exposure is larger on the server, not smaller:
 * `RequestData` populates `request` from real middleware, and
 * `LocalVariablesAsync` — on `apps/api`'s allowlist as well as the browser's —
 * populates `frames[].vars`.
 *
 * **12, AND THE COST OF THE NUMBER IS DESTRUCTION RATHER THAN EXPOSURE.** Past
 * the cap the subtree becomes the censor, so everything below it is gone — not
 * merely unredacted. Measured: `request.data` nested eleven objects deep loses a
 * `modelId` sitting beside the secret.
 *
 * The number is chosen against the deepest path a REAL event has: an object
 * holding a local variable sits at **depth 8** — `event`(0) `exception`(1)
 * `values`(2) `values[0]`(3) `stacktrace`(4) `frames`(5) `frames[0]`(6)
 * `vars`(7) `vars.local`(8) — so a frame's locals get four levels of their own
 * structure and a request body gets ten. `test/sentry-event.test.ts` pins the
 * boundary in both directions, so raising this is a deliberate edit with a red
 * test in front of it rather than a number somebody nudges.
 */
const MAX_DEPTH = 12;

/**
 * What a truncated array ends with, and it is deliberately NOT
 * `REDACTION_CENSOR`.
 *
 * The two mean opposite things to whoever is reading the event: `[REDACTED]`
 * says "a value was here and this sink removed it", and truncation says "more
 * elements were here and none of them were looked at". Measured, with one
 * marker doing both jobs: `frames[0].vars.vertices` of 2500 shipped as 1001
 * entries ending `[REDACTED]`, which an operator reads as a secret in a vertex
 * buffer. And Sentry's own truncation of `extra.big` — 5000 elements normalised
 * to `…999,"[MaxProperties ~]"` before this hook runs — came back out of the
 * walk with Sentry's marker REPLACED by `[REDACTED]`.
 *
 * The token is Sentry's own (`@sentry/core/utils/normalize.js:62`) rather than
 * an invention of ours, so an operator sees one vocabulary on the wire and the
 * re-truncation above is now a no-op in meaning as well as in bytes.
 */
export const BREADTH_MARKER = '[MaxProperties ~]';

/**
 * The breadth limit, and it exists for ONE reason: a declared `length` can be
 * larger than anything that is present.
 *
 * `JSON.stringify` emits a `null` per hole, so a dense copy is what keeps the
 * wire byte-identical for a sparse array — and it also means `a.length =
 * 5_000_000` on an array with two elements materialises five million entries
 * before anything is sent. Measured at 130 ms, inside `beforeSend`, on an error
 * path. That is AMPLIFICATION: the copy manufactures entries the input never
 * held.
 *
 * 1000 is not an invented number — it is `normalizeMaxBreadth`'s default, which
 * Sentry applies to `extra`, `contexts` and `breadcrumbs[].data` before this
 * hook runs.
 *
 * **IT DOES NOT MAKE THE THREE UNPROTECTED REGIONS EQUAL TO THOSE, and an
 * earlier version of this comment claimed it did.** `normalizeMaxBreadth` caps
 * object PROPERTIES as well as array elements — a 1500-key object normalises to
 * 1001 keys plus a marker — and this cap lives only in the array branch, so a
 * 3000-key object at `request.data` keeps all 3000. Measured.
 *
 * That asymmetry is deliberate rather than an omission. An object's key count is
 * what `Object.keys` actually returns, so copying it is O(present) and the copy
 * is the same size as the input — there is nothing to amplify, and capping would
 * drop real data for no safety reason. An array's `length` is a NUMBER SOMEBODY
 * SET. `test/sentry-event.test.ts` pins the object case so the code and this
 * paragraph cannot drift apart again, and the uncovered-cells list names it.
 *
 * **This is the one place the copy deliberately diverges from
 * `JSON.stringify`.** An array longer than the cap is truncated and gains a
 * trailing `BREADTH_MARKER`, so the truncation is visible on the wire rather
 * than silent. Stated here because a reader comparing the two will otherwise
 * take it for a defect.
 */
const MAX_BREADTH = 1000;

/**
 * Where the walk is, relative to Sentry's own stack-frame structure. See
 * `FRAME_PATH_KEY`.
 */
type Zone = 'none' | 'stacktrace' | 'frames' | 'frame';

/**
 * `filename` is on the shared list — file names are customer intellectual
 * property — and inside a STACK FRAME it is not a file name at all. It is the
 * path of a JavaScript bundle or of our own source, and censoring it takes
 * Sentry's `culprit` with it, which is the very field `redactSentryEvent`'s doc
 * offers as the compensation for censoring `url`. Measured: every frame's path
 * became `[REDACTED]` and so did the culprit.
 *
 * So the exemption is POSITIONAL, and deliberately not a change to the shared
 * list — which is not negotiable, and would be wrong to narrow for every sink
 * because one sink has a structural field of the same name.
 *
 * Two conditions, both required, because either alone is guessable: the walk
 * must be inside `…stacktrace.frames[]` (the `Zone` machine below), AND the
 * object must carry a key only a real frame carries. The residual is stated
 * rather than hidden: a customer payload that itself nests
 * `stacktrace.frames[]` and puts `lineno` beside `filename` would be exempted
 * too. That takes four of Sentry's own key names in the right order in the
 * customer's own data, and `test/sentry-event.test.ts` asserts a bare
 * `{ filename }` — with no frame marker, and outside the zone — is still
 * censored.
 */
const FRAME_PATH_KEY = 'filename';

const FRAME_MARKERS = ['function', 'lineno', 'colno', 'in_app', 'abs_path', 'module'] as const;

function isStackFrame(keys: readonly string[]): boolean {
  return FRAME_MARKERS.some((marker) => keys.includes(marker));
}

function childZone(zone: Zone, key: string): Zone {
  // A frame's own children are ordinary data again — `vars` most of all.
  if (zone === 'frame') return 'none';
  if (key === 'stacktrace') return 'stacktrace';
  if (zone === 'stacktrace' && key === 'frames') return 'frames';
  return 'none';
}

/**
 * The cleaned output for one input node, and the depth it was produced at.
 *
 * The depth is recorded because the cap makes the result DEPTH-DEPENDENT, and
 * that is a leak-adjacent defect rather than a tidiness one: an aliased node
 * reached first at depth 12 produces a truncated copy, and reusing it for the
 * same node reached at depth 2 destroys data that walked perfectly well.
 * Measured on the previous version, in the direction that made it look like a
 * control: `Object.freeze({ modelId, detail: { note } })` reached deep-first
 * became `[REDACTED]` at its shallow alias, and reached shallow-first stayed
 * intact.
 *
 * A result produced at a shallower-or-equal depth is at least as complete, so it
 * is reused; anything deeper is recomputed. That terminates — a node can only be
 * recomputed at a strictly smaller depth, so at most `MAX_DEPTH + 1` times — and
 * the earlier, more truncated copy simply stays where it was already embedded.
 */
interface Cleaned {
  readonly output: unknown;
  readonly depth: number;
}

/**
 * Reads a property, treating any throw as "the value is unknown".
 *
 * `Object.keys` names accessor properties, and a getter is arbitrary code: it
 * can throw, and on a `Proxy` so can the read itself. Before this was contained,
 * such a throw escaped `beforeSend` and Sentry dropped the whole event — silent
 * for the operator, and a lost report.
 */
function read(source: object, key: string | number): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: (source as Record<string | number, unknown>)[key] };
  } catch {
    return { ok: false, value: undefined };
  }
}

/**
 * `Object.defineProperty`, not `output[key] = value`, and the reason is that
 * `__proto__` is a LYING SETTER — the same class as the `write()` this walk
 * deleted, relocated into the output.
 *
 * `Object.prototype.__proto__` is an accessor, so a plain assignment for that
 * one key name sets the prototype and stores nothing. Measured against an event
 * carrying an own enumerable `__proto__` (which `JSON.parse` produces and which
 * `normalizeEvent` does not touch in `request`):
 *
 *   original wire → `{"__proto__":{…},"keep":"yes"}`
 *   assignment    → `{"keep":"yes"}` — the field silently destroyed
 *
 * It can also THROW: `Cyclic __proto__ value` on a graph whose own `__proto__`
 * properties form a cycle. `defineProperty` on a fresh, extensible object with
 * no existing property of that name cannot throw and cannot be intercepted, so
 * both go away — without the output having to be null-prototype, which would
 * change what every downstream reader sees.
 */
function define(output: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(output, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function cleanValue(
  value: unknown,
  memo: WeakMap<object, Cleaned>,
  depth: number,
  zone: Zone,
): unknown {
  // Functions serialise to nothing, so they pass through and `JSON.stringify`
  // drops them — the same outcome as before this walk existed.
  if (value === null || typeof value !== 'object') return value;

  // FAIL CLOSED. There is no version of "keep going" here that is safe: below
  // the cap this function has not looked at anything.
  if (depth > MAX_DEPTH) return REDACTION_CENSOR;

  const previous = memo.get(value);
  if (previous !== undefined && previous.depth <= depth) return previous.output;

  /**
   * `toJSON` FIRST, and this is the fidelity half of building a copy.
   *
   * `JSON.stringify` — which is what Sentry's envelope serialiser uses — calls
   * `toJSON` and sends its result. A `Date` in `request` or in a frame's locals
   * is the common case: copying its (zero) own enumerable properties would send
   * `{}` where the wire used to carry an ISO string. So the result of `toJSON`
   * is what gets cleaned and emitted, which is exactly what would have been
   * sent, minus the redacted fields.
   */
  const serialiser = read(value, 'toJSON');
  if (serialiser.ok && typeof serialiser.value === 'function') {
    let produced: unknown;
    try {
      produced = (serialiser.value as (this: unknown) => unknown).call(value);
    } catch {
      produced = REDACTION_CENSOR;
    }
    // `depth + 1`, not `depth`: a `toJSON` that returns `this` would otherwise
    // re-enter this branch forever, since nothing has been memoised yet.
    const output = cleanValue(produced, memo, depth + 1, zone);
    memo.set(value, { output, depth });
    return output;
  }

  /**
   * `Array.isArray` was the ONE unguarded call left in this function, and it
   * throws: `IsArray` on a REVOKED `Proxy` raises `TypeError: Cannot perform
   * 'IsArray' on a proxy that has been revoked`. Contained here rather than only
   * at the boundary, so one revoked proxy costs its own node instead of the
   * whole report.
   */
  let array: boolean;
  try {
    array = Array.isArray(value);
  } catch {
    memo.set(value, { output: REDACTION_CENSOR, depth });
    return REDACTION_CENSOR;
  }

  if (array) {
    const output: unknown[] = [];
    // Memoised BEFORE the fill, which is what makes a back-edge safe: the
    // container a cycle captures is the one that ends up complete, because it is
    // never replaced.
    memo.set(value, { output, depth });

    const length = read(value, 'length');
    const declared = typeof length.value === 'number' ? length.value : 0;
    const count = Math.min(declared, MAX_BREADTH);
    const elementZone: Zone = zone === 'frames' ? 'frame' : 'none';

    for (let index = 0; index < count; index += 1) {
      const element = read(value, index);
      output.push(
        element.ok ? cleanValue(element.value, memo, depth + 1, elementZone) : REDACTION_CENSOR,
      );
    }
    if (declared > count) output.push(BREADTH_MARKER);
    return output;
  }

  let keys: readonly string[];
  try {
    keys = Object.keys(value);
  } catch {
    // A `Proxy` whose `ownKeys` trap throws. Nothing can be said about the node,
    // so nothing of it is sent.
    memo.set(value, { output: REDACTION_CENSOR, depth });
    return REDACTION_CENSOR;
  }

  /**
   * A PLAIN object, always — the prototype is not carried over.
   *
   * Own enumerable string keys are exactly what `JSON.stringify` would have
   * emitted, so the wire is unchanged for anything that was going to be sent. A
   * class instance loses its class, and an `Error`'s `message` and `stack` are
   * non-enumerable and were already absent from the JSON. Symbol keys,
   * non-enumerable properties and inherited properties are all dropped for the
   * same reason: the serialiser never saw them.
   */
  const output: Record<string, unknown> = {};
  memo.set(value, { output, depth });

  const frame = zone === 'frame' && isStackFrame(keys);

  for (const key of keys) {
    if (isRedactedKey(key) && !(frame && key === FRAME_PATH_KEY)) {
      define(output, key, REDACTION_CENSOR);
      continue;
    }
    const child = read(value, key);
    define(
      output,
      key,
      child.ok ? cleanValue(child.value, memo, depth + 1, childZone(zone, key)) : REDACTION_CENSOR,
    );
  }

  return output;
}

/**
 * `beforeSend`, and the reason it is `beforeSend` rather than three hooks.
 *
 * Breadcrumbs are the sensitive part of a browser event and they arrive on the
 * event as `event.breadcrumbs`, so walking the event covers them: Sentry's
 * `Breadcrumbs` integration records every `fetch` as `{ data: { url, method,
 * status_code } }`, and the upload flow this application is built around fetches
 * a PRESIGNED S3 URL whose `X-Amz-Signature` is a bearer credential for the
 * object. That single field is why `url` is on the shared list in its bare form.
 *
 * The cost is stated rather than discovered: `event.request.url` — the page or
 * route the error happened on — is also called `url`, so it is censored too.
 * That is the same trade `redaction.ts` describes for `req.url` under Pino, and
 * the answer is the same one: the identity of the page survives under a name
 * that is not `url` — Sentry's `transaction`, and the `culprit` derived from the
 * stack frames, which is why `FRAME_PATH_KEY` above exists.
 *
 * **Returns a COPY. The event handed in is not modified**, which is asserted
 * rather than assumed — it is the property that makes every hostile value shape
 * inert, so it is the one worth guarding directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE `try` IS THE CONTROL. A THROW HERE IS A FULL-SCOPE PLAINTEXT LEAK.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is not defensive habit and it is not about tidiness. When `beforeSend`
 * throws, `@sentry/core` captures the throw as an **internal** event carrying
 * `data.__sentry__ = true` (`client.js:635-652`), and `_processEvent` returns
 * that event straight past `processBeforeSend` on the strength of the flag
 * (`client.js:591-594`) — so the replacement goes out with the whole scope
 * attached and no redaction at all. Measured on the wire:
 *
 * ```
 * "extra":{"password":"hunter2"},"tags":{"authorization":"Bearer TOPSECRET"},
 * "user":{"email":"victim@example.com"},
 * "breadcrumbs":[{"data":{"url":"https://s3.example/u/a.stl?X-Amz-Signature=…"}}]
 * ```
 *
 * The presigned URL this module exists to stop ships unredacted, AND the real
 * event is dropped. One throw turns the control inside out.
 *
 * **Verified in `@sentry/node`'s own resolution rather than assumed from the
 * browser's**: the whole workspace resolves ONE physical `@sentry/core@10.70.0`,
 * so the two clients run this identical code path. Symmetry is not assumed in
 * the other direction either — `apps/api`'s Pino sink has NO analogue of this
 * short-circuit, which is why its own `logger.ts` carries a separate guard.
 *
 * Every known thrower is contained at its own node — a revoked `Proxy` reaching
 * `Array.isArray`, a throwing `ownKeys` trap, a throwing getter, a throwing
 * `toJSON` — so this catch has no reachable trigger today. That is exactly why
 * it is here and why `test/sentry-event.test.ts` reaches it by making
 * `isRedactedKey` throw: "this function never throws" is an argument, and this
 * repository's rule is that the difference between an argument and a control is
 * a fixture asserting rejection.
 *
 * `null` is Sentry's "do not send". Losing one report is the correct trade
 * against sending an unredacted one.
 *
 * **Generic over the event, so no Sentry type reaches this package.** Each app
 * passes its own SDK's `ErrorEvent`; the walk needs nothing from the type beyond
 * "it is an object", which is what `packages/contracts` importing only `zod`
 * requires.
 */
export function redactSentryEvent<TEvent>(event: TEvent): TEvent | null {
  try {
    const output = cleanValue(event, new WeakMap<object, Cleaned>(), 0, 'none');

    if (typeof output !== 'object' || output === null) return null;
    return output as TEvent;
  } catch {
    return null;
  }
}
