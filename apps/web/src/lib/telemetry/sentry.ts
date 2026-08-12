import { clientEnv } from '../../config/env';

/**
 * The pieces both `Sentry.init()` call sites share, and nothing else.
 *
 * There are two of them — `src/instrumentation-client.ts` for the browser and
 * `src/instrumentation.ts` for the Next server — and they deliberately write
 * their option objects out in full rather than spreading a shared literal. A
 * spread defeats TypeScript's excess-property check, so a misspelled Sentry
 * option in a shared object would be silently dropped and the configuration
 * would look enforced while doing nothing. What is shared here is what must not
 * drift between the two: the DSN, the redaction hook and the integration
 * allowlist.
 */

/**
 * `undefined`, not `''`, when the DSN is unset.
 *
 * `ClientEnvSchema` defaults the key to the empty string so a developer without
 * a Sentry project is not blocked, and Sentry's own "No DSN provided, client
 * will not send events" path keys off a falsy `dsn`. Passing `''` reaches the
 * same place, but passing `undefined` is the value that path is written for.
 *
 * It was ALSO unset for a phase-ordering reason, and that reason is now
 * discharged: `apps/api`'s exception filter used to write an `Error`'s stack —
 * which begins with its message — to the log, so a DSN in a thrown message was
 * written down, and no task could ship a *populated* sink before that closed.
 * Plan 0C Task 2 closed it, in
 * `apps/api/src/infrastructure/telemetry/{redaction,logger}.ts`: the paths are
 * derived from the same `RedactedFieldName` this file's `beforeSend` matches
 * against, and the exception's message and stack no longer reach the sink at
 * all. Populating the DSN is a deployment decision from here, not a phase gate.
 */
export const SENTRY_DSN: string | undefined =
  clientEnv.NEXT_PUBLIC_SENTRY_DSN === '' ? undefined : clientEnv.NEXT_PUBLIC_SENTRY_DSN;

/**
 * The integrations Sentry is allowed to run, by name — an ALLOWLIST, and the
 * direction is the whole point.
 *
 * ADR-0029 obligation 2 decided this for `apps/api` after measuring that
 * Sentry's default set is **44** integrations rather than the 22 its first
 * round reported, and chose the allowlist over a denylist because the two
 * produce identical output today and only the allowlist survives a Sentry
 * release that adds a span-producing integration. The same choice is made here
 * for the same reason; the collision that made it mandatory over there
 * (`@fastify/otel` and Sentry's `Fastify` integration both decorating
 * `opentelemetry`) has no analogue in `apps/web`.
 *
 * MEASURED against `@sentry/nextjs@10.70.0` on 2026-08-12, by loading each
 * build's `getDefaultIntegrations` directly:
 *
 *   - browser: 11 defaults, every one of them error-side, plus two the SDK's
 *     own `init` appends — `BrowserTracing` and
 *     `NextjsClientStackFrameNormalization`.
 *   - Next server: 17 defaults with tracing off (44 with `tracesSampleRate: 1`,
 *     which is ADR-0029's number reproduced), plus `DistDirRewriteFrames`.
 *
 * **`BrowserTracing` is the one exclusion that bites today.** `apps/web`
 * produces no traces in this phase — the browser's contribution to the
 * correlation chain is the request ID, and the trace begins at the API — so an
 * integration whose job is to open a transaction per pageload has nothing to
 * contribute and would start sampling decisions this system does not yet make.
 *
 * `Http` and `NodeFetch` stay, and that is a decision rather than an oversight:
 * with `tracesSampleRate` unset they emit no spans at all, the Next SDK has
 * already replaced `Http` with `httpIntegration({ disableIncomingRequestSpans:
 * true })` for this exact framework, and what they still do is breadcrumbs and
 * request isolation — error-side work.
 *
 * The two SDK-internal ones are named here because they have **no exported
 * factory**: `defaultIntegrations: false` plus a list of factory calls — the
 * other way to write an allowlist — cannot bring them back, and it would
 * silently drop the frame rewriting that makes a Next stack trace resolvable.
 * That is why the allowlist is applied as a FILTER over the SDK's own defaults
 * rather than as a list of constructions.
 */
export const ALLOWED_INTEGRATION_NAMES: readonly string[] = [
  // Browser
  'Breadcrumbs',
  'BrowserApiErrors',
  'BrowserSession',
  'CultureContext',
  'Dedupe',
  'GlobalHandlers',
  'HttpContext',
  'NextjsClientStackFrameNormalization',
  // Next server
  'ChildProcess',
  'Console',
  'Context',
  'ContextLines',
  'DistDirRewriteFrames',
  'Http',
  'LocalVariablesAsync',
  'Modules',
  'NodeFetch',
  'NodeSystemError',
  'OnUncaughtException',
  'OnUnhandledRejection',
  'ProcessSession',
  'RequestData',
  // Both
  'ConversationId',
  'FunctionToString',
  'InboundFilters',
  'LinkedErrors',
];

const ALLOWED = new Set(ALLOWED_INTEGRATION_NAMES);

/**
 * Passed as `integrations`, which Sentry calls with the default set and takes
 * the return value of.
 *
 * Generic over the element type so this function carries no Sentry types and
 * can be tested against plain objects as well as against the real default set —
 * `test/sentry-redaction.test.ts` does both, because a test using only synthetic
 * integrations would keep passing after Sentry renamed every real one.
 *
 * A name absent from a given runtime's defaults simply never matches there;
 * the list is the union of both runtimes, so neither `init` needs its own copy.
 */
export function keepAllowedIntegrations<TIntegration extends { readonly name: string }>(
  defaults: readonly TIntegration[],
): TIntegration[] {
  return defaults.filter((integration) => ALLOWED.has(integration.name));
}
