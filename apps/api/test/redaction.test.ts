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
 * **A leak lived in the gap between those two rows, and the shape of this file
 * is what hid it.** The first version asserted child bindings in the canonical
 * spelling and non-canonical spellings in a merged object — the SUM of the two
 * dimensions — so `logger.child({ signed_url })`, their PRODUCT, was reached by
 * neither mechanism and went out verbatim with every fixture green. MEASURED.
 * `createLogger` now puts a child's bindings through the walk as well, and the
 * corpus below is graded through all four shapes a key can arrive by rather
 * than one.
 *
 * **What that means for the derived paths, stated rather than implied:** once
 * the walk reaches child bindings too, `REDACTION_PATHS`'s fifty-one derived
 * entries no longer have any shape to themselves — the walk catches the same
 * keys, in more spellings. Their behavioural contribution is `err.message` and
 * `err.stack`, which are non-enumerable and which no walk can see, plus a
 * backstop in the canonical spelling if the walk is ever removed or bypassed.
 * So the derivation is asserted STRUCTURALLY below (the paths are the shared
 * enum, at three depths) and the leak assertions are behavioural. Removing a
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

  it('carries three depths per name, because a path is not a name', () => {
    // `password` and `*.password` are different rules and neither implies the
    // other — and `*` is single-level, so neither reaches
    // `req.headers.authorization`, which is where `pino-http` puts the one
    // header this list exists for. MEASURED: with only the first two forms, a
    // request line's `authorization` header goes out verbatim.
    for (const name of RedactedFieldName.options) {
      expect(REDACTION_PATHS).toContain(name);
      expect(REDACTION_PATHS).toContain(`*.${name}`);
      expect(REDACTION_PATHS).toContain(`*.*.${name}`);
    }
  });

  it('carries ADR-0029 obligation 7, which no derivation could produce', () => {
    // `message` and `stack` are not field names on the shared list and must not
    // be — `*.message` would censor every domain error detail one level deep.
    // They are `err`-scoped paths, and they are the reason an unhandled 500's
    // stack no longer reaches the sink.
    expect(REDACTION_PATHS).toContain('err.message');
    expect(REDACTION_PATHS).toContain('err.stack');
    expect(REDACTION_PATHS).toHaveLength(RedactedFieldName.options.length * 3 + 2);
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
   * THE PRODUCT, NOT THE SUM — and the reason this helper takes a shape.
   *
   * The first version of this suite graded the corpus through a merged object
   * only, and asserted child bindings only in the canonical camelCase. Each
   * fixture passed and their COMBINATION leaked: `formatters.log` is never
   * called for a child binding, `REDACTION_PATHS` matches literal names, and
   * `logger.child({ signed_url })` was therefore censored by nothing at all.
   * MEASURED going out verbatim, with the whole suite green.
   *
   * So every corpus row is now run through all four shapes a key can reach this
   * sink by. `deep` is below any derived path; `child` and `grandchild` are
   * below any walk.
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
    grandchild: (logger, key) => {
      logger
        .child({ a: 1 })
        .child({ nested: { [key]: 'SECRET-VALUE' } })
        .info('grandchild');
    },
  };

  const SHAPE_NAMES = Object.keys(SHAPES);

  /**
   * `level` is not a redaction verdict on the flat-child shape and must not be
   * graded as one: pino's `child(bindings)` READS `bindings.level` as the
   * child's log level rather than emitting it, so the value never reaches the
   * line and "absent" cannot be told apart from "censored". It is a
   * `MUST_SURVIVE` row and it is graded through the other three shapes, which
   * is why this exclusion is one key rather than a category.
   */
  const RESERVED_BY_PINO_CHILD = new Set(['level']);

  function rowsFor(shape: string): typeof CORPUS {
    return shape === 'child'
      ? CORPUS.filter((row) => !RESERVED_BY_PINO_CHILD.has(row.key))
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

  it('passes an Error through untouched, so the err serialiser still sees one', () => {
    // Rebuilding an Error into a plain object destroys it before pino's `err`
    // serialiser runs — MEASURED: `type` disappeared and every stack frame with
    // it. Errors belong to the serialiser; the walk owns plain data.
    const error = new Error('boom');

    expect(redactLogObject({ err: error })['err']).toBe(error);
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

  it('leaves a value that serialises itself alone', () => {
    // `Date` and `Buffer` both carry `toJSON`, and rebuilding them from their
    // own enumerable keys produces `{}` — a silently emptied timestamp.
    const at = new Date('2026-08-12T00:00:00.000Z');

    expect(redactLogObject({ at })['at']).toBe(at);
  });
});
