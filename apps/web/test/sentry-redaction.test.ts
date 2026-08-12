import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { redactionCorpus } from '@metrika/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BREADTH_MARKER,
  REDACTION_CENSOR,
  redactSentryEvent,
} from '../src/lib/telemetry/redaction.js';
import { ALLOWED_INTEGRATION_NAMES, keepAllowedIntegrations } from '../src/lib/telemetry/sentry.js';

const CORPUS = redactionCorpus();

/**
 * `redactSentryEvent` may return `null` — it drops an event it could not clean.
 * Every case below except the one that asserts that behaviour expects a cleaned
 * event back, and a `null` there is a silently dropped report rather than a
 * passing test.
 */
function cleaned<TEvent extends object>(event: TEvent): TEvent {
  const result = redactSentryEvent(event);
  expect(result, 'the event was dropped, not cleaned').not.toBeNull();
  return result as TEvent;
}

/**
 * Every string the wire would carry, serialised the way SENTRY serialises.
 *
 * A plain `JSON.stringify` is the wrong instrument here and would have made this
 * whole block unrunnable: the cleaned copy PRESERVES cycles — a back-edge points
 * at the output container its ancestor is still filling — so `stringify` throws
 * `Converting circular structure to JSON` on exactly the graphs these cases
 * exist to test. Sentry does not stop there either: `@sentry/core`'s
 * `envelope.js:56-61` catches that throw and re-serialises through `normalize()`,
 * which writes `[Circular ~]` and KEEPS every other value.
 *
 * ANCESTORS ONLY, and the reason is fidelity rather than safety — the first
 * version of this comment claimed otherwise and was wrong. A `WeakSet` would
 * collect a shared node's strings on its FIRST visit and skip it afterwards, so
 * a secret in an aliased non-cyclic subtree would still be in the string this
 * fixture greps; the assertion would not have been weakened. What ancestors-only
 * buys is that this helper reproduces what Sentry actually does: `normalize()`
 * builds its memo with `memoBuilder` and UNMEMOISES on the way out, so it cuts
 * true cycles and re-emits everything else. A fixture that models the transport
 * differently from the transport is a fixture answering a question nobody asked.
 */
function wireStrings(value: unknown, ancestors: Set<object>, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (ancestors.has(value)) return;
  ancestors.add(value);
  for (const child of Object.values(value)) wireStrings(child, ancestors, out);
  ancestors.delete(value);
}

function onTheWire(event: unknown): string {
  const strings: string[] = [];
  wireStrings(event, new Set<object>(), strings);
  return strings.join('\u0000');
}

/**
 * THE FIXTURE THAT GRADES THIS SINK, and it grades the WALK rather than the
 * rule.
 *
 * `isRedactedKey` lives in `packages/contracts` and is graded there against the
 * same corpus, so re-asserting its verdicts here would be a second copy of
 * somebody else's test. What is unproven until this file runs it is that a key
 * reaching this sink is actually VISITED: the traversal is `apps/web`'s own, and
 * a walk that stopped recursing — into arrays, past a depth, through a nested
 * `extra` — would leave the shared rule perfectly correct and the sink leaking.
 *
 * So every row is run through `redactSentryEvent` at a nesting depth an event
 * really has, not through the matcher.
 *
 * The corpus's verdicts are DECLARED rather than computed from the rule, which
 * is what stops this from being two wrong implementations agreeing with each
 * other, and it extends mechanically when a name is added to
 * `RedactedFieldName`.
 */
describe('the corpus', () => {
  it('is not empty and states both verdicts, so the loops below cannot be vacuous', () => {
    expect(CORPUS.length).toBeGreaterThan(100);
    expect(CORPUS.some((row) => row.redacted)).toBe(true);
    expect(CORPUS.some((row) => !row.redacted)).toBe(true);
  });
});

describe('redactSentryEvent, graded against the declared corpus', () => {
  /**
   * Nested two levels down inside `extra`, because the top level of an event is
   * the one place a broken walk still works: `redactValue` is called with the
   * event itself, so its own keys are visited before any recursion happens.
   */
  function eventCarrying(key: string): Record<string, unknown> {
    return { extra: { payload: { [key]: 'SECRET-VALUE' } } };
  }

  function verdictFor(key: string): boolean {
    const redacted = cleaned(eventCarrying(key));
    const payload = (redacted['extra'] as { payload: Record<string, unknown> }).payload;
    return payload[key] === REDACTION_CENSOR;
  }

  it('censors every key the corpus says must be redacted', () => {
    const missed = CORPUS.filter((row) => row.redacted && !verdictFor(row.key)).map(
      (row) => row.key,
    );

    expect(missed, 'these keys reached the sink and were written down').toEqual([]);
  });

  it('leaves every key the corpus says must survive', () => {
    const overreached = CORPUS.filter((row) => !row.redacted && verdictFor(row.key)).map(
      (row) => row.key,
    );

    expect(overreached, 'a control that censors these costs real debuggability').toEqual([]);
  });

  /**
   * The same rows again, one level deeper and inside an ARRAY. A walk that
   * recurses into objects but not into array elements passes everything above
   * and misses `event.breadcrumbs`, which is where a browser event keeps the
   * fetch that carried a presigned URL.
   */
  it('reaches keys inside arrays too', () => {
    const redactedRows = CORPUS.filter((row) => row.redacted).map((row) => row.key);
    const event = { breadcrumbs: redactedRows.map((key) => ({ data: { [key]: 'SECRET-VALUE' } })) };

    const walked = cleaned(event);
    const survivors = walked.breadcrumbs
      .flatMap((crumb) => Object.entries(crumb.data))
      .filter(([, value]) => value !== REDACTION_CENSOR)
      .map(([key]) => key);

    expect(survivors).toEqual([]);
  });
});

/**
 * A Sentry event with something sensitive at every depth and shape the real
 * SDK produces: request headers, a fetch breadcrumb, `extra`, `contexts`, and
 * the local variables Sentry's `LocalVariablesAsync` integration attaches to a
 * stack frame.
 */
const PRESIGNED = 'https://s3.example/metrika/uploads/abc.stl?X-Amz-Signature=DEADBEEF';
const SECRETS = [
  'Bearer eyJhbGciOiJIUzI1NiJ9',
  'session=s%3AabC123',
  'hunter2',
  PRESIGNED,
  'Torre_Bacata_Fase3_Final.stl',
  'Edificio Confidencial',
  'whsec_livekey',
  'tok_visa_4242',
];

function sampleEvent(): Record<string, unknown> {
  return {
    event_id: 'abc123',
    level: 'error',
    transaction: '/models/[id]',
    request: {
      url: 'https://metrika.example/models/42?foo=bar',
      headers: {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9',
        Cookie: 'session=s%3AabC123',
        'Accept-Language': 'es-CO',
      },
    },
    breadcrumbs: [
      { category: 'fetch', data: { url: PRESIGNED, method: 'PUT', status_code: 200 } },
      { category: 'navigation', data: { from: '/', to: '/models' } },
    ],
    extra: {
      password: 'hunter2',
      cacheKey: 'sha256:deadbeef',
      upload: { signedUrls: [PRESIGNED], originalFilename: 'Torre_Bacata_Fase3_Final.stl' },
      projectName: 'Edificio Confidencial',
    },
    contexts: {
      payment: { providerPayload: { token: 'tok_visa_4242' }, webhookSecret: 'whsec_livekey' },
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: 'upload failed',
          stacktrace: {
            frames: [{ filename: 'app:///page.js', vars: { token: 'tok_visa_4242' } }],
          },
        },
      ],
    },
  };
}

describe('redactSentryEvent', () => {
  /**
   * The strong form of the assertion: not "this field is censored" but "this
   * STRING is nowhere in the serialised event". A per-field assertion passes
   * while the same secret sits in a sibling key nobody thought of — which is
   * how the fetch breadcrumb, whose `data.url` carries a presigned S3 URL, was
   * missed in the first place.
   */
  it.each(SECRETS)('leaves no trace of %s anywhere in the event', (secret) => {
    const serialised = onTheWire(cleaned(sampleEvent()));

    expect(serialised).not.toContain(secret);
  });

  it('censors rather than deletes, so the shape of the event is unchanged', () => {
    const event = cleaned(sampleEvent());
    const request = event['request'] as { headers: Record<string, string> };

    expect(request.headers['Authorization']).toBe(REDACTION_CENSOR);
    expect(request.headers['Cookie']).toBe(REDACTION_CENSOR);
  });

  it('keeps everything that is not on the list', () => {
    const event = cleaned(sampleEvent());
    const request = event['request'] as { headers: Record<string, string> };
    const extra = event['extra'] as Record<string, unknown>;
    const breadcrumbs = event['breadcrumbs'] as { data: Record<string, unknown> }[];

    expect(event['event_id']).toBe('abc123');
    expect(event['level']).toBe('error');
    expect(event['transaction']).toBe('/models/[id]');
    expect(request.headers['Accept-Language']).toBe('es-CO');
    expect(extra['cacheKey']).toBe('sha256:deadbeef');
    expect(breadcrumbs[1]?.data['to']).toBe('/models');
  });

  /**
   * Stated as a test because it is the cost of putting `url` on the shared list
   * in its bare form, and a later reader will otherwise take it for a bug.
   * `packages/contracts/src/redaction.ts` explains the trade; the page identity
   * survives in `transaction`, asserted above.
   */
  it('censors request.url too, which is the known cost of the bare `url` entry', () => {
    const event = cleaned(sampleEvent());

    expect((event['request'] as Record<string, unknown>)['url']).toBe(REDACTION_CENSOR);
  });

  it("reaches into arrays and into a stack frame's local variables", () => {
    const event = cleaned(sampleEvent());
    const frames = (
      event['exception'] as {
        values: { stacktrace: { frames: { vars: Record<string, unknown> }[] } }[];
      }
    ).values[0]?.stacktrace.frames;

    expect(frames?.[0]?.vars['token']).toBe(REDACTION_CENSOR);
  });

  /**
   * A cycle in an event is not hypothetical — Sentry attaches framework objects
   * to `contexts` — and a walker without cycle detection hangs inside
   * `beforeSend`, i.e. exactly when something is already going wrong.
   */
  it('terminates on a cyclic event, and still redacts', () => {
    const event = sampleEvent();
    const cycle: Record<string, unknown> = { password: 'hunter2' };
    cycle['self'] = cycle;
    event['contexts'] = cycle;

    const redacted = cleaned(event);

    expect((redacted['contexts'] as Record<string, unknown>)['password']).toBe(REDACTION_CENSOR);
  });

  /**
   * What the visited-set is FOR, now that the depth cap fails closed.
   *
   * It is no longer a correctness control — a cycle terminates on the cap
   * either way, so removing it leaks nothing and hangs nothing. What it stops is
   * exponential work on a shared subgraph: an event where three keys point at
   * one object walks it three times, and a diamond twelve levels deep walks the
   * bottom 2^12 times. This asserts the property directly, by counting how often
   * the walk reads a shared node.
   */
  it('visits a shared node once, which is what stops a DAG from exploding', () => {
    let reads = 0;
    const child = { modelId: 'mv_1' };
    const shared = {
      get child() {
        reads += 1;
        return child;
      },
    };
    const event = { extra: { a: shared, b: shared, c: shared } };

    cleaned(event);

    expect(reads).toBe(1);
  });

  /**
   * A COPY, not the event. Sentry takes whatever `beforeSend` returns, and
   * returning a fresh object is what makes every hostile value shape inert —
   * there is nothing to write to, so there is nothing to fail at writing.
   */
  it('returns a copy rather than the event it was given', () => {
    const event = sampleEvent();

    expect(redactSentryEvent(event)).not.toBe(event);
  });

  it('handles an event with nothing sensitive in it without changing anything', () => {
    const benign = { level: 'info', extra: { modelId: 'mv_1', durationMs: 12 } };

    expect(redactSentryEvent(benign)).toStrictEqual({
      level: 'info',
      extra: { modelId: 'mv_1', durationMs: 12 },
    });
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEPTH CAP, WHICH LEAKED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The first version of this walk returned from a subtree past `MAX_DEPTH`,
 * leaving it INTACT. Review measured the consequence through the real client
 * with a capturing transport: `request.data` holding fifteen nested objects
 * ending in `{ password }` left the browser verbatim, and so did a chain under
 * `frames[0].vars`.
 *
 * The regions matter, and they are why this is a leak rather than an
 * inefficiency. Sentry's own `normalizeDepth` covers `breadcrumbs[].data`,
 * `user`, `contexts`, `extra` and `spans[].data` — and it runs BEFORE
 * `beforeSend`, not after. `request`, `tags` and
 * `exception.values[].stacktrace.frames[].vars` are depth-limited nowhere at
 * all, and `LocalVariablesAsync` is on this application's allowlist, so those
 * frames are populated in production.
 */
describe('the depth cap', () => {
  /** `{ w: { w: { … { password: secret } } } }`, `levels` objects deep. */
  function nest(levels: number, leaf: Record<string, unknown>): Record<string, unknown> {
    let node: Record<string, unknown> = leaf;
    for (let i = 0; i < levels; i += 1) node = { w: node };
    return node;
  }

  it('censors a subtree past the cap rather than abandoning it — request.data', () => {
    const event = { request: { data: nest(15, { password: 'hunter2' }) } };

    expect(onTheWire(cleaned(event))).not.toContain('hunter2');
  });

  it('censors a subtree past the cap — stack frame local variables', () => {
    const event = {
      exception: {
        values: [{ stacktrace: { frames: [{ vars: { local: nest(12, { token: 'tok_1' }) } }] } }],
      },
    };

    expect(onTheWire(cleaned(event))).not.toContain('tok_1');
  });

  /**
   * THE BOUNDARY, in both directions, because the cost of the cap is DESTRUCTION
   * and not merely a missed redaction: past it, a benign sibling of the secret
   * goes too. Ten wrappers put the leaf object at depth 12 and it survives
   * whole; eleven put it at 13 and the entire subtree becomes the censor,
   * `modelId` included.
   *
   * Pinning both sides means raising `MAX_DEPTH` is a deliberate edit with a red
   * test in front of it, rather than a number somebody nudges.
   */
  it('keeps a benign sibling at the deepest surviving level', () => {
    const event = { request: { data: nest(10, { password: 'hunter2', modelId: 'mv_1' }) } };
    const walked = onTheWire(cleaned(event));

    expect(walked).not.toContain('hunter2');
    expect(walked).toContain('mv_1');
  });

  it('destroys a benign sibling one level past it, which is the cost of the number', () => {
    const event = { request: { data: nest(11, { password: 'hunter2', modelId: 'mv_1' }) } };
    const walked = onTheWire(cleaned(event));

    expect(walked).not.toContain('hunter2');
    expect(walked).not.toContain('mv_1');
  });

  /**
   * `seen` POISONING, and it is key-order dependent — which is exactly the kind
   * of defect that reproduces on one machine and not on another.
   *
   * A node walked at depth 12 had its children abandoned past the cap AND was
   * marked visited, so a later, shallower path to the same node skipped it
   * entirely. Both orders are asserted because only one of them was broken:
   * with the deep key first the shallow path found a poisoned node, and with the
   * shallow key first everything worked.
   *
   * This case shares a root cause with the two above and therefore shares their
   * mutation: restoring the fail-open cap turns `aDeep first` red and leaves
   * `zShallow first` green, which is the asymmetry that made the original defect
   * so easy to miss.
   */
  const shallowThenDeep = ['zShallow first', 'aDeep first'] as const;

  it.each(shallowThenDeep)('redacts a shared node reached twice (%s)', (order) => {
    const shared: Record<string, unknown> = { inner: { password: 'hunter2' } };
    const deep = nest(10, shared);
    const event =
      order === 'aDeep first'
        ? { request: { aDeep: deep, zShallow: shared } }
        : { request: { zShallow: shared, aDeep: deep } };

    expect(onTheWire(cleaned(event))).not.toContain('hunter2');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * HOSTILE VALUES × REGION × REACHABILITY × DEPTH × CONTAINER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three review rounds each closed one door and left another open, because each
 * fixture block tested one dimension at a time and their SUM is not their
 * PRODUCT. This block is the product, and the cells it does not cover are named
 * at the bottom rather than left to be discovered.
 *
 * The dimensions:
 *
 *   - **hostile shape** (6): frozen; a getter with no setter; a getter that
 *     throws; a setter that silently ignores the assignment; a `Proxy` whose
 *     `set` trap returns `true` without storing; a getter that returns a FRESH
 *     object on every call. The last three were each measured shipping a
 *     password through the previous, mutating version of the walk — the first
 *     two because `write()` reported a success it had not achieved, the third
 *     because the walk cleaned a copy, wrote nothing back, and left the
 *     transport to invoke the getter again.
 *   - **container** (2): object and array. Both are needed: an array whose
 *     elements are only censored in place never attempts a write, so a frozen
 *     array alone exercises nothing.
 *   - **region** (5): `request`, `tags`, `frames[].vars`, `extra`, `contexts`.
 *     The first three have no depth or aliasing protection anywhere in Sentry;
 *     the last two are rebuilt by `normalize` before this hook, so a defect
 *     cannot reproduce there — they are included precisely so that difference is
 *     asserted rather than assumed.
 *   - **reachability** (4): direct; a sibling alias; a nested alias; and a
 *     BACK-EDGE, where a descendant refers to an ancestor and is therefore
 *     reachable from outside the ancestor's own subtree. The back-edge is what
 *     falsified round 2's optimistic `clean` mark.
 *   - **key order** (2) on every aliased case, because the previous two defects
 *     were both order-dependent and only one order was broken.
 *   - **depth relative to the cap** (3): below, at, past — CROSSED with
 *     aliasing, which is the cell no previous round covered.
 *
 * Nothing here can fail for the reason those rounds failed, and the reason is
 * structural rather than tested: the walk never writes to the event. These
 * assertions exist to keep it that way.
 */
const SECRET = 'hunter2';
const KEEP = 'mv_1';

type Hostile = () => Record<string, unknown>;

function frozen(): Record<string, unknown> {
  return Object.freeze({ password: SECRET, modelId: KEEP });
}

function getterNoSetter(): Record<string, unknown> {
  const node: Record<string, unknown> = { modelId: KEEP };
  Object.defineProperty(node, 'password', { get: () => SECRET, enumerable: true });
  return node;
}

function throwingGetter(): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  Object.defineProperty(node, 'boom', {
    get: () => {
      throw new Error('getter exploded');
    },
    enumerable: true,
  });
  node['password'] = SECRET;
  node['modelId'] = KEEP;
  return node;
}

/** A setter that accepts the assignment and keeps the old value. */
function lyingSetter(): Record<string, unknown> {
  const node: Record<string, unknown> = { modelId: KEEP };
  Object.defineProperty(node, 'password', {
    get: () => SECRET,
    set: () => undefined,
    enumerable: true,
  });
  return node;
}

/** A `Proxy` whose `set` trap reports success without storing anything. */
function lyingProxy(): Record<string, unknown> {
  return new Proxy({ password: SECRET, modelId: KEEP }, { set: () => true });
}

/** A getter handing out a NEW object each call, so cleaning a copy achieves nothing. */
function freshEachRead(): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  Object.defineProperty(node, 'body', {
    get: () => ({ password: SECRET, modelId: KEEP }),
    enumerable: true,
  });
  return node;
}

const HOSTILE_OBJECTS: readonly [string, Hostile][] = [
  ['a frozen object', frozen],
  ['a getter with no setter', getterNoSetter],
  ['a getter that throws', throwingGetter],
  ['a setter that ignores the assignment', lyingSetter],
  ['a Proxy whose set trap lies', lyingProxy],
  ['a getter returning a fresh object each read', freshEachRead],
];

const HOSTILE_ARRAYS: readonly [string, Hostile][] = [
  ['a frozen array of a frozen object', () => Object.freeze([frozen()]) as unknown as never],
  [
    'an array whose index getter throws',
    () => {
      const items: unknown[] = [];
      Object.defineProperty(items, 0, {
        get: () => {
          throw new Error('index exploded');
        },
        enumerable: true,
        configurable: true,
      });
      items[1] = { password: SECRET };
      return items as unknown as Record<string, unknown>;
    },
  ],
  ['an array of a getter-only object', () => [getterNoSetter()] as unknown as never],
];

const HOSTILE: readonly [string, Hostile][] = [...HOSTILE_OBJECTS, ...HOSTILE_ARRAYS];

/**
 * Where a hostile value is planted. The first three regions are the ones Sentry
 * protects nowhere; the last two are rebuilt by `normalize` BEFORE `beforeSend`,
 * measured — an `extra` alias arrives `{aliased: false, frozen: false}` inside
 * this hook while a `request` alias arrives `{aliased: true, frozen: true}`.
 */
const REGIONS: readonly [string, (planted: unknown, second?: unknown) => object][] = [
  ['request', (a, b) => ({ request: { data: a, other: b } })],
  ['tags', (a, b) => ({ tags: { detail: a, other: b } })],
  [
    'frames[].vars',
    (a, b) => ({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: 'app:///page.js', lineno: 12, vars: { local: a } },
                { filename: 'app:///other.js', lineno: 3, vars: { local: b } },
              ],
            },
          },
        ],
      },
    }),
  ],
  ['extra', (a, b) => ({ extra: { payload: a, other: b } })],
  ['contexts', (a, b) => ({ contexts: { detail: a, other: b } })],
];

describe('hostile values', () => {
  describe.each(REGIONS)('in %s', (_region, plant) => {
    it.each(HOSTILE)('are cleaned when reached directly: %s', (_shape, make) => {
      expect(onTheWire(cleaned(plant(make())))).not.toContain(SECRET);
    });

    it.each(HOSTILE)('are cleaned at a sibling alias, alias last: %s', (_shape, make) => {
      const node = make();

      expect(onTheWire(cleaned(plant(node, node)))).not.toContain(SECRET);
    });

    it.each(HOSTILE)('are cleaned at a nested alias, alias first: %s', (_shape, make) => {
      const node = make();

      expect(onTheWire(cleaned(plant({ wrapped: node }, node)))).not.toContain(SECRET);
    });

    it.each(HOSTILE)('are cleaned at a nested alias, alias last: %s', (_shape, make) => {
      const node = make();

      expect(onTheWire(cleaned(plant(node, { wrapped: node })))).not.toContain(SECRET);
    });

    /**
     * THE BACK-EDGE, which is what falsified the previous version. `down`
     * reaches `B`, `B.up` reaches back to `A`, and `B` is ALSO planted beside
     * `A` — so `B` is reachable without going through `A`, and a walk that
     * assumed otherwise shipped `A` intact from inside `B`.
     */
    it.each(HOSTILE_OBJECTS)('are cleaned through a back-edge, ancestor first: %s', (_s, make) => {
      const back: Record<string, unknown> = {};
      const node = make();
      const anchor = Object.freeze({ down: back, password: SECRET, inner: node });
      back['up'] = anchor;

      expect(onTheWire(cleaned(plant(anchor, back)))).not.toContain(SECRET);
    });

    it.each(HOSTILE_OBJECTS)(
      'are cleaned through a back-edge, descendant first: %s',
      (_s, make) => {
        const back: Record<string, unknown> = {};
        const node = make();
        const anchor = Object.freeze({ down: back, password: SECRET, inner: node });
        back['up'] = anchor;

        expect(onTheWire(cleaned(plant(back, anchor)))).not.toContain(SECRET);
      },
    );
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CELL NO ROUND COVERED: DEPTH × ALIASING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every previous fixture tested the cap on an unaliased node and aliasing at a
 * shallow depth. The defect lives in the crossing: a node reached deep FIRST is
 * cleaned against a smaller budget, and reusing that result for the same node
 * reached shallow destroys data that walked perfectly well. Measured on the
 * previous version — deep-first produced `[REDACTED]` at the shallow alias and
 * shallow-first left it intact, which is last round's asymmetry pointing the
 * other way.
 */
describe('the depth cap crossed with aliasing', () => {
  function nest(levels: number, leaf: unknown): Record<string, unknown> {
    let node: Record<string, unknown> = leaf as Record<string, unknown>;
    for (let i = 0; i < levels; i += 1) node = { w: node };
    return node;
  }

  const orders = ['deep first', 'shallow first'] as const;

  it.each(orders)('never leaks through either path (%s)', (order) => {
    const shared = Object.freeze({ password: SECRET, detail: { note: 'the diagnostic' } });
    const deep = nest(10, shared);
    const event =
      order === 'deep first'
        ? { request: { a: deep, z: shared } }
        : { request: { a: shared, z: deep } };

    expect(onTheWire(cleaned(event))).not.toContain(SECRET);
  });

  /**
   * The half that is about DESTRUCTION rather than exposure, and the reason the
   * memo records the depth a result was produced at. The shallow alias must
   * carry the diagnostic in both orders; reusing a truncated result for it is a
   * silent data loss that looks exactly like a control working.
   */
  it.each(orders)('keeps the shallow alias complete (%s)', (order) => {
    const shared = Object.freeze({ password: SECRET, detail: { note: 'the diagnostic' } });
    const deep = nest(10, shared);
    const event =
      order === 'deep first'
        ? { request: { a: deep, z: shared } }
        : { request: { a: shared, z: deep } };

    const walked = onTheWire(cleaned(event));
    expect(walked).not.toContain(SECRET);
    expect(walked).toContain('the diagnostic');
  });

  it.each(orders)('cleans a back-edge that also crosses the cap (%s)', (order) => {
    const back: Record<string, unknown> = {};
    const anchor = Object.freeze({ down: back, password: SECRET });
    back['up'] = anchor;
    const deep = nest(10, anchor);
    const event =
      order === 'deep first'
        ? { request: { a: deep, z: back } }
        : { request: { a: back, z: deep } };

    expect(onTheWire(cleaned(event))).not.toContain(SECRET);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROPERTY THAT MAKES ALL OF THE ABOVE INERT
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('the event handed in', () => {
  it('is never modified — the walk returns a cleaned copy', () => {
    const inner = { password: SECRET, modelId: KEEP };
    const event = { request: { data: inner } };

    const walked = cleaned(event);

    expect(walked).not.toBe(event);
    expect(inner.password).toBe(SECRET);
    expect((walked.request as { data: Record<string, unknown> }).data['password']).toBe(
      REDACTION_CENSOR,
    );
  });

  it('is not modified even when it is perfectly writable', () => {
    const event = { extra: { password: SECRET } };

    cleaned(event);

    expect(event.extra.password).toBe(SECRET);
  });

  /**
   * A `Date` in an unprotected region is the fidelity case a copying walk gets
   * wrong by default: copying its own enumerable properties would send `{}`
   * where the wire used to carry an ISO string. `toJSON` is honoured, so what
   * ships is what `JSON.stringify` would have shipped.
   */
  it('preserves what JSON.stringify would have sent for a Date', () => {
    const when = new Date('2026-08-12T04:05:06.000Z');
    const walked = cleaned({ request: { data: { when } } });

    expect(onTheWire(walked)).toContain('2026-08-12T04:05:06.000Z');
  });

  it('cleans what toJSON produces, rather than trusting it', () => {
    const hostile = { toJSON: () => ({ password: SECRET, modelId: KEEP }) };
    const walked = onTheWire(cleaned({ request: { data: hostile } }));

    expect(walked).not.toContain(SECRET);
    expect(walked).toContain(KEEP);
  });

  it('survives a toJSON that returns itself', () => {
    const loop: Record<string, unknown> = { password: SECRET };
    loop['toJSON'] = () => loop;

    expect(onTheWire(cleaned({ request: { data: loop } }))).not.toContain(SECRET);
  });

  /**
   * The last resort, and the only case that drops the report: the event object
   * itself cannot be enumerated, so there is nothing to send and nothing to say
   * about it. A FROZEN root is no longer this case — nothing is written to it.
   */
  it('is dropped only when the root cannot be enumerated at all', () => {
    const unenumerable = new Proxy(
      { password: SECRET },
      {
        ownKeys: () => {
          throw new Error('ownKeys exploded');
        },
      },
    );

    expect(redactSentryEvent(unenumerable)).toBeNull();
    expect(redactSentryEvent(Object.freeze({ password: SECRET }))).not.toBeNull();
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `filename` INSIDE A STACK FRAME IS A PATH, NOT A FILE NAME
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `filename` is on the shared list because file names are customer intellectual
 * property. In a stack frame it is a bundle URL or one of our own source paths,
 * and censoring it destroys Sentry's `culprit` — the field this module's own
 * doc offers as the compensation for censoring `url`.
 *
 * The exemption is POSITIONAL and needs BOTH conditions, so the assertions come
 * in pairs: inside the zone with a frame marker it survives, and every weakening
 * of either condition is still censored.
 */
describe('a stack frame path', () => {
  function frameEvent(frame: Record<string, unknown>): object {
    return { exception: { values: [{ stacktrace: { frames: [frame] } }] } };
  }

  it('survives inside a real frame, so the culprit survives with it', () => {
    const walked = cleaned(
      frameEvent({ filename: 'app:///_next/static/chunks/page.js', lineno: 12, function: 'Page' }),
    );

    expect(onTheWire(walked)).toContain('app:///_next/static/chunks/page.js');
  });

  it('is censored inside the zone when nothing marks the object as a frame', () => {
    const walked = cleaned(frameEvent({ filename: 'Torre_Bacata_Fase3_Final.stl' }));

    expect(onTheWire(walked)).not.toContain('Torre_Bacata');
  });

  it('is censored when a frame-shaped object sits outside the zone', () => {
    const walked = cleaned({
      extra: { frames: [{ filename: 'Torre_Bacata_Fase3_Final.stl', lineno: 1 }] },
    });

    expect(onTheWire(walked)).not.toContain('Torre_Bacata');
  });

  it("is censored in a frame's own locals, which are data again", () => {
    const walked = cleaned(
      frameEvent({
        filename: 'app:///page.js',
        lineno: 12,
        vars: { filename: 'Torre_Bacata_Fase3_Final.stl' },
      }),
    );

    expect(onTheWire(walked)).toContain('app:///page.js');
    expect(onTheWire(walked)).not.toContain('Torre_Bacata');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A THROW ESCAPING THE WALK IS A FULL-SCOPE PLAINTEXT LEAK
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The worst outcome this module has, and it is not "the event is lost". When
 * `beforeSend` throws, `@sentry/core` (`client.js:590-593`) captures the throw
 * as an INTERNAL event carrying `data.__sentry__ = true`, and that flag
 * short-circuits `processBeforeSend` — so a replacement event goes out with the
 * whole scope attached and nothing redacted at all: `extra`, `tags`, `user`, and
 * the fetch breadcrumb carrying the presigned URL this module exists to stop.
 * The real event is dropped as well. One throw turns the control inside out.
 *
 * So "this function never throws" has to be a control rather than an argument,
 * which in this repository means a fixture that reaches the `catch`.
 */
describe('a throw inside the walk', () => {
  it('yields null rather than escaping into Sentry', async () => {
    vi.resetModules();
    vi.doMock('@metrika/contracts', () => ({
      isRedactedKey: () => {
        throw new Error('matcher exploded');
      },
      redactionCorpus: () => [],
    }));

    const fragile = await import('../src/lib/telemetry/redaction.js');
    const event = { extra: { password: 'hunter2' } };

    expect(() => fragile.redactSentryEvent(event)).not.toThrow();
    expect(fragile.redactSentryEvent(event)).toBeNull();

    vi.doUnmock('@metrika/contracts');
    vi.resetModules();
  });

  /**
   * The two throwers review found live and unguarded, each contained at its own
   * node so one hostile value costs its subtree rather than the report.
   */
  it('contains a revoked Proxy, which makes Array.isArray itself throw', () => {
    const revocable = Proxy.revocable({ password: SECRET }, {});
    revocable.revoke();

    const event = { request: { data: revocable.proxy, other: { password: SECRET } } };
    const walked = cleaned(event);
    const request = walked.request as Record<string, unknown>;

    expect(request['data']).toBe(REDACTION_CENSOR);
    expect((request['other'] as Record<string, unknown>)['password']).toBe(REDACTION_CENSOR);
  });

  it('survives a graph whose own __proto__ properties are cyclic', () => {
    const first: Record<string, unknown> = { name: 'first' };
    const second: Record<string, unknown> = { name: 'second' };
    const shape = { enumerable: true, writable: true, configurable: true };
    Object.defineProperty(first, '__proto__', { ...shape, value: second });
    Object.defineProperty(second, '__proto__', { ...shape, value: first });

    expect(() => cleaned({ request: { data: first } })).not.toThrow();
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `__proto__` IS A LYING SETTER, WHICH IS THE CLASS `write()` WAS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Object.prototype.__proto__` is an accessor, so `output[key] = value` for that
 * one key name sets the prototype and stores nothing. Not a leak — the field is
 * silently DESTROYED — but "there is no such thing as a node that cannot be
 * written" was false for one key name, which is the same shape as the `write()`
 * that reported successes it had not achieved.
 */
describe('an own __proto__ data property', () => {
  function parsed(): unknown {
    // `JSON.parse` is how one really arrives — from a request body — and it is
    // the only literal-looking way to create an own `__proto__` property.
    return JSON.parse('{"__proto__":{"modelId":"mv_1","password":"hunter2"},"keep":"yes"}');
  }

  it('survives as a property instead of becoming a prototype', () => {
    const walked = cleaned({ request: { data: parsed() } });
    const data = (walked.request as Record<string, unknown>)['data'] as object;

    expect(Object.keys(data)).toContain('__proto__');
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect((data as Record<string, unknown>)['keep']).toBe('yes');
  });

  it('is walked like any other value, so what is inside it is still redacted', () => {
    const walked = cleaned({ request: { data: parsed() } });
    const data = (walked.request as Record<string, unknown>)['data'] as object;
    const inherited = Object.getOwnPropertyDescriptor(data, '__proto__')?.value as Record<
      string,
      unknown
    >;

    expect(inherited['modelId']).toBe('mv_1');
    expect(inherited['password']).toBe(REDACTION_CENSOR);
    expect(onTheWire(walked)).not.toContain('hunter2');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ARRAY BREADTH — THE ONE PLACE THE COPY DIVERGES FROM `JSON.stringify`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The copy is dense, because `JSON.stringify` emits a `null` per hole. That also
 * means a declared length materialises: `a.length = 5_000_000` on an array with
 * no elements produced five million entries inside `beforeSend`, measured at
 * 130 ms on an error path.
 *
 * `MAX_BREADTH` is 1000 — `normalizeMaxBreadth`'s default, which Sentry already
 * applies to `extra`, `contexts` and `breadcrumbs[].data` before this hook runs,
 * so the three regions it protects nowhere now get the same guarantee. Both
 * sides of the boundary are pinned, and the truncation is VISIBLE on the wire
 * rather than silent.
 */
describe('array breadth', () => {
  function dataArray(walked: object): unknown[] {
    return (walked as { request: { data: unknown[] } }).request.data;
  }

  it('keeps an array exactly at the cap whole', () => {
    const exact = Array.from({ length: 1000 }, (_, index) => `v${String(index)}`);
    const walked = dataArray(cleaned({ request: { data: exact } }));

    expect(walked.length).toBe(1000);
    expect(walked[999]).toBe('v999');
  });

  it('truncates one past the cap, and says so on the wire', () => {
    const long = Array.from({ length: 1001 }, (_, index) => `v${String(index)}`);
    const walked = dataArray(cleaned({ request: { data: long } }));

    expect(walked.length).toBe(1001);
    expect(walked[999]).toBe('v999');
    expect(walked[1000]).toBe(BREADTH_MARKER);
  });

  it('does not materialise a declared-but-empty length', () => {
    const sparse: unknown[] = [];
    sparse.length = 5_000_000;

    expect(dataArray(cleaned({ request: { data: sparse } })).length).toBe(1001);
  });

  /**
   * The two markers mean OPPOSITE things to an operator — "this sink removed a
   * value" against "more elements were here and none were looked at" — so one
   * token doing both jobs is a lie rather than an economy. Measured with the
   * shared token: `frames[0].vars.vertices` of 2500 shipped ending `[REDACTED]`,
   * which reads as a secret in a vertex buffer.
   */
  it('marks truncation with a token that does not mean redaction', () => {
    expect(BREADTH_MARKER).not.toBe(REDACTION_CENSOR);
    // Sentry's own, `@sentry/core/utils/normalize.js:62`, so the wire carries
    // one vocabulary rather than two.
    expect(BREADTH_MARKER).toBe('[MaxProperties ~]');
  });

  /**
   * Sentry truncates first for the regions it normalises, and the walk then sees
   * an array of 1001 whose last element is already Sentry's marker. Re-truncating
   * must be a no-op in MEANING as well as in length — with the shared token it
   * replaced Sentry's marker with `[REDACTED]`, turning "1500 elements dropped"
   * into "a secret was removed".
   */
  it('does not relabel a truncation Sentry had already marked', () => {
    const preNormalised = [
      ...Array.from({ length: 1000 }, (_, index) => `v${String(index)}`),
      BREADTH_MARKER,
    ];
    const walked = dataArray(cleaned({ request: { data: preNormalised } }));

    expect(walked.length).toBe(1001);
    expect(walked[1000]).toBe(BREADTH_MARKER);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * OBJECT BREADTH IS NOT CAPPED, AND THAT IS THE DECISION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `normalizeMaxBreadth` caps object PROPERTIES as well as array elements, and
 * `MAX_BREADTH` lives only in the array branch — so the three regions Sentry
 * protects nowhere are NOT brought level with the ones it does. An earlier
 * version of the module's comment claimed they were.
 *
 * The asymmetry is deliberate. An array's `length` is a number somebody set, so
 * a dense copy can manufacture five million entries the input never held; an
 * object's key count is what `Object.keys` really returns, so the copy is the
 * same size as the input and there is nothing to amplify. Capping it would drop
 * real data for no safety reason.
 *
 * Pinned here so the code and that paragraph cannot drift apart again — if
 * object breadth is ever capped, this test is the one that has to be changed
 * deliberately.
 */
describe('object breadth', () => {
  it('keeps every property of a wide object in an unprotected region', () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 3000; index += 1) wide[`k${String(index)}`] = index;

    const walked = cleaned({ request: { data: wide } });
    const data = (walked.request as Record<string, unknown>)['data'] as object;

    expect(Object.keys(data).length).toBe(3000);
  });

  it('still redacts by name at any width', () => {
    const wide: Record<string, unknown> = { password: 'hunter2' };
    for (let index = 0; index < 2000; index += 1) wide[`k${String(index)}`] = index;

    const walked = cleaned({ request: { data: wide } });
    const data = (walked.request as Record<string, unknown>)['data'] as Record<string, unknown>;

    expect(data['password']).toBe(REDACTION_CENSOR);
    expect(Object.keys(data).length).toBe(2001);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CELLS DELIBERATELY NOT COVERED, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This list is load-bearing precisely because it is where a reader looks for
 * what was NOT done, so it is kept complete and each entry says what would have
 * to change for the cell to matter. Review found the previous version both
 * incomplete and wrong in one claim; the correction is marked.
 *
 *  - **Symbol keys, non-enumerable properties and inherited properties.** The
 *    walk does not visit them and does not copy them, and `JSON.stringify` never
 *    sent them, so there is nothing on the wire to assert about.
 *  - **`Map`, `Set`, `WeakMap` contents.** Same reason: `JSON.stringify` emits
 *    `{}` for all three. Their entries were never sent and are not sent now.
 *  - **Hostile shapes at the CAP boundary in every region.** The crossing is
 *    covered in `request` only. The cap is region-independent by construction —
 *    it is a counter on the recursion, with no knowledge of where it is — so the
 *    other four cells would be asserting the same line of code four more times.
 *  - **Depth × back-edge in `frames[].vars`.** Covered in `request`, for the same
 *    reason as the cap boundary: neither the memo nor the depth counter can see
 *    the region.
 *  - **`Proxy` traps other than `get`, `ownKeys` and
 *    `getOwnPropertyDescriptor`.** CORRECTED: the previous version of this list
 *    claimed `getOwnPropertyDescriptor` is never consulted, and that is FALSE —
 *    `Object.keys` calls it for every own key, to decide enumerability. It is on
 *    the walk's path, it is inside the `try` that wraps `Object.keys`, and a
 *    throwing one is covered by the revoked-`Proxy` case, which revokes every
 *    trap at once. `has`, `deleteProperty`, `defineProperty` and `apply` are not
 *    reached: the walk never tests membership, never deletes, never defines on
 *    the INPUT, and never calls a function on it other than `toJSON`.
 *  - **`__proto__` at the cap, and `__proto__` crossed with aliasing.** The key
 *    name is handled by `define()`, which is a property of the OUTPUT and
 *    independent of both the depth counter and the memo; the direct cases below
 *    cover the mechanism.
 *  - **Array breadth crossed with anything.** `MAX_BREADTH` truncates before any
 *    element is walked, so the elements past it are never reached by depth,
 *    aliasing or hostility. The boundary itself is pinned on both sides.
 *  - **OBJECT breadth — not covered because it is not capped.** Sentry's
 *    `normalizeMaxBreadth` caps properties as well as elements; this walk caps
 *    only elements, so `request`, `tags` and `frames[].vars` keep every property
 *    of a wide object. Deliberate: an object's key count is what `Object.keys`
 *    really returns, so the copy is the same size as the input and there is
 *    nothing to amplify, whereas an array's `length` is a number somebody set.
 *    The behaviour is pinned in `describe('object breadth')` rather than left
 *    implicit, so capping it later is a deliberate edit with a red test in front
 *    of it.
 *  - **A throw from a place that is not the shared matcher.** The boundary
 *    `try` in `redactSentryEvent` is reached through `isRedactedKey` because
 *    that is the one call the walk makes outside its own guards. Every other
 *    thrower is contained at its node and asserted there; a second route to the
 *    same `catch` would assert the same line twice.
 */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INTEGRATION ALLOWLIST, GRADED AGAINST THE ARRAY `init` ACTUALLY PASSES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The first version of this fixture called the package's EXPORTED
 * `getDefaultIntegrations`, which is `@sentry/react`'s. `init` builds its own
 * array (`client/index.js:85`, `server/index.js:78`), and the difference is the
 * whole point: the real client array carries `BrowserTracing` and
 * `NextjsClientStackFrameNormalization`, and the exported one carries neither.
 * So "BrowserTracing is filtered out" was asserted against a list that never
 * contained it.
 *
 * Captured by calling the real `init` with an `integrations` CALLBACK, which is
 * exactly where Sentry hands the defaults to this application's filter. The
 * callback returns `[]`, so nothing is instantiated or installed.
 *
 * ONE CHILD PROCESS PER CAPTURE, and that is a measured requirement rather than
 * hygiene: `@sentry/nextjs`'s server `init` returns early when
 * `sdkAlreadyInitialized()`, so a second `init` in the same process is silently
 * skipped and the callback is never called. Measured — in-process, the second
 * and third captures came back empty.
 *
 * **THE EXACT COUNTS BELOW (11 / 13 / 17 / 18 / 44) ARE DELIBERATE, AND THEY
 * WILL REDDEN ON A BENIGN UPSTREAM PATCH.** That is the trade this file makes on
 * purpose, and it is the same one `redaction-corpus.json` makes: what a Sentry
 * release adds to the default set is precisely what an allowlist exists to keep
 * out, so "the set changed" has to reach a human rather than be absorbed. The
 * cost is a red test on a version bump that added something harmless; the
 * alternative is an upgrade that quietly starts producing spans from `apps/web`.
 * If that trade is ever judged wrong, replace the counts with named-membership
 * assertions — do not delete them.
 *
 * The CJS build, at an absolute path, because the ESM build imports
 * `next/constants` extensionlessly and Node's resolver rejects it
 * (`ERR_MODULE_NOT_FOUND`).
 *
 * `_sentryRewriteFramesDistDir` IS PASSED DELIBERATELY, and both settings are
 * exercised below. `withSentryConfig` injects it at BUILD time
 * (`server/index.js:88` gates on it), so the server default set is **17 without
 * it and 18 with it** — a fixture that asserted `DistDirRewriteFrames` survives
 * the filter while constructing the set outside a real build would be asserting
 * on an integration that is not there, and would pass for the wrong reason.
 */
const require_ = createRequire(import.meta.url);
const sentryCjs = path.join(
  path.dirname(require_.resolve('@sentry/nextjs/package.json')),
  'build/cjs',
);

interface SentryBuild {
  getDefaultIntegrations: (options: Record<string, unknown>) => { name: string }[];
}

/**
 * The package's EXPORTED helper — what a snapshot test would naturally reach
 * for, and what this fixture exists to avoid. Kept only so the test below can
 * assert that it disagrees with what `init` uses.
 */
function exportedDefaults(
  build: 'index.server.js' | 'index.client.js',
  options: Record<string, unknown>,
): string[] {
  const loaded = require_(path.join(sentryCjs, build)) as SentryBuild;
  return loaded.getDefaultIntegrations(options).map((integration) => integration.name);
}

const CAPTURE = `
  const mod = require(process.argv[1]);
  let captured = [];
  mod.init({
    ...JSON.parse(process.argv[2]),
    dsn: undefined,
    integrations: (defaults) => { captured = defaults.map((i) => i.name); return []; },
  });
  process.stdout.write('__INTEGRATIONS__' + JSON.stringify(captured));
`;

function realDefaults(
  build: 'index.server.js' | 'index.client.js',
  options: Record<string, unknown>,
  { injectDistDir = true }: { injectDistDir?: boolean } = {},
): string[] {
  // The child's environment is stated in full rather than inherited, and not
  // only because `process.env` is off limits outside `src/config/env.ts`: the
  // SDK reads `NEXT_PHASE`, `VERCEL_ENV`, `NODE_ENV` and `SENTRY_*` at init, so
  // an inherited environment would let a developer's shell change which
  // integrations this fixture grades.
  // The key is always PRESENT and empty when it is not wanted, rather than the
  // ternary producing two different object shapes: a union there widens `env`
  // enough that TypeScript stops matching `execFileSync`'s `encoding: 'utf8'`
  // overload and hands back `string | Buffer`. Empty is also exactly the SDK's
  // own gate — `server/index.js:88` tests the value for truthiness.
  const stdout = execFileSync(
    process.execPath,
    ['-e', CAPTURE, path.join(sentryCjs, build), JSON.stringify(options)],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // `NODE_ENV` is not optional here — Next augments `NodeJS.ProcessEnv` to
      // require it — and it is not inert either: the client SDK adds a
      // development-only symbolication processor when it reads `development`.
      env: {
        NODE_ENV: 'test',
        _sentryRewriteFramesDistDir: injectDistDir ? '.next' : '',
      },
    },
  );

  // Delimited rather than parsed whole, so anything the SDK decides to print
  // cannot turn a captured array into a parse error that reads like a defect.
  const marker = stdout.lastIndexOf('__INTEGRATIONS__');
  expect(marker, `no capture in child output: ${stdout}`).toBeGreaterThanOrEqual(0);
  const payload: unknown = JSON.parse(stdout.slice(marker + '__INTEGRATIONS__'.length));

  return z.array(z.string()).parse(payload);
}

describe('keepAllowedIntegrations', () => {
  it('drops an integration that did not exist when this list was written', () => {
    expect(keepAllowedIntegrations([{ name: 'SomeFutureTracingIntegration' }])).toStrictEqual([]);
  });

  /**
   * THE REASON THIS FILE SPAWNS PROCESSES, stated as an assertion rather than a
   * comment. `getDefaultIntegrations` is exported and is NOT the set `init`
   * uses, in both directions — so a snapshot over the export pins neither what
   * ships nor what an upgrade would change:
   *
   *   - client: the export omits `browserTracingIntegration` and
   *     `NextjsClientStackFrameNormalization`, both of which
   *     `client/index.js:85` pushes internally.
   *   - server: `init` REMOVES `Http` and substitutes
   *     `httpIntegration({ disableIncomingRequestSpans: true })`
   *     (`server/index.js:78`), and adds `DistDirRewriteFrames` when the build
   *     injected `_sentryRewriteFramesDistDir`.
   *
   * ADR-0029's snapshot suggestion is still right for `apps/api`'s
   * `@sentry/node`; it does not survive `@sentry/nextjs`.
   */
  it('is graded against a set the exported helper does not report', () => {
    const exportedClient = exportedDefaults('index.client.js', {});
    const realClient = realDefaults('index.client.js', {});

    expect(exportedClient.length).toBe(11);
    expect(realClient.length).toBe(13);
    expect(realClient.filter((name) => !exportedClient.includes(name)).sort()).toStrictEqual([
      'BrowserTracing',
      'NextjsClientStackFrameNormalization',
    ]);

    // The server difference is the build-time injection, and it is conditional:
    // 17 without it, 18 with it. `withSentryConfig` is what supplies it.
    expect(exportedDefaults('index.server.js', {}).length).toBe(17);
    expect(realDefaults('index.server.js', {}, { injectDistDir: false }).length).toBe(17);
    expect(realDefaults('index.server.js', {})).toContain('DistDirRewriteFrames');
    expect(realDefaults('index.server.js', {}).length).toBe(18);
  });

  /**
   * The exclusion, asserted against the array `Sentry.init` really builds. The
   * previous form of this — `expect(ALLOWED_INTEGRATION_NAMES).not.toContain(…)`
   * — is a string absence, and would pass just as happily if `BrowserTracing`
   * had been renamed upstream and were arriving under another name entirely.
   */
  it('drops BrowserTracing from the real client defaults, and nothing else', () => {
    const real = realDefaults('index.client.js', {});
    const kept = keepAllowedIntegrations(real.map((name) => ({ name }))).map((i) => i.name);

    expect(real).toContain('BrowserTracing');
    expect(real).toContain('NextjsClientStackFrameNormalization');
    expect(real.filter((name) => !kept.includes(name))).toStrictEqual(['BrowserTracing']);
  });

  /**
   * `NextjsClientStackFrameNormalization` and `DistDirRewriteFrames` have no
   * exported factory, so `defaultIntegrations: false` plus a list of
   * constructions — the other way to write an allowlist, and the one ADR-0029
   * obligation 2 asks for literally — cannot bring them back. Applying the
   * allowlist as a FILTER is what keeps them, and this is the assertion that
   * says so.
   */
  it('keeps the two SDK-internal integrations that have no exported factory', () => {
    // Neither has one: only `rewriteFramesIntegration` is public, and
    // `'distDirRewriteFramesIntegration' in Sentry` is false on both builds.
    const client = require_(path.join(sentryCjs, 'index.client.js')) as Record<string, unknown>;
    const server = require_(path.join(sentryCjs, 'index.server.js')) as Record<string, unknown>;

    expect('nextjsClientStackFrameNormalizationIntegration' in client).toBe(false);
    expect('distDirRewriteFramesIntegration' in server).toBe(false);

    const keptClient = keepAllowedIntegrations(
      realDefaults('index.client.js', {}).map((name) => ({ name })),
    ).map((i) => i.name);
    const keptServer = keepAllowedIntegrations(
      // The build-time injection is required for this one to exist at all.
      realDefaults('index.server.js', {}).map((name) => ({ name })),
    ).map((i) => i.name);

    expect(keptClient).toContain('NextjsClientStackFrameNormalization');
    expect(keptServer).toContain('DistDirRewriteFrames');
  });

  it('keeps every error-side default the server SDK ships with tracing off', () => {
    const real = realDefaults('index.server.js', {});
    const kept = keepAllowedIntegrations(real.map((name) => ({ name }))).map((i) => i.name);

    expect(kept).toStrictEqual(real);
    expect(real.length).toBeGreaterThan(10);
  });

  it('drops every span-producing integration the server SDK offers under tracing', () => {
    const real = realDefaults('index.server.js', { tracesSampleRate: 1 });
    const kept = keepAllowedIntegrations(real.map((name) => ({ name }))).map((i) => i.name);

    // ADR-0029's number, reproduced. `DistDirRewriteFrames` is the Next SDK's
    // own addition on top of `@sentry/node`'s set, so it is subtracted rather
    // than folded in — the 44 is a claim about the Node SDK.
    expect(real.filter((name) => name !== 'DistDirRewriteFrames').length).toBe(44);

    for (const spanProducing of ['Fastify', 'Express', 'Postgres', 'Prisma', 'Redis', 'Mongo']) {
      expect(real).toContain(spanProducing);
      expect(kept).not.toContain(spanProducing);
    }

    // Enabling tracing adds only span producers, so the kept set is unchanged
    // from the bare one — which is what makes "no traces from apps/web" a
    // property of the allowlist rather than of `tracesSampleRate` being unset.
    expect(kept).toStrictEqual(realDefaults('index.server.js', {}));
  });

  /**
   * No DEAD entries. A name in the allowlist that no runtime ships is either a
   * typo or a leftover from a version bump, and it silently protects nothing —
   * the same shape as a redaction path nothing matches.
   */
  it('names nothing that no runtime actually ships', () => {
    const shipped = new Set([
      ...realDefaults('index.client.js', {}),
      ...realDefaults('index.server.js', { tracesSampleRate: 1 }),
    ]);

    expect(ALLOWED_INTEGRATION_NAMES.filter((name) => !shipped.has(name))).toStrictEqual([]);
  });
});
