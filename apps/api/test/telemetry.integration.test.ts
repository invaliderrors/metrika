// THE CORRELATION TEST. `docs/OBSERVABILITY.md` §2 promises that one request ID
// resolves to one trace spanning the browser, this API, Temporal and both Python
// workers; this file asserts the API's share of it, end to end.
//
// FOUR THINGS ABOUT THE HARNESS, because ADR-0029 records five false readings
// and every one of them came from the apparatus rather than from the stack.
//
//   1. **A CHILD PROCESS RUNNING THE BUILT `dist/main.js`, not an in-process
//      boot.** MEASURED: `require-in-the-middle` does not intercept module
//      loading under Vitest, so `@opentelemetry/instrumentation-pino` never
//      patches `pino` there and a log line comes out with no `traceId` at all —
//      while the identical calls under plain `node` carry all four fields. An
//      in-process suite would therefore have failed on the harness rather than
//      on the subject, and (worse) could have been "fixed" by asserting the
//      weaker thing. `test/fixtures/telemetry-probe-server.mjs` carries the
//      measurement.
//   2. **A REAL OTLP RECEIVER, not an `InMemorySpanExporter`.** That exporter
//      stores the `ReadableSpan` and never runs the OTLP transformer, so a span
//      that cannot be serialised is indistinguishable from one that exported
//      cleanly — which is how ADR-0029's round 1 reported a working Temporal
//      sink that was exporting nothing. The receiver below parses the body, so
//      `traceId` in a log line is compared against a span that really came out.
//   3. **The trace and the request ID are asserted APART.** `apps/workers`
//      measured that dropping baggage leaves a span correctly parented and
//      merely empties `requestId`, while dropping trace context roots the span.
//      "The request ID arrived" is therefore not evidence that the trace joined:
//      the parent linkage is asserted directly, against the span id this suite
//      put in the `traceparent` header.
//   4. **The negative is asserted too.** Every field checked here is also
//      checked for the value it must NOT have — the sentinel request id, a
//      second trace id, a re-rooted span — because Plan 0B-3 shipped five
//      defects across a boundary whose fixtures were all positive assertions.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startTestDatabase, stopDatabase, TEST_HEALTH_DEEP_TOKEN } from './support.js';

/** The `traceparent` this suite sends, so the parent linkage has a known value. */
const PARENT_TRACE_ID = 'a1a2a3a4b1b2b3b4c1c2c3c4d1d2d3d4';
const PARENT_SPAN_ID = 'e1e2e3e4f1f2f3f4';
const TRACEPARENT = `00-${PARENT_TRACE_ID}-${PARENT_SPAN_ID}-01`;

/**
 * A second trace, for a request to a REAL Nest route.
 *
 * The probe route is attached to the root Fastify instance through a
 * diagnostics channel, so it never enters Nest's pipeline and produces no
 * `instrumentation-nestjs-core` span at all — measured. A suite that asserted
 * "spans from Fastify and from Nest" against it was asserting the first half and
 * naming the second, and deleting `new NestInstrumentation()` left it green.
 */
const NEST_TRACE_ID = 'b1b2b3b4c1c2c3c4d1d2d3d4e1e2e3e4';
const NEST_SPAN_ID = 'f1f2f3f4a1a2a3a4';
const NEST_TRACEPARENT = `00-${NEST_TRACE_ID}-${NEST_SPAN_ID}-01`;
/** The Nest route the second request hits — a real controller, under the prefix exclusion. */
const NEST_ROUTE = '/health/live';

/**
 * A third trace, arriving with the sampled flag CLEARED.
 *
 * `SentrySampler` is not parent-based for a caller that sends W3C trace context
 * without Sentry's own `sentry-trace` / DSC: it makes its own head-based decision
 * for any span whose parent is remote. So `-00` is joined and then re-sampled,
 * and the spans are exported anyway. That is a real property with a real cost at
 * `TRACES_SAMPLE_RATE < 1` — see the test, which exists so the behaviour cannot
 * change without somebody noticing.
 */
const UNSAMPLED_TRACE_ID = 'c1c2c3c4d1d2d3d4e1e2e3e4f1f2f3f4';
const UNSAMPLED_SPAN_ID = 'a2a3a4a5b2b3b4b5';
const UNSAMPLED_TRACEPARENT = `00-${UNSAMPLED_TRACE_ID}-${UNSAMPLED_SPAN_ID}-00`;

/** Inside `normaliseRequestId`'s allowlist, and not its sentinel. */
const REQUEST_ID = 'req-correlation-0001';
const SENTINEL = 'unknown';

/** Spelled here rather than imported, so a rename on either side is a failure. */
const BAGGAGE_REQUEST_ID = 'metrika.request_id';
/**
 * The second entry `metrika_core.telemetry` reads, and the one this process does
 * not set: it arrives on the wire and has to survive the hop. It is what
 * distinguishes the W3C baggage propagator from Sentry's, which also emits a
 * `baggage` header — see the test that uses it.
 */
const BAGGAGE_ORGANIZATION_ID = 'metrika.organization_id';
const ORGANIZATION_ID = 'org-correlation-0001';

const PROBE_ROUTE = '/telemetry-probe';
const PROBE_PREFIX = 'probe: ';

// ---------------------------------------------------------------------------
// The OTLP/HTTP receiver and the outbound echo.
// ---------------------------------------------------------------------------

/**
 * `@opentelemetry/exporter-trace-otlp-http` posts OTLP/JSON, in which the byte
 * fields are lower-case hex strings. PARSED rather than cast: this is the one
 * place the suite reads somebody else's wire format, and a shape change should
 * fail here with a message rather than three assertions later as `undefined`.
 */
const OtlpAttribute = z.object({ key: z.string(), value: z.record(z.string(), z.unknown()) });
const OtlpPayload = z.object({
  resourceSpans: z
    .array(
      z.object({
        resource: z.object({ attributes: z.array(OtlpAttribute).optional() }).optional(),
        scopeSpans: z
          .array(
            z.object({
              scope: z.object({ name: z.string() }).optional(),
              spans: z
                .array(
                  z.object({
                    name: z.string(),
                    traceId: z.string(),
                    spanId: z.string(),
                    parentSpanId: z.string().optional(),
                    attributes: z.array(OtlpAttribute).optional(),
                  }),
                )
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

interface ReceivedSpan {
  readonly scope: string;
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly attributeKeys: readonly string[];
}

interface Receiver {
  readonly url: string;
  readonly spans: () => readonly ReceivedSpan[];
  readonly resourceAttributes: () => ReadonlyMap<string, unknown>;
  readonly close: () => Promise<void>;
}

async function startOtlpReceiver(): Promise<Receiver> {
  const spans: ReceivedSpan[] = [];
  const resourceAttributes = new Map<string, unknown>();

  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const payload = OtlpPayload.parse(JSON.parse(body));
      for (const resourceSpan of payload.resourceSpans ?? []) {
        for (const attribute of resourceSpan.resource?.attributes ?? []) {
          resourceAttributes.set(attribute.key, attribute.value);
        }
        for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
          for (const span of scopeSpan.spans ?? []) {
            spans.push({
              scope: scopeSpan.scope?.name ?? '(no scope)',
              name: span.name,
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              attributeKeys: (span.attributes ?? []).map((attribute) => attribute.key),
            });
          }
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });

  await listen(server);
  return {
    url: `http://127.0.0.1:${String(portOf(server))}/v1/traces`,
    spans: () => spans,
    resourceAttributes: () => resourceAttributes,
    close: async (): Promise<void> => closeServer(server),
  };
}

/**
 * An origin the probe route calls with `fetch`, recording what arrived.
 *
 * This is how the propagator is graded on BEHAVIOUR rather than on membership.
 * `SentryPropagator` alone is a working propagator by every local signal — the
 * SDK starts, spans exist, Sentry is happy — and the failure only shows on the
 * wire: `baggage` never leaves, so the next process gets a span with no request
 * ID on any of its log lines. Reading the headers off a real outbound call is
 * the only place that is visible from here.
 */
interface Echo {
  readonly url: string;
  readonly headers: () => IncomingHttpHeaders | undefined;
  readonly close: () => Promise<void>;
}

async function startEcho(): Promise<Echo> {
  let seen: IncomingHttpHeaders | undefined;
  const server = createServer((request, response) => {
    seen = request.headers;
    response.writeHead(204);
    response.end();
  });
  await listen(server);
  return {
    url: `http://127.0.0.1:${String(portOf(server))}/echo`,
    headers: () => seen,
    close: async (): Promise<void> => closeServer(server),
  };
}

/**
 * A local Sentry ingest, so the child can be given a REAL DSN.
 *
 * Not a nicety. `@sentry/node` does not run `_setupIntegrations()` for a client
 * with no DSN, so `SENTRY_DSN: ''` — which the first version of this suite
 * hardcoded — leaves `client._integrations` EMPTY and every Sentry assertion in
 * this file grading a switched-off subject. MEASURED 2×2 against `dist/main.js`,
 * reading `Object.keys(getClient()._integrations)`:
 *
 * | | allowlist | allowlist removed |
 * | --- | --- | --- |
 * | `SENTRY_DSN=''` | exit 0, `[]` | exit 0, `[]` |
 * | DSN set | exit 0, the 15 names | **exit 1, `FST_ERR_DEC_ALREADY_PRESENT`** |
 *
 * So the DSN is what makes the allowlist gradeable at all, and its absence is
 * what made a task report the allowlist mutation green and write an ADR on it.
 * The sink answers 200 to everything and is never read: what matters is that the
 * DSN parses and the transport has somewhere to go, not what it sends.
 */
interface SentrySink {
  readonly dsn: string;
  readonly close: () => Promise<void>;
}

async function startSentrySink(): Promise<SentrySink> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await listen(server);
  return {
    dsn: `http://0123456789abcdef0123456789abcdef@127.0.0.1:${String(portOf(server))}/1`,
    close: async (): Promise<void> => closeServer(server),
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
}

function portOf(server: Server): number {
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** A port nothing is listening on, released immediately so the child can take it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = portOf(server);
  await closeServer(server);
  return port;
}

/**
 * `describe` is a FUNCTION, not a string, and that is the difference between a
 * timeout that names a cause and one that says "the machine was slow". Every
 * failure this suite has is reached through a wait, so the wait is where the
 * diagnosis has to be.
 */
async function until(
  predicate: () => boolean,
  deadlineMs: number,
  describe: () => string,
): Promise<void> {
  const expiry = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > expiry) throw new Error(`timed out waiting for ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---------------------------------------------------------------------------
// The child.
// ---------------------------------------------------------------------------

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'telemetry-probe-server.mjs');
const PACKAGE_ROOT = path.join(import.meta.dirname, '..');

const ReadyLine = z.object({
  probe: z.literal('ready'),
  installed: z.array(z.string()),
  provider: z.string(),
  fields: z.array(z.string()),
  integrations: z.array(z.string()),
  dsnConfigured: z.boolean(),
});
type ReadyLine = z.infer<typeof ReadyLine>;

let child: ChildProcessWithoutNullStreams | undefined;
let receiver: Receiver;
let echo: Echo;
let sentry: SentrySink;
let stdout = '';
let stderr = '';
let ready: ReadyLine;

/**
 * Every JSON object the child wrote to stdout. Nest's own boot output is not
 * JSON, so it is skipped by shape.
 *
 * **The last element of `split('\n')` is dropped unless the buffer ends in a
 * newline**, because it is a line the child has not finished writing. Without
 * that, a chunk boundary landing mid-line makes `JSON.parse` throw a
 * `SyntaxError` from inside `until()`'s predicate — replacing the diagnostic
 * this harness exists to produce with one about the harness. It is a race, so it
 * would have shown up as a suite that fails once a fortnight.
 */
function jsonLines(): readonly Record<string, unknown>[] {
  const lines = stdout.split('\n');
  if (!stdout.endsWith('\n')) lines.pop();

  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    parsed.push(JSON.parse(line) as Record<string, unknown>);
  }
  return parsed;
}

function probeLines(): readonly Record<string, unknown>[] {
  return jsonLines().filter((line) => {
    const message = line['msg'];
    return typeof message === 'string' && message.startsWith(PROBE_PREFIX);
  });
}

function spansOn(traceId: string): readonly ReceivedSpan[] {
  return receiver.spans().filter((span) => span.traceId === traceId);
}

/** The spans of the trace the probe request was supposed to JOIN. */
function requestSpans(): readonly ReceivedSpan[] {
  return spansOn(PARENT_TRACE_ID);
}

beforeAll(async () => {
  const database = await startTestDatabase();
  receiver = await startOtlpReceiver();
  echo = await startEcho();
  sentry = await startSentrySink();
  const port = await freePort();

  child = spawn(process.execPath, [FIXTURE, echo.url], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      API_PORT: String(port),
      LOG_LEVEL: 'info',
      DATABASE_URL: database.applicationUrl,
      HEALTH_DEEP_TOKEN: TEST_HEALTH_DEEP_TOKEN,
      // A REAL DSN, pointed at a local sink. See `startSentrySink`: with an
      // empty one the client constructs no integrations at all and every
      // assertion below about Sentry grades a subject that is switched off.
      SENTRY_DSN: sentry.dsn,
      OTLP_TRACES_ENDPOINT: receiver.url,
      TRACES_SAMPLE_RATE: '1',
    },
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  await until(
    () => jsonLines().some((line) => line['probe'] === 'ready'),
    60_000,
    () => `the child to report ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  ready = ReadyLine.parse(jsonLines().find((line) => line['probe'] === 'ready'));

  const base = `http://127.0.0.1:${String(port)}`;

  const response = await fetch(`${base}${PROBE_ROUTE}`, {
    headers: {
      'x-request-id': REQUEST_ID,
      traceparent: TRACEPARENT,
      baggage: `${BAGGAGE_ORGANIZATION_ID}=${ORGANIZATION_ID}`,
    },
  });
  expect(response.status).toBe(200);

  // A REAL Nest route, on its own trace. The probe route above never enters
  // Nest's pipeline, so this is the only request in this file that can show
  // `instrumentation-nestjs-core` doing anything.
  expect(
    (await fetch(`${base}${NEST_ROUTE}`, { headers: { traceparent: NEST_TRACEPARENT } })).status,
  ).toBe(200);

  // The same route again, with the sampled flag CLEARED on the way in.
  expect(
    (await fetch(`${base}${NEST_ROUTE}`, { headers: { traceparent: UNSAMPLED_TRACEPARENT } }))
      .status,
  ).toBe(200);

  // `BatchSpanProcessor` exports on its own schedule, so the suite waits for the
  // spans rather than for a duration. Waiting for a DURATION is what turns "the
  // pipeline is broken" into "the machine was busy".
  await until(
    () => requestSpans().length > 0 && spansOn(NEST_TRACE_ID).length > 0,
    30_000,
    () =>
      [
        `a span on trace ${PARENT_TRACE_ID}, which is the one the request was supposed to JOIN.`,
        `The receiver holds ${String(receiver.spans().length)} span(s) on trace ids`,
        `[${[...new Set(receiver.spans().map((span) => span.traceId))].join(', ')}].`,
        'ZERO spans means nothing is exporting at all — the sampler dropped everything',
        '(no `tracesSampleRate`), or Sentry won the OpenTelemetry globals and the OTLP',
        'pipeline is dead. A DIFFERENT trace id means the incoming traceparent was not',
        'adopted — the composite propagator lost its W3C member.',
        `The child reported provider=${ready.provider} installed=[${ready.installed.join(', ')}].`,
      ].join(' '),
  );

  // The unsampled trace is waited for SEPARATELY and non-fatally: its absence is
  // a legitimate outcome (it would mean the caller's `-00` was honoured), and it
  // is asserted as a behaviour further down rather than as a precondition here.
  await Promise.race([
    until(
      () => spansOn(UNSAMPLED_TRACE_ID).length > 0,
      15_000,
      () => 'the unsampled trace',
    ),
    new Promise((resolve) => setTimeout(resolve, 15_000)),
  ]).catch(() => undefined);
}, 180_000);

afterAll(async () => {
  child?.kill('SIGKILL');
  await receiver.close();
  await echo.close();
  await sentry.close();
  await stopDatabase();
});

describe('one request, one trace, one request id', () => {
  /**
   * ADR-0029 obligation 2, and it IS the loud failure that document says it is —
   * once the subject is switched on. Sentry's `Fastify` integration and
   * `@fastify/otel` both `decorateRequest('opentelemetry', …)`, the second throws
   * `FST_ERR_DEC_ALREADY_PRESENT` inside avvio, and the process exits 1 before it
   * listens. Measured with the allowlist removed and a DSN set; measured NOT to
   * happen with the allowlist removed and no DSN, because a client without a DSN
   * constructs no integrations at all. ADR-0033 records the pair.
   */
  it('boots at all, with Sentry actually constructed', () => {
    expect(ready.probe).toBe('ready');
    expect(ready.dsnConfigured).toBe(true);
    expect(stderr).not.toContain('FST_ERR_DEC_ALREADY_PRESENT');
  });

  it('puts requestId, traceId and spanId on the SAME log line', () => {
    const lines = probeLines();
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      expect(line['requestId']).toBe(REQUEST_ID);
      expect(line['traceId']).toMatch(/^[0-9a-f]{32}$/);
      expect(line['spanId']).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  /**
   * The assertion the plan asks for, and the reason a presence check is worth
   * little: three of the broken configurations ADR-0029 measured still emit all
   * three fields. `traceId` has to be the trace the request ACTUALLY produced,
   * read off spans that survived OTLP serialisation.
   */
  it('emits the traceId of the spans the request really exported', () => {
    const traces = new Set(requestSpans().map((span) => span.traceId));
    expect(traces).toEqual(new Set([PARENT_TRACE_ID]));

    for (const line of probeLines()) {
      expect(line['traceId']).toBe(PARENT_TRACE_ID);
    }
  });

  it('emits a spanId that names a span the request really exported', () => {
    const exported = new Set(requestSpans().map((span) => span.spanId));
    for (const line of probeLines()) {
      expect(exported).toContain(line['spanId']);
    }
  });

  /**
   * THE PARENT LINKAGE, ASSERTED DIRECTLY. A matching `traceId` is necessary and
   * not sufficient: a trace can be adopted while the span tree is re-rooted,
   * which is what `SentryPropagator` alone was measured doing at the Temporal
   * boundary. The server span's parent has to be the span id this suite put on
   * the wire.
   */
  it('parents the server span on the caller span from the traceparent header', () => {
    const server = requestSpans().find((span) => span.scope.includes('instrumentation-http'));
    expect(server).toBeDefined();
    expect(server?.parentSpanId).toBe(PARENT_SPAN_ID);
  });

  /**
   * The route TEMPLATE, and ADR-0029's own fallback trigger for this pin stated
   * as an assertion: "a request through Nest's FastifyAdapter producing no span
   * carrying `http.route`". It is also what keeps the latency histogram
   * `docs/OBSERVABILITY.md` §8 asks for at bounded cardinality.
   */
  it('carries http.route on the request spans', () => {
    const withRoute = requestSpans().filter((span) => span.attributeKeys.includes('http.route'));
    expect(withRoute.length).toBeGreaterThan(0);
  });

  /**
   * NAMED for what it actually covers. The probe route is attached to the ROOT
   * Fastify instance through a diagnostics channel, so it never enters Nest's
   * pipeline: measured, 6 spans and **zero** from `instrumentation-nestjs-core`.
   * An earlier version of this case said "and from Nest" while asserting only
   * these two, and deleting `new NestInstrumentation()` left it green. The Nest
   * assertion is its own case below, against a real controller.
   */
  it('produces spans from Fastify and from node:http on the probe route', () => {
    const scopes = new Set(requestSpans().map((span) => span.scope));
    expect(scopes).toContain('@fastify/otel');
    expect(scopes).toContain('@opentelemetry/instrumentation-http');
    expect(scopes).not.toContain('@opentelemetry/instrumentation-nestjs-core');
  });
});

describe('a real Nest route, on its own trace', () => {
  it('produces instrumentation-nestjs-core spans', () => {
    const nest = spansOn(NEST_TRACE_ID).filter(
      (span) => span.scope === '@opentelemetry/instrumentation-nestjs-core',
    );
    expect(nest.length).toBeGreaterThan(0);
    expect(nest.map((span) => span.name)).toContain('HealthController.live');
  });

  it('joins the caller`s trace there too, with the same parent linkage', () => {
    const server = spansOn(NEST_TRACE_ID).find((span) =>
      span.scope.includes('instrumentation-http'),
    );
    expect(server?.parentSpanId).toBe(NEST_SPAN_ID);
  });

  /**
   * The route TEMPLATE on a route that has one under a global prefix exclusion.
   * `/health/live` is excluded from `api/v1`, and the attribute still has to be
   * the template rather than the URL — that is what keeps the histogram
   * `docs/OBSERVABILITY.md` §8 asks for at bounded cardinality.
   */
  it('carries the route template rather than the URL', () => {
    const routes = spansOn(NEST_TRACE_ID).flatMap((span) =>
      span.attributeKeys.includes('http.route') ? [span.name] : [],
    );
    expect(routes.length).toBeGreaterThan(0);
  });
});

describe('sampling, for a caller that sends only W3C trace context', () => {
  /**
   * MEASURED AND DELIBERATE, and it is here because it is surprising.
   * `SentrySampler` is not parent-based for a caller with no `sentry-trace` /
   * DSC of its own: for any span whose parent is REMOTE it makes its own
   * head-based decision from `tracesSampleRate`. So a `traceparent` arriving
   * with the sampled flag CLEARED (`-00`) is joined — same trace id, correct
   * parent — and then re-sampled to `-01` and exported.
   *
   * The decision is to keep it: ADR-0029 obligation 1 puts `SentrySampler` on the
   * shared provider, and swapping in a `ParentBasedSampler` would take Sentry's
   * DSC handling with it. The COST, stated so it is not discovered in a
   * dashboard: at `TRACES_SAMPLE_RATE < 1` this cuts both ways — a caller's
   * sampled trace can be dropped here, leaving whatever it calls next as
   * orphaned children.
   *
   * This test asserts the current behaviour, so changing it is a red test rather
   * than a silent change of what a browser's sampling decision means.
   */
  it('re-samples an unsampled parent rather than honouring the flag', () => {
    expect(spansOn(UNSAMPLED_TRACE_ID).length).toBeGreaterThan(0);
  });

  it('still joins that trace and parents on the caller', () => {
    const server = spansOn(UNSAMPLED_TRACE_ID).find((span) =>
      span.scope.includes('instrumentation-http'),
    );
    expect(server?.parentSpanId).toBe(UNSAMPLED_SPAN_ID);
  });
});

describe('the propagator that carries it out again', () => {
  it('sends the request id onward as baggage on an outbound call', () => {
    expect(echo.headers()?.['baggage']).toContain(`${BAGGAGE_REQUEST_ID}=${REQUEST_ID}`);
  });

  /**
   * THE ASSERTION THAT SEPARATES THE W3C BAGGAGE PROPAGATOR FROM SENTRY'S, and
   * it was added because the obvious one does not. MEASURED: with
   * `W3CBaggagePropagator` removed from the composite, every other assertion in
   * this file stays green — `SentryPropagator` emits a `baggage` header of its
   * own (`sentry-environment=…,sentry-trace_id=…`) and carries the entry this
   * process SET onto it, so a fixture that only checks the request id cannot see
   * the member go missing.
   *
   * An entry this process did NOT set is the discriminator: it exists only if
   * something EXTRACTED the incoming `baggage` header into the OpenTelemetry
   * context. `metrika.organization_id` is not a synthetic choice — it is the
   * second entry `metrika_core.telemetry` binds to every worker log line, so
   * this is the browser → API → worker chain's own payload.
   */
  it('passes an incoming baggage entry it did not set through to the next hop', () => {
    expect(echo.headers()?.['baggage']).toContain(`${BAGGAGE_ORGANIZATION_ID}=${ORGANIZATION_ID}`);
  });

  it('sends W3C trace context onward, on the SAME trace', () => {
    expect(echo.headers()?.['traceparent']).toMatch(
      new RegExp(`^00-${PARENT_TRACE_ID}-[0-9a-f]{16}-0[01]$`),
    );
  });

  it('registers all three propagators globally, Sentry included', () => {
    expect(ready.fields).toEqual(expect.arrayContaining(['traceparent', 'tracestate', 'baggage']));
    expect(ready.fields).toContain('sentry-trace');
  });
});

describe('Sentry and OpenTelemetry on one provider', () => {
  /**
   * Double registration does not throw. `@opentelemetry/api`'s `registerGlobal`
   * refuses the second registration of `context`, `propagation` or `trace` and
   * reports it through `diag`, whose default logger discards — so the process
   * exits 0 with one of the two backends silently dead. These two facts are what
   * separate the working configuration from that one.
   */
  it('reports every Sentry piece as installed on the OTel globals', () => {
    expect(ready.installed).toEqual(
      expect.arrayContaining([
        'SentryContextManager',
        'SentryPropagator',
        'SentrySpanProcessor',
        'SentrySampler',
      ]),
    );
  });

  /**
   * ADR-0029's stated fallback trigger, as an assertion: a `SentryTracerProvider`
   * behind the global tracer means Sentry won the registration, and the OTLP
   * exporter is receiving nothing while every component reports success.
   *
   * TWO assertions because the first one alone is weak in a way that is easy to
   * miss: `openTelemetrySetupCheck()` reports `SentryTracerProvider` only when
   * Sentry built its own — measured, that entry appears the moment
   * `skipOpenTelemetrySetup` is dropped and is absent otherwise. The provider
   * name is read through `getDelegate()`, because the API's own
   * `getTracerProvider()` returns a `ProxyTracerProvider` in every configuration
   * and a check against IT would pass in the broken one too.
   */
  it('leaves the OpenTelemetry provider in place rather than Sentry`s own', () => {
    expect(ready.installed).not.toContain('SentryTracerProvider');
    // `TracerProvider` is what `@opentelemetry/sdk-trace-node@2.10.0` calls its
    // class; `NodeSDK` constructs it. Pinned by name so a swap is visible.
    expect(ready.provider).toBe('TracerProvider');
  });

  /**
   * THE ALLOWLIST'S END-TO-END FIXTURE, and the reason this suite runs the child
   * against a real DSN. `client._integrations` is what the allowlist PRODUCED —
   * not `getDefaultIntegrations()`, which is what it was subtracted from, and not
   * an empty object, which is all a DSN-less client ever has.
   *
   * Asserted as a SET EQUALITY rather than a subset: an integration this project
   * did not choose is exactly what the allowlist direction exists to exclude, so
   * an extra name has to be as red as a missing one.
   */
  it('constructs exactly the allowlisted Sentry integrations, and nothing else', () => {
    expect(new Set(ready.integrations)).toEqual(
      new Set([
        'InboundFilters',
        'FunctionToString',
        'LinkedErrors',
        'RequestData',
        'NodeSystemError',
        'ConversationId',
        'Console',
        'OnUncaughtException',
        'OnUnhandledRejection',
        'ContextLines',
        'LocalVariablesAsync',
        'Context',
        'ChildProcess',
        'ProcessSession',
        'Modules',
      ]),
    );
  });

  /**
   * The two that must not be there, named individually. They are the ones with an
   * OpenTelemetry counterpart installed by this bootstrap, and `Fastify` is the
   * one whose collision exits the process — so a change that let any of the three
   * back in should fail on a line that says which.
   */
  it('constructs no Sentry integration that patches a module', () => {
    expect(ready.integrations).not.toContain('Http');
    expect(ready.integrations).not.toContain('NodeFetch');
    expect(ready.integrations).not.toContain('Fastify');
  });

  it('exports under an explicit resource naming this service', () => {
    expect(receiver.resourceAttributes().get('service.name')).toEqual({
      stringValue: 'metrika-api',
    });
    expect(receiver.resourceAttributes().get('deployment.environment.name')).toEqual({
      stringValue: 'test',
    });
  });

  /**
   * The `diag` logger is the ONLY thing that makes a duplicate registration
   * visible, so its silence is evidence rather than absence of evidence: this
   * asserts that it was installed and had nothing to report, not that nobody
   * looked.
   */
  it('reports no duplicate registration of an OpenTelemetry global', () => {
    expect(stderr).not.toContain('Attempted duplicate registration');
  });
});

describe('the request context under the OTel context manager', () => {
  /**
   * ADR-0029's question 3, re-asserted on this application's own middleware. The
   * negative case is what makes it worth anything: had the OTel context manager
   * reset the store, `requestId` would read `unknown` on the lines after the
   * `await` and after the outbound call, and nothing else anywhere would fail.
   */
  it('keeps the request id across an await and an instrumented outbound call', () => {
    const messages = probeLines().map((line) => line['msg']);
    expect(messages).toEqual([
      'probe: in the handler',
      'probe: after an await',
      'probe: after an outbound call',
    ]);
    for (const line of probeLines()) {
      expect(line['requestId']).not.toBe(SENTINEL);
    }
  });

  /**
   * The sentinel is not decoration. A line written outside a request — the
   * child's own boot, a background failure — must not carry somebody else's id,
   * and `getRequestId()` reporting `unknown` is what says so. Asserted on the
   * mechanism's own output rather than by reasoning about it.
   */
  it('never attributes a probe line to the sentinel or to another request id', () => {
    const ids = new Set(probeLines().map((line) => line['requestId']));
    expect(ids).toEqual(new Set([REQUEST_ID]));
  });
});
