import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE TEST THAT STOPS THE CONTROL FROM BEING WIRED TO NOTHING.
 *
 * Everything in `test/sentry-redaction.test.ts` exercises `redactSentryEvent`
 * and `keepAllowedIntegrations` as functions. Both would keep passing with the
 * two `Sentry.init` calls stripped of `beforeSend` and `integrations` entirely
 * — a green suite, a green build, a green browser, and every event leaving with
 * its credentials in it. This repository has shipped exactly that shape before:
 * a control tested in isolation and never asserted to be INSTALLED.
 *
 * `vi.mock` rather than a text scan over the source, because a text scan proves
 * the characters are present and not that the value reaches Sentry. It also
 * happens to be the only way to load these modules at all under Vitest: the
 * real `@sentry/nextjs` ESM build imports `next/constants` extensionlessly and
 * Node's resolver rejects it. Mocking the specifier means it is never executed.
 */
const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
  captureRequestError: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => sentry);

interface CapturedOptions {
  readonly dsn?: unknown;
  readonly beforeSend?: unknown;
  readonly integrations?: unknown;
  readonly sendDefaultPii?: unknown;
}

function optionsFromLastInit(): CapturedOptions {
  expect(sentry.init).toHaveBeenCalledTimes(1);
  const [options] = sentry.init.mock.calls[0] as [CapturedOptions];
  return options;
}

/**
 * Imported HERE rather than at the top of the file, and the difference is the
 * whole reason the first draft of this suite failed: `vi.resetModules()` gives
 * the instrumentation module a fresh copy of every module it imports, so a
 * statically imported `redactSentryEvent` is a DIFFERENT function object from
 * the one that reached `Sentry.init`. Identity is the assertion worth making —
 * comparing by name would pass against any function called the same thing — so
 * the import has to happen inside the same registry.
 */
async function shared(): Promise<{
  redactSentryEvent: unknown;
  keepAllowedIntegrations: unknown;
}> {
  const [redaction, sentryOptions] = await Promise.all([
    import('../src/lib/telemetry/redaction.js'),
    import('../src/lib/telemetry/sentry.js'),
  ]);
  return {
    redactSentryEvent: redaction.redactSentryEvent,
    keepAllowedIntegrations: sentryOptions.keepAllowedIntegrations,
  };
}

beforeEach(() => {
  sentry.init.mockClear();
  vi.resetModules();
});

describe.each([
  [
    'the browser init',
    async () => {
      await import('../src/instrumentation-client.js');
    },
  ],
  [
    'the server init',
    async () => {
      const { register } = await import('../src/instrumentation.js');
      register();
    },
  ],
])('%s', (_label, run) => {
  it('passes the shared redaction hook as beforeSend', async () => {
    await run();

    expect(optionsFromLastInit().beforeSend).toBe((await shared()).redactSentryEvent);
  });

  it('passes the shared integration allowlist', async () => {
    await run();

    expect(optionsFromLastInit().integrations).toBe((await shared()).keepAllowedIntegrations);
  });

  it('does not collect PII', async () => {
    await run();

    expect(optionsFromLastInit().sendDefaultPii).toBe(false);
  });

  /**
   * The DSN is empty in this repository's `.env.example` and unset in Vitest's
   * environment, so this asserts the disabled state Plan 0C requires until Task
   * 2 closes the API's stack-message leak — and, incidentally, that the value
   * comes from configuration rather than a literal somebody pasted in.
   */
  it('takes its DSN from configuration, which is unset here', async () => {
    await run();

    expect(optionsFromLastInit().dsn).toBeUndefined();
  });

  /**
   * An ABSENCE, and the one that keeps `apps/web` out of the tracing business:
   * with no `tracesSampleRate` there is no sampling decision to make. The
   * allowlist excludes `BrowserTracing` as well, so both halves have to be
   * removed for a browser transaction to appear.
   */
  it('sets no tracesSampleRate', async () => {
    await run();

    expect(optionsFromLastInit()).not.toHaveProperty('tracesSampleRate');
  });
});

describe('the hooks Next looks up by name', () => {
  it('routes App Router navigations into Sentry from the client module', async () => {
    const client = await import('../src/instrumentation-client.js');

    expect(client.onRouterTransitionStart).toBe(sentry.captureRouterTransitionStart);
  });

  /**
   * Without this export a Server Component that throws is handled by Next and
   * never reaches an uncaught-exception handler — the error simply does not
   * arrive, with nothing anywhere saying so.
   */
  it('routes failed server renders into Sentry from the server module', async () => {
    const server = await import('../src/instrumentation.js');

    expect(server.onRequestError).toBe(sentry.captureRequestError);
  });
});
