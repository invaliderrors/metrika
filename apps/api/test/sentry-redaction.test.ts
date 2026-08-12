import { describe, expect, it } from 'vitest';
import { redactSentryEvent } from '@metrika/contracts';
import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';
import { sentryOptions } from '../src/infrastructure/telemetry/index.js';

/**
 * THE SENTRY SINK'S REDACTION, GRADED AT THE TRANSPORT.
 *
 * `apps/api`'s Sentry client was wired with no `beforeSend` at all. Plan 0C's
 * ordering rule was that no exporter ships before the exception filter stops
 * writing an `Error`'s message to a sink; Task 2 closed that for Pino, and this
 * client sent the same string to an EXTERNAL SERVICE instead. It was latent only
 * because `SENTRY_DSN` defaults to empty, which is a deployment default rather
 * than a control.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE APPARATUS, STATED, BECAUSE SIX GREEN RESULTS IN THIS PLAN WERE THE
 * APPARATUS RATHER THAN THE SUBJECT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. **A real `NodeClient` built from `sentryOptions(env)`** — the object
 *      `startTelemetry()` passes to `Sentry.init`, not a restatement of it.
 *      Removing `beforeSend` from the application makes every case below red,
 *      which a fixture holding its own options object could not manage.
 *   2. **A real DSN.** `@sentry/node` short-circuits an unconfigured client, so
 *      with `SENTRY_DSN` empty nothing is prepared, nothing is sent, and every
 *      assertion here would pass against a client that does nothing at all.
 *      ADR-0034 records that exact false reading against the integration list.
 *   3. **A capturing transport, and the assertions read WHAT IT RECEIVED** —
 *      not `redactSentryEvent`'s return value. The walk is graded in
 *      `packages/contracts/test/sentry-event.test.ts`; what is unproven until
 *      this file runs is that the hook is attached to this client and that
 *      Sentry's own pipeline does not put anything back.
 *   4. **`client.init()` is NOT called.** It would install
 *      `OnUncaughtException` and `OnUnhandledRejection` process handlers into
 *      the test runner. The integrations are graded in `test/telemetry.test.ts`
 *      and `test/telemetry.integration.test.ts`; the pipeline under test here is
 *      `_prepareEvent` → `processBeforeSend` → `sendEvent`, which needs no
 *      integration.
 *
 * The DSN is syntactically valid and points at a host nothing resolves; the
 * transport never makes a request.
 */
const DSN = 'https://0123456789abcdef0123456789abcdef@o0.ingest.invalid/1';

const ENV = {
  NODE_ENV: 'test',
  SENTRY_DSN: DSN,
  OTLP_TRACES_ENDPOINT: '',
  TRACES_SAMPLE_RATE: 0,
} as const;

interface Captured {
  readonly client: Sentry.NodeClient;
  /**
   * THE WIRE, and it is a string rather than a structure because that is what
   * the transport is handed: `createTransport`'s callback receives a `body` that
   * has already been through `serializeEnvelope`. MEASURED — the first version
   * of this file treated it as an `Envelope` object and indexed into it, read
   * `undefined`, and would have passed an assertion written the other way round.
   * Grepping the serialised bytes is both simpler and stricter: it is the wire.
   */
  readonly bodies: string[];
}

function capturingClient(overrides: Partial<Sentry.NodeOptions> = {}): Captured {
  const bodies: string[] = [];
  const options = sentryOptions(ENV);
  const client = new Sentry.NodeClient({
    ...options,
    ...overrides,
    dsn: DSN,
    // Constructed by `sentryOptions`, deliberately NOT set up — see (4) above.
    integrations: [],
    stackParser: Sentry.defaultStackParser,
    transport: () =>
      Sentry.createTransport({ recordDroppedEvent: () => undefined }, async (request) => {
        bodies.push(String(request.body));
        return {};
      }),
  });
  return { client, bodies };
}

/**
 * The event payload out of a serialised envelope: newline-delimited JSON, of
 * which the third line is the item.
 */
function eventFrom(body: string): Event {
  const payload: unknown = JSON.parse(body.split('\n')[2] ?? '{}');
  return payload as Event;
}

/**
 * The four shapes review measured leaving this client in one envelope, each
 * planted where a real event carries it.
 *
 * `request` and `tags` are the regions Sentry's own `normalizeEvent` does not
 * touch at all, and `RequestData` populates `request` here from real middleware
 * — so the server's exposure is larger than the browser's, not smaller.
 */
const DSN_IN_MESSAGE = 'DB_DSN=postgres://user:PASSWORD@host/db';
const PRESIGNED = 'https://s3.example/metrika/uploads/abc.stl?X-Amz-Signature=DEADBEEF';
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9';
const FILENAME = 'Torre_Bacata_Fase3_Final.stl';

function leakyEvent(): Event {
  return {
    event_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    level: 'error',
    transaction: 'POST /v1/quotes',
    exception: { values: [{ type: 'Error', value: DSN_IN_MESSAGE }] },
    extra: { presignedUrl: PRESIGNED, modelId: 'mv_1' },
    tags: { authorization: BEARER, route: 'quotes' },
    contexts: { upload: { originalFilename: FILENAME, cacheKey: 'sha256:deadbeef' } },
  };
}

async function send(event: Event, overrides?: Partial<Sentry.NodeOptions>): Promise<string> {
  const { client, bodies } = capturingClient(overrides);
  client.captureEvent(event);
  await client.flush(2000);
  expect(bodies.length, 'nothing reached the transport — the apparatus, not the subject').toBe(1);
  return bodies[0] ?? '';
}

describe('the redaction hook on this application’s Sentry client', () => {
  /**
   * Identity, against the shared implementation. A fixture that only asserted
   * "some function is set" would pass against a second, drifted copy — which is
   * the failure `packages/contracts` owning the traversal exists to prevent.
   */
  it('is the shared walk, not a local copy', () => {
    expect(sentryOptions(ENV).beforeSend).toBe(redactSentryEvent);
  });

  it('is attached even when the DSN is empty, so enabling one cannot enable a leak', () => {
    const disabled = sentryOptions({ ...ENV, SENTRY_DSN: '' });

    expect(disabled.dsn).toBeUndefined();
    expect(disabled.beforeSend).toBe(redactSentryEvent);
  });
});

describe('what reaches the transport', () => {
  it.each([
    ['a presigned URL in extra', 'X-Amz-Signature'],
    ['an Authorization bearer in tags', 'eyJhbGciOiJIUzI1NiJ9'],
    ['an originalFilename in a context', 'Torre_Bacata'],
  ])('does not carry %s', async (_label, fragment) => {
    expect(await send(leakyEvent())).not.toContain(fragment);
  });

  /**
   * The other direction, and it is what stops the control being "censor
   * everything": an event with nothing left in it is not a report. Each of these
   * sits beside a censored field in the same object.
   */
  it('still carries the diagnostic that is not on the list', async () => {
    const wire = await send(leakyEvent());

    expect(wire).toContain('mv_1');
    expect(wire).toContain('quotes');
    expect(wire).toContain('sha256:deadbeef');
    expect(wire).toContain('POST /v1/quotes');
  });

  /**
   * `exception.values[].value` is the exception MESSAGE, and it is the field the
   * 0B-1 carry-forward is about — an `Error`'s message is where a DSN or a
   * connection string ends up. Asserted by position as well as by absence, so a
   * walk that dropped the exception entirely would not pass for the wrong
   * reason.
   */
  /**
   * ───────────────────────────────────────────────────────────────────────────
   * THE FOURTH SHAPE IS STILL OPEN, AND THIS PINS IT RATHER THAN HIDING IT
   * ───────────────────────────────────────────────────────────────────────────
   *
   * `exception.values[].value` IS the exception message, and `value` is not a
   * redacted name — correctly, since it is far too generic to put on a shared
   * list that three sinks read. So the walk, which redacts by key NAME, does not
   * reach it, and the 0B-1 carry-forward — an `Error` whose message carries a
   * DSN — is still live for this sink.
   *
   * Asserted in the direction it currently behaves, so that closing it is a
   * deliberate edit with a red test in front of it rather than a silent change.
   * The next commit closes it; this one is the lift, which is required to move
   * `apps/web`'s behaviour by nothing at all.
   */
  it('does NOT yet censor the exception message, which is the remaining shape', async () => {
    const event = eventFrom(await send(leakyEvent()));

    expect(event.exception?.values?.[0]?.type).toBe('Error');
    expect(event.exception?.values?.[0]?.value).toBe(DSN_IN_MESSAGE);
  });

  it('does not modify the event it was given', async () => {
    const event = leakyEvent();
    await send(event);

    expect(event.exception?.values?.[0]?.value).toBe(DSN_IN_MESSAGE);
    expect(event.extra?.['presignedUrl']).toBe(PRESIGNED);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE WALK'S BOUNDARY `catch` IS A CONTROL AND NOT A HABIT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A characterisation test of `@sentry/core@10.70.0`, deliberately: it asserts
 * the MECHANISM rather than our code, because that mechanism is the entire
 * reason `redactSentryEvent` may not throw.
 *
 * When `beforeSend` throws, `client.js:635-652` captures the throw as a new
 * event carrying `data.__sentry__ = true`, and `client.js:591-594` returns any
 * event with that flag STRAIGHT PAST `processBeforeSend`. So the replacement
 * ships with the whole scope attached and no redaction at all — the real event
 * is dropped and the payload goes out in plaintext.
 *
 * Verified in `@sentry/node`'s own resolution rather than carried over from the
 * browser: the workspace resolves ONE physical `@sentry/core@10.70.0`, so both
 * clients run this code. If Sentry ever fixes it, this test goes red and the
 * justification in `packages/contracts/src/sentry-event.ts` should be revisited
 * — it is not a licence to remove the `catch`.
 */
describe('a beforeSend that throws', () => {
  /**
   * THE SCOPE HAS TO BE POPULATED FOR THIS TO REPRODUCE, and finding that out is
   * the apparatus lesson worth recording. `_processEvent` recovers by calling
   * `this.captureException(reason, …)`, which builds a NEW event from the
   * CURRENT scope — not from the event that was being processed. A first version
   * of this test captured an explicit event with an empty current scope and saw
   * an envelope carrying only the throw's own stack, which reads exactly like
   * "nothing leaked" and would have retired the justification for the walk's
   * boundary `catch` on a false negative.
   *
   * So the client is bound as the current one and the secrets are set on the
   * current scope, which is where a real request's data lives.
   */
  it('ships the scope in plaintext, which is what the walk’s catch prevents', async () => {
    const { client, bodies } = capturingClient({
      beforeSend: () => {
        throw new Error('beforeSend exploded');
      },
    });

    const previous = Sentry.getClient();
    Sentry.setCurrentClient(client);
    try {
      await Sentry.withScope(async (scope) => {
        scope.setExtra('presignedUrl', PRESIGNED);
        scope.setTag('authorization', BEARER);
        client.captureEvent(leakyEvent(), {}, scope);
        await client.flush(2000);
      });
    } finally {
      if (previous !== undefined) Sentry.setCurrentClient(previous);
    }

    const wire = bodies.join(' ');
    expect(wire).toContain('X-Amz-Signature');
    expect(wire).toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  /**
   * And the walk cannot reach that state on an event it is given: the boundary
   * `catch` returns `null`, which Sentry records as a dropped event. Asserted
   * here at the client rather than only at the walk's return value, because
   * "returns null" and "sends nothing" are different claims.
   */
  it('is unreachable through the shared walk, whose worst case is sending nothing', async () => {
    const revocable = Proxy.revocable({ password: 'hunter2' }, {});
    revocable.revoke();

    const hostile: Event = { ...leakyEvent(), extra: { payload: revocable.proxy } };
    const wire = await send(hostile);

    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('X-Amz-Signature');
  });
});
