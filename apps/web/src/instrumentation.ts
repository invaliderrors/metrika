import * as Sentry from '@sentry/nextjs';
import { redactSentryEvent } from '@/lib/telemetry/redaction';
import { SENTRY_DSN, keepAllowedIntegrations } from '@/lib/telemetry/sentry';

/**
 * The server half of Sentry. Next calls `register()` once per server process,
 * by name — see the note in `src/instrumentation-client.ts` about what that
 * means for deleting the file.
 *
 * **There is no `NEXT_RUNTIME` branch, and its absence is deliberate.** The
 * conventional wiring reads `process.env.NEXT_RUNTIME` and imports a different
 * config per runtime; two things make that wrong here. `process.env` may only
 * be read in `src/config/env.ts` (CLAUDE.md), and the branch exists upstream
 * only to load runtime-specific OPTION FILES — the options below are the same
 * in all three runtimes, and `@sentry/nextjs` resolves `init` itself through
 * its `exports` map's `node` / `edge-light` conditions. `apps/web` has no
 * middleware and no edge routes today, so this runs in Node; when one arrives
 * it will already be initialised rather than silently unreported.
 */
export function register(): void {
  Sentry.init({
    dsn: SENTRY_DSN,

    // The same control as the browser's, deliberately the same function: this
    // is the sink that sees server-rendered failures, where a thrown Error's
    // message reaches `event.exception.values[].value`.
    beforeSend: redactSentryEvent,

    // ADR-0029 obligation 2. See `@/lib/telemetry/sentry`.
    integrations: keepAllowedIntegrations,

    // No `tracesSampleRate`. Phase 0C's spans come from `apps/api`'s OTel SDK;
    // a Next server transaction here would be a separate trace with nothing
    // joining it to the request the browser made.

    sendDefaultPii: false,
  });
}

/**
 * What routes a failed App Router render into Sentry — a request that throws
 * inside a Server Component is otherwise handled by Next and never reaches
 * `onUncaughtException`. Next looks for this export by name on this module.
 */
export const onRequestError = Sentry.captureRequestError;
