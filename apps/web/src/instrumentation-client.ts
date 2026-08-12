import * as Sentry from '@sentry/nextjs';
import { redactSentryEvent } from '@metrika/contracts';
import { SENTRY_DSN, keepAllowedIntegrations } from '@/lib/telemetry/sentry';

/**
 * The browser half of Sentry. Next runs this module once, before anything else
 * on the client, because of its NAME — `src/instrumentation-client.ts` is a
 * framework convention, not an import, so nothing in `src/` references it and
 * deleting it disables browser error reporting with every other gate green.
 * `e2e/shell.spec.ts` asserts a page load produces no uncaught error, which is
 * what catches this file throwing; nothing catches it being absent.
 *
 * `docs/OBSERVABILITY.md` §1 puts Sentry on all three runtimes for grouping and
 * release health, and §3 makes redaction the same list everywhere. `beforeSend`
 * below is this runtime's copy of that control — the only one of the three
 * that runs on a machine we do not own, which is the reason it walks the whole
 * event rather than trusting a field list.
 */
Sentry.init({
  dsn: SENTRY_DSN,

  /**
   * The redaction control, and the reason this file exists at all in Phase 0C.
   * See `@metrika/contracts` — the list, the matching rule and the
   * traversal all live there now, and the walk is graded there too. The walk is
   * `packages/contracts`, and the walk is what reaches a fetch breadcrumb's
   * `data.url`, where a presigned S3 URL would otherwise leave the browser.
   */
  beforeSend: redactSentryEvent,

  /**
   * ADR-0029 obligation 2's allowlist, applied as a filter over whatever the
   * installed SDK considers default. See `ALLOWED_INTEGRATION_NAMES` for why
   * this is a filter rather than `defaultIntegrations: false` plus a list of
   * constructions — two of the integrations that must survive have no exported
   * factory.
   */
  integrations: keepAllowedIntegrations,

  /**
   * No `tracesSampleRate`, deliberately, and `BrowserTracing` is excluded from
   * the allowlist above so that the absence is enforced rather than defaulted.
   * The browser's contribution to the correlation chain is the request ID
   * (`@/lib/request-id/request-id`); the trace itself starts at the API. A
   * browser transaction here would be a second, unjoined trace per pageload.
   */

  /**
   * PII stays off. Sentry's `sendDefaultPii` attaches the IP address, cookies
   * and request headers — including `Authorization`, which `beforeSend` would
   * then have to catch on the way out. Not collecting it is the stronger
   * control; `docs/SECURITY.md` §10 is the standing reason.
   */
  sendDefaultPii: false,
});

/**
 * Required by `@sentry/nextjs` to report App Router navigations. Exported from
 * this file specifically — Next looks for the name here, and it is the reason
 * the file cannot be reduced to a side-effect import from somewhere tidier.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
