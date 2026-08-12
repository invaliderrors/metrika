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
 */
export const REDACTION_CENSOR = '[REDACTED]';

/**
 * The depth cap, and it is a real limit rather than paranoia: Sentry events
 * carry user-supplied `extra` and `contexts`, and a walker without one turns a
 * deeply nested object into a stack overflow inside `beforeSend` — i.e. into a
 * dropped event, at exactly the moment something is already going wrong.
 *
 * Sentry's own `normalizeDepth` default is 3 and applies AFTER `beforeSend`, so
 * this number has to stand on its own. 12 is well past the deepest path a real
 * event has (`exception.values[0].stacktrace.frames[0].vars.x` is 6).
 */
const MAX_DEPTH = 12;

function redactInPlace(node: unknown, seen: WeakSet<object>, depth: number): void {
  if (node === null || typeof node !== 'object' || depth > MAX_DEPTH) return;
  // Sentry events can be cyclic — `hint.originalException` graphs and framework
  // objects both manage it — and a cycle here is an infinite loop inside the
  // error path.
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) redactInPlace(item, seen, depth + 1);
    return;
  }

  const record: Record<string, unknown> = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isRedactedKey(key)) {
      record[key] = REDACTION_CENSOR;
    } else {
      redactInPlace(record[key], seen, depth + 1);
    }
  }
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
 */
export function redactSentryEvent<TEvent>(event: TEvent): TEvent {
  redactInPlace(event, new WeakSet(), 0);
  return event;
}
