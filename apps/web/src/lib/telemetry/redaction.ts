import { isRedactedKey } from '@metrika/contracts';

/**
 * The Sentry sink's half of the redaction control.
 *
 * **Neither the list nor the rule is here.** `RedactedFieldName` and
 * `isRedactedKey` both live in `packages/contracts/src/redaction.ts`, and this
 * module imports the matcher rather than implementing one. That module's header
 * records why: an earlier version of it said each sink's matching was its own
 * business, and review measured the cost — 27 of 140 probe names disagreed
 * between two matchers that had each been written carefully. A first draft of
 * THIS file was one of the two, and the shapes it let through were `url2`,
 * `presigned_url_v2` and `signedurl`.
 *
 * What is genuinely this sink's own is TRAVERSAL, and that is all this module
 * does. Pino matches paths, structlog matches a flat event dict's keys, and
 * Sentry hands `beforeSend` an arbitrary object graph — so the walk below is
 * the part that cannot be shared, and the verdict is the part that must be.
 *
 * `redaction-corpus.json`, emitted through the same `contracts:emit` seam with
 * its verdicts DECLARED rather than computed, is what grades this sink:
 * `test/sentry-redaction.test.ts` runs every row through the walk itself, not
 * through the matcher, so a traversal that stops reaching some part of an event
 * is red even though the shared rule is untouched.
 *
 * **Every limit below fails CLOSED**, and that is the correction review paid
 * for: the first version of this walk had a depth cap that returned from a
 * subtree it had not examined, which is a leak with a comment in front of it.
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
 * `normalizeDepth` runs **BEFORE** `beforeSend`, not after.
 *
 * That is worse than the wrong ordering suggested, because `normalizeEvent`
 * (`utils/prepareEvent.js:123-167`) touches only `breadcrumbs[].data`, `user`,
 * `contexts`, `contexts.trace.data`, `contexts.flags`, `extra` and
 * `spans[].data`. **`request`, `tags` and
 * `exception.values[].stacktrace.frames[].vars` are depth-limited NOWHERE** —
 * not before this hook, not after it. `LocalVariablesAsync` is on this
 * application's integration allowlist, so those `vars` are populated in
 * practice, and `request.data` is a request body.
 *
 * A cap is still needed, because a walk without one turns a deeply nested
 * object into a stack overflow inside `beforeSend` — a dropped event, at
 * exactly the moment something is already going wrong.
 *
 * **12, AND THE COST OF THE NUMBER IS DESTRUCTION RATHER THAN EXPOSURE.** Past
 * the cap the subtree is replaced by the censor, so everything below it is gone
 * — not merely unredacted. Measured, and stated because the first version of
 * this comment described the cost as if it were confined to shared nodes:
 * `request.data` nested eleven objects deep loses a `modelId` sitting beside the
 * secret, and any unaliased object at depth 13 goes the same way.
 *
 * The number is chosen against the deepest path a REAL event has, which is
 * deeper than the first count here claimed: an object holding a local variable
 * sits at **depth 8** — `event`(0) `exception`(1) `values`(2) `values[0]`(3)
 * `stacktrace`(4) `frames`(5) `frames[0]`(6) `vars`(7) `vars.local`(8) — so a
 * frame's locals get four levels of their own structure and a request body gets
 * ten. `test/sentry-redaction.test.ts` pins the boundary in both directions, so
 * raising this is a deliberate edit with a red test in front of it rather than a
 * number somebody nudges.
 */
const MAX_DEPTH = 12;

/**
 * Writes `next` over `container[key]`, and reports whether it worked.
 *
 * A frozen object, or a getter with no setter, makes the assignment throw in
 * strict mode — and an exception escaping `beforeSend` makes Sentry drop the
 * whole event. That is fail-closed for the leak and silent for the operator:
 * the report is simply lost, with nothing anywhere saying why. Caught here so
 * the caller can censor the unwritable node in ITS parent instead, which keeps
 * the rest of the event.
 */
function write(container: object, key: string | number, next: unknown): boolean {
  try {
    (container as Record<string | number, unknown>)[key] = next;
    return true;
  } catch {
    return false;
  }
}

/**
 * What is known about a node. TWO states, not three.
 *
 * A `walking` state was written first, to keep the optimistic mark below from
 * claiming a node is clean before it is known to be — and it was removed
 * because no mutation of this file could redden it. Under depth-first traversal
 * a node can only be re-entered while its own walk is in progress from INSIDE
 * its own subtree, i.e. through a cycle, and the two states are then
 * indistinguishable: both hand the same object back, and if the walk goes on to
 * fail, the node is replaced in its parent and the whole subtree — cyclic
 * reference included — becomes unreachable. A third state whose behaviour no
 * test can separate from a second is decoration.
 */
type WalkOutcome = 'clean' | 'censored';

/**
 * Returns what the parent should store in place of `value` — the same object
 * when the walk completed, `REDACTION_CENSOR` when it could not.
 *
 * Returning a REPLACEMENT rather than mutating in place is the first half of the
 * fix. A void walk can only stop; it cannot tell its caller "I did not examine
 * this", so every limit it hits leaves the subtree behind intact.
 *
 * **RECORDING THE OUTCOME rather than the visit is the second half, and it is
 * what this module got wrong twice.** The premise behind a `WeakSet` is that
 * entering a node implies cleaning it. That premise fails on every path where a
 * node CANNOT be cleaned, and the first version of this comment asserted it
 * outright — "already visited means already clean". Measured at the transport
 * with `const F = Object.freeze({ password: 'hunter2' })`:
 *
 *   - `{ request: { x: F, y: { z: F } } }` shipped `"password":"hunter2"`
 *   - `{ request: { a: { z: F }, b: F } }` leaked, in both key orders
 *   - `frames: [{ vars: { a: F } }, { vars: { b: F } }]` leaked
 *   - four aliases produced one `[REDACTED]` and three verbatim copies
 *
 * The first alias was censored and every later one returned verbatim, because
 * `seen` said "visited" and the walk read that as "clean". React freezes props
 * in development, so the `frames` case is not exotic. It lands ONLY in the
 * regions this module argues have no other protection — `extra` and `contexts`
 * are immune because Sentry's `normalize` REBUILDS them before `beforeSend`,
 * measured: inside this hook an `extra` alias is `{aliased: false, frozen:
 * false}` while a `request` alias is `{aliased: true, frozen: true}`.
 *
 * So a node is marked `censored` on failure and every later encounter — alias or
 * not — gets the censor.
 *
 * **Depth is deliberately NOT tracked, and the reason changed under
 * measurement.** An earlier version of this comment claimed a depth-aware map
 * would mask the fail-open-cap mutation; it does not — `request.data` nested
 * fifteen deep stays red either way. The real reason is simpler and stronger:
 * this walk censors DESTRUCTIVELY, so a node re-reached at a shallower depth
 * finds `[REDACTED]` already written into it and recovers nothing. Depth
 * tracking would buy work, not coverage.
 */
function redactValue(value: unknown, seen: WeakMap<object, WalkOutcome>, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;

  // FAIL CLOSED. Returning here would hand the parent back a subtree this
  // function never looked inside.
  if (depth > MAX_DEPTH) return REDACTION_CENSOR;

  // THE OUTCOME, not the visit. A node that could not be cleaned hands back the
  // censor at every later alias; only a node known clean hands back itself.
  const outcome = seen.get(value);
  if (outcome === 'censored') return REDACTION_CENSOR;
  if (outcome === 'clean') return value;

  // Marked BEFORE the walk, which is what terminates a cycle — Sentry events can
  // be cyclic (`hint.originalException` graphs and framework objects both
  // manage it) and a cycle here is an infinite loop inside the error path. The
  // optimism is safe for exactly one reason, and it is the reason the state
  // machine has two entries rather than three: every failure path below
  // OVERWRITES this with `censored` before returning, and the only encounter
  // that can read it in the meantime is a cycle from inside this node's own
  // subtree — which the parent's replacement subsumes.
  seen.set(value, 'clean');

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      let next: unknown;
      try {
        // Read once, inside the guard, for the same two reasons as the object
        // branch below. An array index can be an accessor too — `Object.
        // defineProperty(arr, 0, { get })` is legal — and the previous version
        // of this branch read it twice and read it outside any `try`.
        // Annotated `unknown`, because `Array.isArray` narrows to `any[]` and an
        // element would otherwise be `any` — which this repository does not
        // allow anywhere, least of all in the one function that decides what
        // leaves the browser.
        const current: unknown = value[index];
        next = redactValue(current, seen, depth + 1);
        if (next === current) continue;
      } catch {
        seen.set(value, 'censored');
        return REDACTION_CENSOR;
      }
      if (!write(value, index, next)) {
        seen.set(value, 'censored');
        return REDACTION_CENSOR;
      }
    }
    return value;
  }

  const record: Record<string, unknown> = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    let next: unknown;
    try {
      // Read ONCE into a local, because `Object.keys` names accessor properties
      // and a getter is arbitrary code — reading it twice to compare would run
      // whatever it does twice. Inside the guard for the same reason the write
      // is: a getter that throws would otherwise escape this hook exactly like a
      // failed assignment, and Sentry would drop the whole event.
      const current = record[key];
      next = isRedactedKey(key) ? REDACTION_CENSOR : redactValue(current, seen, depth + 1);
      if (next === current) continue;
    } catch {
      seen.set(value, 'censored');
      return REDACTION_CENSOR;
    }
    if (!write(record, key, next)) {
      seen.set(value, 'censored');
      return REDACTION_CENSOR;
    }
  }
  return value;
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
 * The cost is stated rather than discovered: `event.request.url` — the page the
 * error happened on — is also called `url`, so it is censored too. That is the
 * same trade `packages/contracts/src/redaction.ts` describes for `req.url` under
 * Pino, and the answer is the same one: the identity of the page survives under
 * a name that is not `url` (Sentry's `transaction`, and the `culprit` derived
 * from the stack frames), so the diagnostic is not lost — and narrowing the
 * matcher to save one field would reopen the one it exists to close.
 *
 * Mutates and returns the same object, which is what Sentry expects. Generic
 * rather than typed to `ErrorEvent` so this module carries no Sentry types: it
 * is the one piece of the sink that is pure, and it is tested as such.
 *
 * **`null` — dropping the event — is the last resort, and only when the EVENT
 * OBJECT ITSELF could not be written to.** Every deeper failure is contained by
 * censoring the offending node in its parent, so one frozen object costs its own
 * subtree and not the report. Sentry treats a `null` return as "do not send",
 * which is the correct outcome for an event this function was unable to clean.
 */
export function redactSentryEvent<TEvent>(event: TEvent): TEvent | null {
  const result = redactValue(event, new WeakMap<object, WalkOutcome>(), 0);
  return result === event ? event : null;
}
