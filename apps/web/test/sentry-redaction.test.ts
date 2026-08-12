import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { redactionCorpus } from '@metrika/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REDACTION_CENSOR, redactSentryEvent } from '../src/lib/telemetry/redaction.js';
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
    const serialised = JSON.stringify(cleaned(sampleEvent()));

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

  it('returns the same object, which is what Sentry expects from beforeSend', () => {
    const event = sampleEvent();

    expect(redactSentryEvent(event)).toBe(event);
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

    expect(JSON.stringify(cleaned(event))).not.toContain('hunter2');
  });

  it('censors a subtree past the cap — stack frame local variables', () => {
    const event = {
      exception: {
        values: [{ stacktrace: { frames: [{ vars: { local: nest(12, { token: 'tok_1' }) } }] } }],
      },
    };

    expect(JSON.stringify(cleaned(event))).not.toContain('tok_1');
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
    const walked = JSON.stringify(cleaned(event));

    expect(walked).not.toContain('hunter2');
    expect(walked).toContain('mv_1');
  });

  it('destroys a benign sibling one level past it, which is the cost of the number', () => {
    const event = { request: { data: nest(11, { password: 'hunter2', modelId: 'mv_1' }) } };
    const walked = JSON.stringify(cleaned(event));

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

    expect(JSON.stringify(cleaned(event))).not.toContain('hunter2');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PROPERTIES THAT CANNOT BE WRITTEN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A frozen object or a setter-less getter makes the assignment throw, and an
 * exception escaping `beforeSend` makes Sentry drop the event — fail-closed for
 * the leak, and a silently lost report. The walk censors the unwritable node in
 * its PARENT instead, so one frozen object costs its own subtree rather than the
 * whole report.
 */
describe('unwritable properties', () => {
  it('censors a frozen node in its parent, and still delivers the event', () => {
    const event = { extra: { payload: Object.freeze({ password: 'hunter2', modelId: 'mv_1' }) } };

    const walked = cleaned(event);

    expect(JSON.stringify(walked)).not.toContain('hunter2');
    expect((walked.extra as Record<string, unknown>)['payload']).toBe(REDACTION_CENSOR);
  });

  it('censors a node whose redacted property is a getter with no setter', () => {
    const payload: Record<string, unknown> = { modelId: 'mv_1' };
    Object.defineProperty(payload, 'password', { get: () => 'hunter2', enumerable: true });
    const event = { extra: { payload } };

    const walked = cleaned(event);

    expect(JSON.stringify(walked)).not.toContain('hunter2');
    expect((walked.extra as Record<string, unknown>)['payload']).toBe(REDACTION_CENSOR);
  });

  it('censors a node whose getter throws, rather than letting it escape beforeSend', () => {
    const payload: Record<string, unknown> = { modelId: 'mv_1' };
    Object.defineProperty(payload, 'boom', {
      get: () => {
        throw new Error('getter exploded');
      },
      enumerable: true,
    });
    const event = { extra: { payload } };

    expect(() => cleaned(event)).not.toThrow();
    expect((cleaned({ extra: { payload } }).extra as Record<string, unknown>)['payload']).toBe(
      REDACTION_CENSOR,
    );
  });

  /**
   * The last resort, and the only case that drops the report: the EVENT object
   * itself could not be written to, so there is nowhere to put the censor.
   * `null` is Sentry's "do not send", which is the right answer for an event
   * this function was unable to clean.
   */
  it('drops the event when the root itself cannot be cleaned', () => {
    const event = Object.freeze({ password: 'hunter2' });

    expect(redactSentryEvent(event)).toBeNull();
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ALIASES OF AN UNCLEANABLE NODE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The cases the block above CANNOT catch, and the regression that got through
 * because of it: every fixture up there holds a single reference, so a walk that
 * censored the first encounter and returned every later one verbatim passed all
 * of them.
 *
 * Measured at the transport before the fix, with
 * `const F = Object.freeze({ password: 'hunter2' })`: four aliases of `F`
 * produced one `[REDACTED]` and three verbatim copies. The premise was that
 * entering a node implies cleaning it — true for the depth path once it censors,
 * false for every path where the node cannot be written to at all.
 *
 * These live in `request` and in `frames[].vars` deliberately. `extra` and
 * `contexts` cannot reproduce it: Sentry's `normalize` REBUILDS them before
 * `beforeSend`, so what arrives there is a fresh unfrozen tree with the aliasing
 * already gone — measured, an `extra` alias is `{aliased: false, frozen: false}`
 * inside this hook while a `request` alias is `{aliased: true, frozen: true}`.
 * A fixture written in `extra` would be green for a reason that has nothing to
 * do with this code.
 *
 * React freezes props in development, so a frozen object reaching a stack
 * frame's locals is ordinary rather than adversarial.
 */
describe('aliases of a node that cannot be cleaned', () => {
  function frozenSecret(): Record<string, unknown> {
    return Object.freeze({ password: 'hunter2', modelId: 'mv_1' });
  }

  function getterSecret(): Record<string, unknown> {
    const node: Record<string, unknown> = { modelId: 'mv_1' };
    Object.defineProperty(node, 'password', { get: () => 'hunter2', enumerable: true });
    return node;
  }

  /**
   * Uncleanable through the READ rather than the write, which is a different
   * code path — and `boom` is defined FIRST on purpose. `Object.keys` is
   * insertion-ordered, so the throw happens before the walk reaches `password`;
   * with the key order reversed the secret would already have been censored and
   * the case would pass without exercising anything.
   */
  function throwingGetterSecret(): Record<string, unknown> {
    const node: Record<string, unknown> = {};
    Object.defineProperty(node, 'boom', {
      get: () => {
        throw new Error('getter exploded');
      },
      enumerable: true,
    });
    node['password'] = 'hunter2';
    node['modelId'] = 'mv_1';
    return node;
  }

  const shapes: readonly [string, () => Record<string, unknown>][] = [
    ['a frozen object', frozenSecret],
    ['a setter-less getter', getterSecret],
    ['a getter that throws', throwingGetterSecret],
  ];

  describe.each(shapes)('%s', (_label, make) => {
    it('is censored at a sibling alias, whichever comes first', () => {
      const node = make();

      expect(JSON.stringify(cleaned({ request: { x: node, y: { z: node } } }))).not.toContain(
        'hunter2',
      );
      expect(JSON.stringify(cleaned({ request: { a: { z: make() }, b: make() } }))).not.toContain(
        'hunter2',
      );
    });

    it('is censored at a nested alias in the reversed order', () => {
      const node = make();

      expect(JSON.stringify(cleaned({ request: { a: { z: node }, b: node } }))).not.toContain(
        'hunter2',
      );
    });

    it('is censored across separate stack frames', () => {
      const node = make();
      const event = {
        exception: {
          values: [
            {
              stacktrace: {
                frames: [{ vars: { a: node } }, { vars: { b: node } }],
              },
            },
          ],
        },
      };

      expect(JSON.stringify(cleaned(event))).not.toContain('hunter2');
    });

    /**
     * The count, not just the absence: the measured failure produced ONE
     * `[REDACTED]` and three verbatim copies, so an assertion that only greps
     * for the secret would have caught it — but an assertion that counts says
     * what the fix actually guarantees.
     */
    it('censors every alias, not only the first', () => {
      const node = make();
      const walked = cleaned({ request: { w: node, x: node, y: node, z: node } });
      const request = walked.request as Record<string, unknown>;

      expect(Object.values(request)).toStrictEqual([
        REDACTION_CENSOR,
        REDACTION_CENSOR,
        REDACTION_CENSOR,
        REDACTION_CENSOR,
      ]);
    });
  });

  /**
   * The ARRAY branch keeps its own copy of the outcome record, and it fails in
   * its own way — which is why it needs its own fixtures rather than riding on
   * the object ones.
   *
   * A frozen array is NOT enough on its own: an element that is merely censored
   * in place keeps its identity, nothing is written, and the walk succeeds. It
   * takes an element that must be REPLACED — a frozen object, or an index whose
   * getter throws — for the array itself to become uncleanable.
   */
  const arrayShapes: readonly [string, () => unknown[]][] = [
    [
      'a frozen array holding a frozen object',
      () => Object.freeze([Object.freeze({ password: 'hunter2' })]) as unknown as unknown[],
    ],
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
        items[1] = { password: 'hunter2' };
        return items;
      },
    ],
  ];

  describe.each(arrayShapes)('%s', (_label, make) => {
    it('is censored at every alias', () => {
      const items = make();

      expect(JSON.stringify(cleaned({ request: { x: items, y: { z: items } } }))).not.toContain(
        'hunter2',
      );
      expect(JSON.stringify(cleaned({ request: { a: { z: make() }, b: make() } }))).not.toContain(
        'hunter2',
      );
    });

    it('is censored across separate stack frames', () => {
      const items = make();
      const event = {
        exception: {
          values: [{ stacktrace: { frames: [{ vars: { a: items } }, { vars: { b: items } }] } }],
        },
      };

      expect(JSON.stringify(cleaned(event))).not.toContain('hunter2');
    });
  });

  /**
   * The other direction, so the outcome map cannot be "censor everything seen
   * twice": a CLEAN node reached through several aliases stays itself.
   */
  it('leaves a clean node alone at every alias', () => {
    const node: Record<string, unknown> = { modelId: 'mv_1' };
    const walked = cleaned({ request: { x: node, y: { z: node } } });
    const request = walked.request as { x: unknown; y: { z: unknown } };

    expect(request.x).toBe(node);
    expect(request.y.z).toBe(node);
  });
});

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
