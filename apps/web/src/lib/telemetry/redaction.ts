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
 * exactly the moment something is already going wrong. 12 is well past the
 * deepest path a real event has (`exception.values[0].stacktrace.frames[0]
 * .vars.x` is 6).
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
 * Returns what the parent should store in place of `value` — the same object
 * when the walk completed, `REDACTION_CENSOR` when it could not.
 *
 * Returning a REPLACEMENT rather than mutating in place is the whole of the
 * fix. A void walk can only stop; it cannot tell its caller "I did not examine
 * this", so every limit it hits leaves the subtree behind intact.
 *
 * **`seen` POISONING is closed by the same change, and the mechanism is worth
 * writing down because the obvious fix is a different one.** With the old
 * fail-open cap, a node walked AT the cap was marked visited while its children
 * were abandoned intact, so a later, shallower path to the same node skipped
 * them. MEASURED, and key-order dependent:
 * `{ request: { aDeep: <10 wrappers>→shared, zShallow: shared } }` left
 * `zShallow.inner.password` in the clear, and redacted it when the two keys were
 * swapped. Now a node that is walked has every child either walked or CENSORED,
 * so "already visited" means "already clean" and a plain `WeakSet` is sound —
 * tracking the depth each node was reached at and re-walking on a shallower one
 * would add a mechanism no mutation of this file can redden, which is its own
 * kind of defect.
 *
 * The residual is stated rather than hidden: a shared node first reached at the
 * cap keeps the censor on children a shallower path could have walked. That is
 * over-redaction, never a leak, and it needs an aliased node at depth 12.
 */
function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;

  // FAIL CLOSED. Returning here would hand the parent back a subtree this
  // function never looked inside.
  if (depth > MAX_DEPTH) return REDACTION_CENSOR;

  // Sentry events can be cyclic — `hint.originalException` graphs and framework
  // objects both manage it — and a cycle here is an infinite loop inside the
  // error path.
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const next = redactValue(value[index], seen, depth + 1);
      if (next !== value[index] && !write(value, index, next)) return REDACTION_CENSOR;
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
      return REDACTION_CENSOR;
    }
    if (!write(record, key, next)) return REDACTION_CENSOR;
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
  const result = redactValue(event, new WeakSet<object>(), 0);
  return result === event ? event : null;
}
