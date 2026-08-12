import { REDACTION_CENSOR, isRedactedKey } from '@metrika/contracts';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * The redaction control for SPAN ATTRIBUTES, which leave this process by a path
 * that is not a log sink and was hardened by none of the four that are.
 *
 * **The leak, measured before this file existed.** `@opentelemetry/instrumentation-undici@0.31.0`
 * (`build/src/undici.js:166-168`) sets `url.full = requestUrl.toString()` and
 * `url.query = requestUrl.search` on **every outbound fetch**, and
 * `TRACES_SAMPLE_RATE` defaults to `1`. One `fetch` to a URL carrying
 * `X-Amz-Signature` was measured leaving by BOTH doors at once — as `url.full`
 * and `url.query` on the OTLP wire, and inside a Sentry transaction envelope —
 * with the four log sinks all correctly silent. `url` is on the shared redaction
 * list precisely because a signed URL is a bearer token for the object until it
 * expires; the span pipeline simply was not asked.
 *
 * It is latent only because `apps/api` makes no S3 call yet. That is exactly how
 * the `beforeSend` gap was latent until it was measured.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE HOOK, NOT TWO — and that is measured, not assumed.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The two destinations are different seams: Sentry's is `beforeSendTransaction`
 * on the client, OTLP's is a `SpanExporter` behind a `BatchSpanProcessor`. A
 * hook at either seam covers one and misses the other. **A `SpanProcessor` is
 * upstream of both**: every processor is handed the SAME `Span` instance, so
 * rewriting it here rewrites what both of them go on to read.
 * `test/telemetry.integration.test.ts` asserts the signature is absent from a
 * real OTLP body AND from a real Sentry envelope, from one outbound request.
 *
 * **Its POSITION in `spanProcessors` is not the control, and the first version of
 * this doc said it was.** MEASURED by moving it last: the suite stays green,
 * because neither configured processor reads the span during `onEnd` — the batch
 * processor queues it and serialises at export time, Sentry's converts when the
 * root span ends. It is registered first anyway, because that is the only
 * position that also holds for a processor which reads eagerly, and
 * `SimpleSpanProcessor` is one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO NEW TRAVERSAL, AND NO SECOND MATCHING RULE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A span attribute set is a FLAT string-keyed map — OpenTelemetry does not allow
 * a nested one — so there is nothing here to walk and nothing that needs
 * `redactSentryEvent`'s machinery. The key decision is `isRedactedKey`, the same
 * shared rule the other four sinks call. That matters more than it looks:
 * `packages/contracts`' own history is two hand-written matchers measured
 * disagreeing on 27 of 140 names, and then a traversal that existed in one sink
 * and was missing in another.
 *
 * The key rule is not decoration here. MEASURED against real attribute names:
 * `http.request.header.authorization` — which both `instrumentation-http` and
 * `-undici` will emit the moment somebody sets `headersToSpanAttributes` — is
 * matched by the shared rule with nothing added.
 */

/**
 * `url.full` IS NOT A REDACTED NAME. It is an attribute whose VALUE carries a
 * secret, which the shared list cannot reach, because the list matches KEYS —
 * MEASURED: `isRedactedKey('url.full')` and `isRedactedKey('url.query')` are
 * both `false`, and correctly so, since `url.full` is not a spelling of `url`.
 *
 * So this is a POSITIONAL close, the third in this repository after
 * `frames[].filename` and `exception.values[].value` — and it is the easy one of
 * the three, because the position is unambiguous. A Sentry event is an arbitrary
 * customer object graph, so both of those closes need a marker to tell a real
 * stack frame from a payload that happens to look like one. **A span attribute
 * map is not customer data at all**: every key in it is written by an
 * instrumentation this bootstrap chose and named, against OpenTelemetry's
 * semantic conventions. Nothing a customer sends can create the key `url.full`
 * on a span. There is therefore nothing to gate on, and a marker would be
 * ceremony.
 *
 * **THE COST, STATED.** A query string is removed from every span that carries
 * one, so an operator loses the parameters of an outbound call — including
 * benign ones like a page cursor. What survives is scheme, host and PATH, which
 * is what identifies the call, plus `http.route` on the server side, which is
 * untouched. The alternative — removing only the parameters that look like
 * credentials — is a secret DETECTOR, which `docs/OBSERVABILITY.md` §3 rejects
 * for the reason it always gives: it fails silently on the first shape it does
 * not match, and `X-Amz-Signature` is one shape out of many.
 *
 * Both spellings of each, because the semantic conventions moved and the two
 * instrumentations here are on different lines of it: `url.full`/`url.query` are
 * stable semconv 1.43, `http.url`/`http.target` are what the older attribute set
 * calls the same values.
 */
const URL_ATTRIBUTES_WITH_A_QUERY = new Set(['url.full', 'http.url', 'http.target']);

/** Attributes whose entire value IS a query string, so there is no prefix to keep. */
const QUERY_ONLY_ATTRIBUTES = new Set(['url.query']);

/**
 * The value with its query and fragment replaced by the censor marker.
 *
 * String scanning rather than `new URL(...)`: the value is whatever an
 * instrumentation put there, `URL` throws on a relative one (`http.target` is
 * relative by definition), and a redaction control that can throw on the export
 * path is worse than the leak it closes. The marker is KEPT rather than the
 * query silently dropped, so an operator can tell "no query" from "a query was
 * removed" — the same reason `REDACTION_CENSOR` appears at all.
 */
export function redactUrlValue(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : `${value.slice(0, cut)}?${REDACTION_CENSOR}`;
}

/**
 * Rewrites one attribute map IN PLACE, and in place is deliberate: the object is
 * the live `Span`'s, and it is what every processor after this one reads. A
 * cleaned copy would be correct and would protect nothing.
 */
export function redactSpanAttributes(attributes: Record<string, unknown>): void {
  for (const key of Object.keys(attributes)) {
    if (isRedactedKey(key) || QUERY_ONLY_ATTRIBUTES.has(key)) {
      attributes[key] = REDACTION_CENSOR;
      continue;
    }
    const value = attributes[key];
    if (URL_ATTRIBUTES_WITH_A_QUERY.has(key) && typeof value === 'string') {
      attributes[key] = redactUrlValue(value);
    }
  }
}

/**
 * `sentry.url` — A SECOND COPY OF THE SAME URL, ON THE SPAN'S `traceState`, and
 * it is the reason this file's fixture reads the RAW export body rather than the
 * parsed attributes.
 *
 * `@sentry/opentelemetry` writes the outbound URL into the trace state
 * (`asyncContextStrategy-*.js:1532`), and `traceState` is serialised into the
 * OTLP payload beside the attributes. MEASURED: with the attribute redaction
 * above already in place and every parsed attribute clean, the OTLP body still
 * carried
 * `"traceState":"sentry.url=http://…/download?X-Amz-Signature=…"`.
 * An attribute-shaped probe cannot see it; a probe that greps the bytes that
 * left can.
 *
 * **UNSET, not censored.** Two reasons, and the first is a real hazard: a
 * `tracestate` value has a restricted character set on the wire and
 * `REDACTION_CENSOR`'s brackets are outside it, so writing the marker there
 * would emit a header a conformant receiver may reject. The second is that it
 * buys nothing — the value is a duplicate of `url.full`, which survives in
 * redacted form.
 *
 * Removing it at `onEnd` cannot change behaviour: Sentry reads it through
 * `getCurrentURL`, which prefers the `url.full` attribute anyway and is consulted
 * for `tracePropagationTargets` while the span is live — long before it ends.
 */
export const SENTRY_URL_TRACE_STATE_KEY = 'sentry.url';

export function redactSpanTraceState(context: {
  traceState?: { get: (key: string) => string | undefined; unset: (key: string) => unknown };
}): void {
  const traceState = context.traceState;
  if (traceState === undefined || traceState.get(SENTRY_URL_TRACE_STATE_KEY) === undefined) return;
  context.traceState = traceState.unset(SENTRY_URL_TRACE_STATE_KEY) as typeof traceState;
}

/**
 * Runs {@link redactSpanAttributes} on every span as it ends, before any
 * processor that exports one.
 *
 * `onEnd` and not `onStart`: an instrumentation may add attributes at any point
 * in a span's life — `instrumentation-undici` sets response attributes long
 * after the request one — and `onEnd` is the only moment at which the set is
 * complete.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(): void {
    // Nothing: see the class doc. The attribute set is not complete yet.
  }

  onEnd(span: ReadableSpan): void {
    redactSpanAttributes(span.attributes);
    redactSpanTraceState(span.spanContext());
  }

  async forceFlush(): Promise<void> {
    // Nothing is buffered here; the rewrite is synchronous inside `onEnd`.
  }

  async shutdown(): Promise<void> {
    // Nothing to release.
  }
}
