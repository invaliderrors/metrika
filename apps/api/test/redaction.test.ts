import { RedactedFieldName, redactionCorpus } from '@metrika/contracts';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  REDACTION_CENSOR,
  REDACTION_PATHS,
  redactLogObject,
} from '../src/infrastructure/telemetry/redaction.js';
import { captureLogger } from './log-capture.js';

const CORPUS = redactionCorpus();

/**
 * THE TWO HALVES OF THIS SINK, and why the suite is split the way it is.
 *
 * `apps/api` closes the same control with two mechanisms because neither
 * reaches what the other does — MEASURED, `pino@10.3.1`:
 *
 *   - `redact.paths` reaches a CHILD BINDING (`logger.child({ signedUrl })`)
 *     and the non-enumerable `err.message` / `err.stack`. `formatters.log` is
 *     never called for either.
 *   - `formatters.log` reaches every SPELLING of a name — `signed_url`,
 *     `SIGNED_URL`, `presignedUrls`, `signedURLs2` — and any depth, because it
 *     walks with `isRedactedKey`. A path is a literal string, so
 *     `signedUrl` does not imply `signed_url` and no derivation of seventeen
 *     names could produce the 956 spellings the corpus declares.
 *
 * **TWO leaks lived in the gap between those two rows, and the shape of this
 * file is what hid both.** The first version asserted bindings in the canonical
 * spelling and non-canonical spellings in a merged object — the SUM of the two
 * dimensions — so `logger.child({ signed_url })`, their PRODUCT, was reached by
 * neither mechanism and went out verbatim with every fixture green. The fix
 * then covered `child` and shipped, and `setBindings({ signed_url })` leaked in
 * exactly the same way: enumerating the instance that had just been found
 * rather than the dimension it belonged to. Both MEASURED through the real
 * `createLogger`.
 *
 * `createLogger` now puts BOTH binding methods through the walk, and the corpus
 * is graded through six cells rather than one — see the dimension table below.
 *
 * **What that means for the derived paths, stated rather than implied:** once
 * the walk reaches bindings too, `REDACTION_PATHS`'s derived entries no longer
 * have any shape to themselves — the walk catches the same keys, in more
 * spellings, at more depths. Their behavioural contribution is `err.message`
 * and `err.stack`, which are non-enumerable and which no walk can see, plus a
 * backstop in the canonical spelling if the walk is ever removed or bypassed.
 * So the derivation is asserted STRUCTURALLY below (the paths are the shared
 * enum, at two depths) and the leak assertions are behavioural. Removing a
 * derived path turns this file red at the structural assertion and not at a
 * leak, and that is a property of defence in depth rather than a weak fixture.
 */
describe('REDACTION_PATHS', () => {
  it('is derived from RedactedFieldName rather than authored', () => {
    // The property, stated as an equality rather than as a spot check: the set
    // of bare paths IS the shared enum. A hand-written array that drifts by one
    // name — the failure this whole arrangement exists to prevent — fails here,
    // and a name added to `RedactedFieldName` needs no edit to this file.
    const bare = REDACTION_PATHS.filter((path) => !path.includes('.'));

    expect([...bare].sort()).toStrictEqual([...RedactedFieldName.options].sort());
  });

  it('carries two depths per name, because a path is not a name', () => {
    // `password` and `*.password` are different rules and neither implies the
    // other.
    for (const name of RedactedFieldName.options) {
      expect(REDACTION_PATHS).toContain(name);
      expect(REDACTION_PATHS).toContain(`*.${name}`);
    }
  });

  /**
   * A third depth was here and was REMOVED, and this asserts the removal so it
   * is not re-added on the reasoning that put it there.
   *
   * It was added because `pino-http` puts headers at
   * `req.headers.authorization` — depth 3 — and two forms let that header out
   * verbatim. That measurement is correct **of the paths in isolation**, which
   * is not what ships: the walk reaches the same key, and the assertion two
   * describes below proves it still does. Meanwhile `*.*.name` was measured
   * making `@pinojs/redact` THROW on a `Buffer`, losing the line entirely.
   */
  it('carries no third depth, which was redundant and could lose a line', () => {
    for (const name of RedactedFieldName.options) {
      expect(REDACTION_PATHS).not.toContain(`*.*.${name}`);
    }
  });

  it('carries ADR-0029 obligation 7, which no derivation could produce', () => {
    // `message` and `stack` are not field names on the shared list and must not
    // be — `*.message` would censor every domain error detail one level deep.
    // They are `err`-scoped paths, and they are the reason an unhandled 500's
    // stack no longer reaches the sink.
    expect(REDACTION_PATHS).toContain('err.message');
    expect(REDACTION_PATHS).toContain('err.stack');
    expect(REDACTION_PATHS).toHaveLength(RedactedFieldName.options.length * 2 + 2);
  });
});

/**
 * Every rejection below goes through a CHILD BINDING, at each of the three
 * depths a derived path distinguishes. Both mechanisms cover this shape now, so
 * these are the CATEGORY assertions the task brief names — one per class of
 * field, each carrying the reason that class is on the list — rather than the
 * mutation witnesses for the paths, which are structural and are above.
 */
describe('the categories, through a child binding at every depth', () => {
  function childLine(bindings: Record<string, unknown>): Record<string, unknown> {
    const captured = captureLogger();
    captured.logger.child(bindings).info('a line');
    return captured.only();
  }

  it('censors the two headers that are credentials, three levels down', () => {
    const line = childLine({
      req: { headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9', cookie: 'session=abc' } },
    });

    expect(JSON.stringify(line)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(JSON.stringify(line)).not.toContain('session=abc');
  });

  it('censors password, token and webhookSecret', () => {
    const line = childLine({
      password: 'hunter2',
      auth: { token: 'tok_visa_4242' },
      stripe: { hook: { webhookSecret: 'whsec_livekey' } },
    });

    const serialised = JSON.stringify(line);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('tok_visa_4242');
    expect(serialised).not.toContain('whsec_livekey');
  });

  /**
   * **A SIGNED URL IN A LOG IS A LEAKED MODEL.** `X-Amz-Signature` is a bearer
   * token for the object until it expires, so anyone who can read the log can
   * download the customer's geometry — no session, no authorization check, no
   * trace. That is why all four spellings are on the shared list and why the
   * same field is redacted in Pino here, in structlog in `apps/workers`, and in
   * Sentry's `beforeSend` in `apps/web`.
   */
  it('censors every spelling of a signed URL', () => {
    const presigned = 'https://s3.example/metrika/uploads/abc.stl?X-Amz-Signature=DEADBEEF';
    const line = childLine({
      signedUrl: presigned,
      upload: { presignedUrl: presigned, uploadUrl: presigned },
      result: { artefact: { downloadUrl: presigned } },
    });

    expect(JSON.stringify(line)).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(line)).not.toContain('DEADBEEF');
  });

  it('censors a provider payload and a payment payload', () => {
    // Whole payloads rather than named fields: what a PSP puts in one is its
    // decision, not ours, and it has included a PAN, a CVV and a full billing
    // address in different versions of the same webhook.
    const line = childLine({
      providerPayload: { card: '4242424242424242' },
      payment: { paymentPayload: { cvv: '123' } },
    });

    const serialised = JSON.stringify(line);
    expect(serialised).not.toContain('4242424242424242');
    expect(serialised).not.toContain('123');
  });

  /**
   * **FILE NAMES AND PROJECT NAMES ARE CUSTOMER INTELLECTUAL PROPERTY.**
   * `Torre_Bacatá_Fase3_Final.stl` in a log line tells an observer what an
   * architect is working on, for whom, and how far along it is — before the
   * building is announced. The model ID is the identifier that belongs in a
   * log; the name belongs to the customer.
   */
  it('censors file names and project names', () => {
    const line = childLine({
      filename: 'Torre_Bacata_Fase3_Final.stl',
      model: { originalFilename: 'Torre_Bacata_Fase3_Final.stl', fileName: 'confidencial.3mf' },
      projectName: 'Edificio Confidencial',
    });

    const serialised = JSON.stringify(line);
    expect(serialised).not.toContain('Torre_Bacata');
    expect(serialised).not.toContain('confidencial.3mf');
    expect(serialised).not.toContain('Edificio Confidencial');
  });

  /**
   * The cost of the bare `url` entry, asserted rather than discovered in a
   * dashboard. `packages/contracts/src/redaction.ts` records the trade and
   * `apps/web` has already paid it for `event.request.url`; the answer is the
   * same one on this side, and the second half of it is the assertion below.
   */
  it('censors req.url, which is why the request path is emitted as requestPath', () => {
    const line = childLine({
      req: { url: '/api/v1/models/mv_1?token=abc' },
      requestPath: '/api/v1/models/:id',
    });

    expect(JSON.stringify(line['req'])).toBe(JSON.stringify({ url: REDACTION_CENSOR }));
    expect(line['requestPath']).toBe('/api/v1/models/:id');
  });

  it('leaves the correlation fields alone, or a correlated line loses its correlation', () => {
    const line = childLine({
      requestId: 'req_01H',
      traceId: '4bf92f',
      spanId: '00f067',
      organizationId: 'org_1',
      cacheKey: 'sha256:deadbeef',
      modelId: 'mv_1',
    });

    expect(line['requestId']).toBe('req_01H');
    expect(line['traceId']).toBe('4bf92f');
    expect(line['spanId']).toBe('00f067');
    expect(line['organizationId']).toBe('org_1');
    expect(line['cacheKey']).toBe('sha256:deadbeef');
    expect(line['modelId']).toBe('mv_1');
  });

  /**
   * The shape that leaked, kept as its own named case because a corpus loop
   * failing tells you 956 things and this tells you one.
   *
   * `formatters.log` is never called for a child binding and `REDACTION_PATHS`
   * matches literal names, so before `redactChildBindings` these three went out
   * verbatim while every other fixture in this file was green.
   */
  it.each(['signed_url', 'SIGNED_URL', 'presigned_urls'])(
    'censors %s in a child binding, which neither mechanism reached on its own',
    (spelling) => {
      const captured = captureLogger();

      captured.logger.child({ [spelling]: 'SECRET-VALUE' }).info('a line');

      expect(captured.raw()).not.toContain('SECRET-VALUE');
    },
  );

  /**
   * The SECOND cell of the same product, and the one the first fix missed by
   * covering the mechanism it had been shown instead of the dimension.
   * `setBindings` is pino's other way to create a binding, and it took the
   * identical route out: `formatters.log` never sees it and the paths carry only
   * the canonical spelling.
   */
  it.each(['signed_url', 'SIGNED_URL', 'presigned_urls'])(
    'censors %s in a setBindings binding, for the same reason',
    (spelling) => {
      const captured = captureLogger();

      captured.logger.setBindings({ [spelling]: 'SECRET-VALUE' });
      captured.logger.info('a line');

      expect(captured.raw()).not.toContain('SECRET-VALUE');
    },
  );

  /**
   * (binding mechanism × Error container) — the cell the top-level `err`
   * exemption in `redactLogObject` could have reopened, since a binding also
   * goes through that function and its `err` key is exempted there too.
   * MEASURED safe: pino applies `serializers` to bindings as well, so the
   * exempted Error still meets `serialiseError`. Asserted because "safe by a
   * coincidence of two mechanisms" is exactly what stops being true quietly.
   */
  it.each(['child', 'setBindings'] as const)(
    'reduces an Error bound at err through %s',
    (mechanism) => {
      const captured = captureLogger();
      const error = Object.assign(new Error('boom'), { signed_url: 'SECRET-VALUE' });

      if (mechanism === 'child') captured.logger.child({ err: error }).info('a line');
      else {
        captured.logger.setBindings({ err: error });
        captured.logger.info('a line');
      }

      expect(captured.raw()).not.toContain('SECRET-VALUE');
      expect(captured.raw()).toContain('frames');
    },
  );

  it('keeps setBindings usable — ordinary data through, caller object untouched', () => {
    const captured = captureLogger();
    const bindings = { requestId: 'req_01H', signed_url: 'https://s3/a?X-Amz-Signature=DEADBEEF' };

    captured.logger.setBindings(bindings);
    captured.logger.info('a line');

    expect(captured.only()['requestId']).toBe('req_01H');
    expect(bindings.signed_url).toContain('DEADBEEF');
  });

  it('still lets a child binding carry ordinary data through unchanged', () => {
    const captured = captureLogger();

    captured.logger
      .child({ context: 'DomainExceptionFilter', attempt: 3, upload: { modelId: 'mv_1' } })
      .info('a line');
    const line = captured.only();

    expect(line['context']).toBe('DomainExceptionFilter');
    expect(line['attempt']).toBe(3);
    expect(line['upload']).toStrictEqual({ modelId: 'mv_1' });
  });

  /**
   * The assertion whose absence let a regression through: the first version of
   * the child wrap delegated to a logger bound at wrap time, and pino builds a
   * child with `Object.create(this)` — so the inherited wrapper sent
   * `child(a).child(b)` back to the ROOT and `a` vanished. Redaction stayed
   * perfect and a correlation field disappeared from every line beneath it.
   */
  it('keeps a parent binding when a child is chained', () => {
    const captured = captureLogger();

    captured.logger.child({ organizationId: 'org_1' }).child({ modelId: 'mv_1' }).info('a line');
    const line = captured.only();

    expect(line['organizationId']).toBe('org_1');
    expect(line['modelId']).toBe('mv_1');
  });

  it('does not mutate the bindings the caller passed to child()', () => {
    const captured = captureLogger();
    const bindings = { signed_url: 'https://s3.example/a?X-Amz-Signature=DEADBEEF' };

    captured.logger.child(bindings).info('a line');

    expect(bindings.signed_url).toContain('DEADBEEF');
  });
});

/**
 * The walk, graded against the 956 verdicts `pnpm contracts:emit` declares.
 *
 * Every row goes through the REAL logger at a depth NO derived path reaches
 * (`*` is single-level and the deepest derived form is `*.*.name`), so nothing
 * here can be passing because of `redact.paths`. The verdicts are DECLARED
 * rather than computed from the rule, which is what stops this from being two
 * wrong implementations agreeing with each other.
 */
describe('the walk, graded against the declared corpus', () => {
  it('is not empty and states both verdicts, so the loops below cannot be vacuous', () => {
    expect(CORPUS.length).toBeGreaterThan(100);
    expect(CORPUS.some((row) => row.redacted)).toBe(true);
    expect(CORPUS.some((row) => !row.redacted)).toBe(true);
  });

  /**
   * THE PRODUCT, NOT THE SUM — and this table is the DIMENSION, enumerated,
   * rather than the instances somebody was shown.
   *
   * Two leaks came out of this exact gap, one after the other, and the second is
   * the one that matters: the fix for the first enumerated the mechanism it had
   * just been handed (`child`) instead of enumerating the dimension (how a
   * binding gets created), so `setBindings({ signed_url })` was still going out
   * verbatim with the whole suite green.
   *
   * The dimension is BINDING MECHANISM, and pino has exactly two methods that
   * create one — `child` and `setBindings`. `base` is set by `createLogger`
   * itself and a `mixin`'s output is merged before `formatters.log` runs, so both
   * are walked by construction; neither is configurable through `createLogger`,
   * which is what makes "two" a complete count rather than a count of what was
   * thought of. Crossed with NESTING — top level, and below any derived path —
   * that is the six cells below, and all 956 corpus rows go through every one.
   *
   * Cells deliberately NOT crossed into this table, so the gaps are declared
   * rather than discovered: container type (object / array / Error / self
   * serialising / getter / cycle) and call shape (which argument carries the
   * error). Crossing either into 956 rows buys repetition rather than coverage —
   * the walk reaches a key the same way whatever holds it — so container type is
   * covered against a representative redacted key in `redactLogObject` below,
   * and call shape in `logger.test.ts`.
   */
  const SHAPES: Readonly<Record<string, (logger: Logger, key: string) => void>> = {
    merged: (logger, key) => {
      logger.info({ [key]: 'SECRET-VALUE' }, 'merged');
    },
    deep: (logger, key) => {
      logger.info({ a: { b: { c: { [key]: 'SECRET-VALUE' } } } }, 'deep');
    },
    child: (logger, key) => {
      logger.child({ [key]: 'SECRET-VALUE' }).info('child');
    },
    setBindings: (logger, key) => {
      logger.setBindings({ [key]: 'SECRET-VALUE' });
      logger.info('setBindings');
    },
    setBindingsDeep: (logger, key) => {
      logger.setBindings({ a: { b: { c: { [key]: 'SECRET-VALUE' } } } });
      logger.info('setBindings deep');
    },
    grandchild: (logger, key) => {
      logger
        .child({ a: 1 })
        .child({ nested: { [key]: 'SECRET-VALUE' } })
        .info('grandchild');
    },
  };

  const SHAPE_NAMES = Object.keys(SHAPES);

  /**
   * `level` is not a redaction verdict on the FLAT binding shapes and must not
   * be graded as one: pino READS `bindings.level` as the logger's level rather
   * than emitting it, so the value never reaches the line and "absent" cannot be
   * told apart from "censored". It is a `MUST_SURVIVE` row and it is graded
   * through the other four shapes, which is why this exclusion is one key rather
   * than a category.
   */
  const RESERVED_BY_PINO_BINDINGS = new Set(['level']);
  const FLAT_BINDING_SHAPES = new Set(['child', 'setBindings']);

  function rowsFor(shape: string): typeof CORPUS {
    return FLAT_BINDING_SHAPES.has(shape)
      ? CORPUS.filter((row) => !RESERVED_BY_PINO_BINDINGS.has(row.key))
      : CORPUS;
  }

  function verdictFor(shape: string, key: string): boolean {
    const captured = captureLogger();
    // Non-null: `shape` comes from `Object.keys(SHAPES)`, and
    // `noUncheckedIndexedAccess` cannot see that.
    (SHAPES[shape] as (logger: Logger, key: string) => void)(captured.logger, key);
    return !captured.raw().includes('SECRET-VALUE');
  }

  it.each(SHAPE_NAMES)('censors every key the corpus redacts, as a %s binding', (shape) => {
    const missed = rowsFor(shape)
      .filter((row) => row.redacted && !verdictFor(shape, row.key))
      .map((row) => row.key);

    expect(missed, 'these keys reached the sink and were written down').toStrictEqual([]);
  });

  it.each(SHAPE_NAMES)('leaves every key the corpus keeps, as a %s binding', (shape) => {
    const overreached = rowsFor(shape)
      .filter((row) => !row.redacted && verdictFor(shape, row.key))
      .map((row) => row.key);

    expect(overreached, 'a control that censors these costs real debuggability').toStrictEqual([]);
  });

  it('reaches keys inside arrays, which is where a batch step puts its presigned URLs', () => {
    const captured = captureLogger();

    captured.logger.info({ uploads: [{ presigned_urls: ['SECRET-VALUE'] }] }, 'batch');

    expect(captured.raw()).not.toContain('SECRET-VALUE');
  });
});

describe('redactLogObject', () => {
  it('does not mutate the object the caller passed', () => {
    // MEASURED, and the reason this walk rebuilds instead of censoring in
    // place: an in-place walk turned the CALLER's object into
    // `{ password: '[REDACTED]' }` after `logger.info(payload, 'x')` returned.
    // A logger that silently edits the data it was handed is a logger that
    // changes program behaviour.
    const payload = { password: 'hunter2', nested: { token: 'tok_1' } };

    redactLogObject(payload);

    expect(payload.password).toBe('hunter2');
    expect(payload.nested.token).toBe('tok_1');
  });

  it('passes the TOP-LEVEL err through untouched, so the err serialiser sees one', () => {
    // Rebuilding an Error into a plain object destroys it before pino's `err`
    // serialiser runs — MEASURED: `type` disappeared and every stack frame with
    // it. That ONE Error belongs to the serialiser.
    const error = new Error('boom');

    expect(redactLogObject({ err: error })['err']).toBe(error);
  });

  /**
   * THE CONTAINER-TYPE DIMENSION, which the corpus table deliberately does not
   * cross into 956 rows — so it is enumerated here instead, against one
   * representative redacted key.
   *
   * The `err` exemption above is the only Error pino's serialiser reaches, and
   * every OTHER Error was being passed through with its own enumerable
   * properties intact. MEASURED leaking, all three: a differently-named key, an
   * `err` nested below the top level (canonical spelling, depth 4 — so the paths
   * did not reach it either), and inside an array, which is the AggregateError
   * shape.
   */
  it.each([
    ['a differently-named key', (e: Error) => ({ myError: e })],
    ['an err nested below the top level', (e: Error) => ({ a: { b: { err: e } } })],
    ['inside an array', (e: Error) => ({ errs: [e] })],
    ['inside a self-serialising value', (e: Error) => ({ at: { toJSON: () => ({ e }) } })],
  ])('reduces an Error found at %s', (_label, build) => {
    const error = Object.assign(new Error('boom'), { signed_url: 'SECRET-VALUE' });

    const walked = JSON.stringify(redactLogObject(build(error)));

    expect(walked).not.toContain('SECRET-VALUE');
    // Reduced rather than deleted: the frames are what an operator is left with.
    expect(walked).toContain('frames');
  });

  it('walks a self-serialising value rather than trusting it', () => {
    // `Date` and `Buffer` have no own enumerable keys, so a walk that rebuilt
    // them from their keys would emit `{}` — but passing them through untouched
    // was a NAMED HOLE (a toJSON returning something sensitive) and, measured,
    // a Buffer reaching `@pinojs/redact` under a wildcard path degrades the
    // field to an error string and under two throws the line away entirely.
    const sneaky = { toJSON: (): unknown => ({ password: 'SECRET-VALUE', keep: 1 }) };

    const walked = redactLogObject({ sneaky }) as { sneaky: Record<string, unknown> };

    expect(walked.sneaky['password']).toBe(REDACTION_CENSOR);
    expect(walked.sneaky['keep']).toBe(1);
  });

  it('survives a toJSON that throws, and a toJSON that returns its own receiver', () => {
    const throwing = {
      toJSON: (): unknown => {
        throw new Error('nope');
      },
    };
    const selfReferential: { toJSON: () => unknown } = { toJSON: (): unknown => selfReferential };

    expect(redactLogObject({ throwing })['throwing']).toBe(REDACTION_CENSOR);
    expect(() => redactLogObject({ selfReferential })).not.toThrow();
  });

  it('fails CLOSED on a getter that throws, rather than out of logger.info()', () => {
    // MEASURED: `Object.entries` invokes getters, and a throwing one propagated
    // straight out of `logger.info()`. Baseline pino survives one, so this walk
    // must too — and a value that cannot be inspected cannot be cleared, so the
    // censor is the answer rather than the original.
    const payload = {
      boom: {
        get detail(): string {
          throw new Error('getter');
        },
      },
    };

    const walked = redactLogObject(payload) as { boom: Record<string, unknown> };

    expect(walked.boom['detail']).toBe(REDACTION_CENSOR);
  });

  it('terminates on a cycle and still censors', () => {
    const cyclic: Record<string, unknown> = { password: 'hunter2' };
    cyclic['self'] = cyclic;

    const walked = redactLogObject({ cyclic }) as { cyclic: Record<string, unknown> };

    expect(walked.cyclic['password']).toBe(REDACTION_CENSOR);
    // The same rebuilt node on both sides of the cycle, so pino's own
    // safe-stringify marks it `[Circular]` rather than recursing for ever.
    expect(walked.cyclic['self']).toBe(walked.cyclic);
  });

  /**
   * The output side of the same decision: normalising through `toJSON` must not
   * change what an operator reads. Asserted against the REAL logger rather than
   * the walk, because the thing being protected is the emitted line — and
   * because a `Buffer` here is what made `@pinojs/redact` throw.
   */
  it('emits a Date and a Buffer exactly as pino would, at every position', () => {
    const captured = captureLogger();

    captured.logger.info(
      {
        at: new Date('2026-08-12T00:00:00.000Z'),
        body: Buffer.from('hi'),
        a: { b: Buffer.from('hi') },
      },
      'm',
    );
    const line = captured.only();

    expect(line['at']).toBe('2026-08-12T00:00:00.000Z');
    expect(line['body']).toStrictEqual({ type: 'Buffer', data: [104, 105] });
    expect(line['a']).toStrictEqual({ b: { type: 'Buffer', data: [104, 105] } });
  });
});
