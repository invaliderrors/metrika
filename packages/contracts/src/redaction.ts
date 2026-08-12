import { z } from 'zod';

/**
 * The field names that must never reach a log sink, stated once for every
 * runtime that has a sink.
 *
 * **Why this lives in `packages/contracts` rather than beside a logger.** There
 * are three sinks — Pino in `apps/api`, structlog in `apps/workers`, and
 * Sentry's `beforeSend` in `apps/web` — and `docs/OBSERVABILITY.md` §3 gives one
 * list for all three. Three hand-maintained copies of a security control is how
 * one of them silently stops matching: nothing fails, nothing warns, and the
 * sink that drifted keeps emitting a line that looks exactly like the two that
 * did not. This package is the only thing in the repository that already crosses
 * the TypeScript/Python boundary as *generated code* — `pnpm contracts:emit`
 * turns it into `apps/workers/.../metrika_core/contracts/__init__.py` and CI
 * fails on a diff — so putting the list here makes drift a red build instead of
 * a silent mismatch. MEASURED: a `z.enum` of these values survives
 * `z.toJSONSchema()` → `datamodel-codegen` as a `StrEnum` whose members are the
 * values verbatim, which is the whole reason this shape was chosen over an
 * object or a branded string.
 *
 * **What this list is, and what it is not.** It is the set of *field names*.
 * It is deliberately NOT a set of Pino paths, because a Pino path is a Pino
 * concept: structlog has no paths and Sentry's `beforeSend` walks a different
 * object graph. What differs per sink is TRAVERSAL, and only traversal:
 *
 *   - **Pino** (`apps/api`) needs a path per name, and needs BOTH the top-level
 *     and the one-level-deep wildcard form — `redact.paths` matches paths, not
 *     names, so `password` and `*.password` are two different rules and neither
 *     implies the other.
 *   - **structlog** (`apps/workers`) matches a flat event dict's keys directly.
 *   - **Sentry** (`apps/web`) walks an arbitrary object graph.
 *
 * The decision each of them makes about a key it has reached — *is this name
 * sensitive?* — is ONE algorithm, and it is `isRedactedKey` below. All three
 * sinks call it. That is not a stylistic preference: it was two hand-written
 * copies, and 27 of 140 probe names were measured disagreeing between them
 * before this module took the rule over.
 *
 * **Spelling.** camelCase, because that is the wire spelling: it is what a
 * JavaScript object key looks like, what `packages/contracts` uses everywhere
 * else (`amountMinor`), and what an activity payload carries into a Python
 * worker. The Python matcher lower-cases and splits on word boundaries, so
 * `signed_url` — the spelling a Python caller actually reaches for — matches
 * `signedUrl` here without either side restating the other's convention.
 *
 * **Two entries deserve their own justification**, because a later reader will
 * otherwise read them as over-caution and delete one:
 *
 *   - **A signed URL is a credential.** `X-Amz-Signature` is a bearer token for
 *     the object until it expires, so a signed URL in a log is a leaked model.
 *     Hence `url` in the bare form as well as the four specific spellings: the
 *     specific ones are what Pino can match, and the bare one is what lets the
 *     Python matcher catch `s3_url`, `object_url`, `downloadURL` and their
 *     plurals from one entry. It has a cost on the Node side — see the note
 *     below. What it does NOT reach on either side is an invented concatenation
 *     that is not itself a name here (`mysignedurl`); `metrika_core.logging`'s
 *     `is_redacted_key` names that limit and says why closing it would take
 *     `curl` with it.
 *   - **File names and project names are customer intellectual property.**
 *     `Torre_Bacatá_Fase3_Final.stl` in a log tells an observer what an
 *     architect is working on (`docs/SECURITY.md` §10). The model ID is the
 *     identifier that belongs in a log line.
 *
 * **`url` costs the Node side something, and the sink owner decides how to pay
 * it.** Derived as `*.url`, it reaches `req.url` under `pino-http`'s default
 * request serialiser, so every request line would lose its path. That is not a
 * reason to drop `url` — dropping it narrows a control that was widened
 * deliberately after `download_url`, `s3_url` and `upload_url` were measured
 * going through untouched — it is a reason for `apps/api` to emit the request
 * path under a name that is not `url`. Stated here because the alternative is
 * that whoever wires Pino discovers it as a mystery in a dashboard.
 *
 * **`key` is deliberately absent, and so is any name ending in it.**
 * `cacheKey` / `cache_key` is the content-addressed identifier this system uses
 * to talk about an upload without naming it — the one credential-shaped word
 * here whose values are safe and whose redaction would cost real
 * debuggability. `apps/workers`' own fixture asserts it survives.
 */
export const RedactedFieldName = z.enum([
  'authorization',
  'cookie',
  'downloadUrl',
  // Both spellings, because they are different words and no matcher can bridge
  // them: `fileName` is two words and covers `file_name`, `filename` is one and
  // covers `filename` and `Content-Disposition`'s spelling. A matcher that
  // treated them as the same name would have to ignore word boundaries, which
  // is what makes `curl` match `url`.
  'fileName',
  'filename',
  'originalFilename',
  'password',
  'paymentPayload',
  'presignedUrl',
  'projectName',
  'providerPayload',
  'secret',
  'signedUrl',
  'token',
  'uploadUrl',
  'url',
  'webhookSecret',
]);
export type RedactedFieldName = z.infer<typeof RedactedFieldName>;

/**
 * Splits an identifier into lowercase words, in every spelling a sink sees.
 * `signedUrl`, `signed_url`, `SIGNED_URL` and `signedURL` all become
 * `['signed', 'url']`.
 *
 * **The alternation order is load-bearing and was measured, not reasoned about.**
 * `[A-Z]+s(?![a-z])` must come FIRST so an acronym plural stays one word:
 * `URLs` becomes `['urls']`, which `spellings` then reduces to `url`. Second in
 * the order it never fires, because `[A-Z]+(?![a-z])` backtracks off the
 * lowercase `s` and matches `UR` — measured, and the result is `['ur', 'ls']`,
 * which matches nothing at all. `signedURLs`, `downloadURLs`, `presignedURLs`
 * and `URLs` were all going through untouched.
 *
 * `HTTPStatus` still splits `['http', 'status']` and `AWSSecret` still splits
 * `['aws', 'secret']`; neither is captured by the plural branch, which requires
 * a literal lowercase `s`.
 *
 * DIGITS ARE THEIR OWN WORD (`[0-9]+` rather than folding them into
 * `[a-z0-9]+`), so `url2` is `['url', '2']` and not one opaque token.
 */
const WORD = /[A-Z]+s(?![a-z])|[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|[0-9]+/g;

/** A trailing ordinal — the `2` in `url2` and in `signed_url_v2`. */
const ORDINAL = /^[0-9]+$/;

function words(name: string): readonly string[] {
  return [...name.matchAll(WORD)].map(([word]) => word.toLowerCase());
}

/**
 * The forms of one key that all mean the same field.
 *
 * Each is EXACT rather than fuzzy, which is what keeps the false-positive
 * surface bounded:
 *
 *   - the ordinal trim pops trailing NUMERIC words, then a lone `v` if a number
 *     was popped from behind it. `url_count` keeps its `count` and stays
 *     readable; `s3_url` keeps its `url`, because the digit is not trailing.
 *   - the plural form strips ONE trailing `s` from the last word and is offered
 *     ALONGSIDE the raw form, never instead of it — no name in the list ends in
 *     `s`, so nothing can be lost, and it can only ever add a match.
 */
function spellings(parts: readonly string[]): readonly (readonly string[])[] {
  const trimmed = [...parts];
  let poppedANumber = false;
  // `.at(-1)` rather than an index with a `?? ''` fallback: the fallback is
  // unreachable, and an unreachable branch in this package fails the 100%
  // threshold that CLAUDE.md requires of the pure kernels. Both arms of the
  // guard below really do fire — on `""` it is undefined immediately, and on
  // `"2"` it becomes undefined once the only word is popped.
  for (let last = trimmed.at(-1); last !== undefined && ORDINAL.test(last); last = trimmed.at(-1)) {
    trimmed.pop();
    poppedANumber = true;
  }
  if (poppedANumber && trimmed.at(-1) === 'v') {
    trimmed.pop();
  }
  // THE SAME `v`, WHEN IT DID NOT GET ITS OWN TOKEN. `signed_url_v2` tokenises
  // as `[…,'url','v','2']` and the branch above is enough; `signedURLV2` and
  // `signedurlv2` do not, because the `v` merges into the uppercase run and the
  // lowercase run respectively — `['signed','urlv']` and `['signedurlv']`.
  //
  // MEASURED: without this, six of the sixty composed spellings below are
  // unreachable, all of them a version suffix, and every one uniformly across
  // all seventeen names. With it, all sixty are reached and the negative roster
  // is untouched — including `rev2`, `dev2`, `env2`, `nav2` and `srv2`, whose
  // stems are not on the list.
  const merged = trimmed.at(-1);
  if (poppedANumber && merged !== undefined && merged.length > 1 && merged.endsWith('v')) {
    trimmed[trimmed.length - 1] = merged.slice(0, -1);
  }

  const last = trimmed.at(-1);
  if (last !== undefined && last.length > 1 && last.endsWith('s')) {
    return [trimmed, [...trimmed.slice(0, -1), last.slice(0, -1)]];
  }
  return [trimmed];
}

/**
 * Every name as a word tuple, plus the same words with the boundary removed.
 *
 * `['url']` is the entry that reaches `s3_url` and `downloadUrl`;
 * `['file','name']` reaches `original_file_name`; `['signedurl']` reaches
 * `signedurl` WITHOUT letting `curl` in — `curl` is not the concatenation of
 * anything on the list, whereas a rule like "ends with the letters u-r-l" takes
 * both.
 */
const REDACTED_WORDS: readonly (readonly string[])[] = RedactedFieldName.options.flatMap((name) => [
  words(name),
  [words(name).join('')],
]);

function endsWithWords(parts: readonly string[], candidate: readonly string[]): boolean {
  if (candidate.length > parts.length) return false;
  return candidate.every((word, index) => parts[parts.length - candidate.length + index] === word);
}

/**
 * Whether a key names a field that must never be written down.
 *
 * **This is THE rule, and it lives here for the reason the list does.** An
 * earlier version of this module said each sink's matching was its own business
 * and that comparing them would assert something false. That conflated two
 * different things, and review measured the cost: 27 of 140 probe names
 * disagreed between `apps/workers`' matcher and `apps/web`'s. What genuinely
 * differs per sink is TRAVERSAL — Pino walks paths, structlog walks a flat event
 * dict, Sentry walks an arbitrary object graph. The decision "does this key name
 * a redacted field?" is one algorithm, and three copies of it drift exactly as
 * three copies of the list would.
 *
 * `redaction-corpus.json` is what keeps the Python port honest: it is emitted
 * from the table below by `pnpm contracts:emit`, CI diffs it, and both this
 * package and `apps/workers` assert their matcher reproduces every verdict in
 * it. A change to one rule without the other goes red.
 *
 * THE ONE SHAPE IT DOES NOT REACH, named so nobody assumes otherwise: an
 * invented concatenation that is not itself a listed name — `mysignedurl`,
 * `thetoken`. Catching those needs a prefix heuristic, and the same heuristic
 * takes `curl`. `signedurl` is reached because it IS a listed name with its
 * boundary removed; `my_signed_url`, `mySignedUrl` and `signedurls` all are too.
 */
export function isRedactedKey(key: string): boolean {
  return spellings(words(key)).some((parts) =>
    REDACTED_WORDS.some((candidate) => endsWithWords(parts, candidate)),
  );
}

/** `signedUrl` → `signed_url`, the spelling a Python caller writes. */
function snake(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function capitalise(name: string): string {
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

/**
 * `['signed','url']` → `signedUrl`.
 *
 * Shared by the camelCase and acronym styles rather than inlined into each. Not
 * a tidy-up: this package holds a 100% coverage threshold, and inlined into the
 * acronym style the `capitalise` arm would be unreachable — that style renders
 * everything but the LAST word, and no name on the list is three words long.
 */
function camelise(parts: readonly string[]): string {
  return parts.map((word, index) => (index === 0 ? word : capitalise(word))).join('');
}

/**
 * How one field name is spelled, as INDEPENDENT DIMENSIONS that are composed.
 *
 * **The composition is the point, and it took three rounds to learn it.** The
 * first fixture listed two shapes. The second listed twelve. The third listed
 * fifteen — and `signedURLs2` was still not among them, because it is an
 * acronym plural AND an ordinal, and a flat list contains the shapes somebody
 * thought of rather than their product. Measured then: a ONE-CHARACTER edit to
 * the Python matcher (`[A-Z]+s(?![a-z])` to `[A-Z]+s(?![a-z0-9])`) left the
 * entire workers suite green at 657 passed while `signedURLs2` and
 * `downloadURLs2` diverged between the two matchers.
 *
 * So the table is four dimensions and the corpus is their product: 5 styles ×
 * prefixed × plural × 3 ordinals = **60 spellings per name**, and a shape
 * nobody thought of is covered as long as it is a combination of shapes
 * somebody did. Adding a dimension multiplies the corpus instead of extending
 * it by one.
 *
 * Every one of the sixty is expected to REDACT — there is no exception table,
 * and that is the result of a measurement rather than a design: six of the
 * sixty were unreachable until the `v`-suffix rule in `spellings` was
 * completed. Declaring those six as limits was the alternative, and fixing the
 * rule was cheaper and stronger.
 */
interface Style {
  readonly label: string;
  /** Renders a word list in this style. */
  readonly render: (words: readonly string[]) => string;
  /** Prepends a qualifier, with whatever boundary this style uses. */
  readonly prefix: (rendered: string) => string;
  /** How this style spells a plural. */
  readonly plural: string;
  /** How this style spells a version suffix. */
  readonly version: string;
}

const STYLES: readonly Style[] = [
  {
    label: 'camelCase',
    render: camelise,
    prefix: (rendered) => `upstream${capitalise(rendered)}`,
    plural: 's',
    version: 'V2',
  },
  {
    label: 'snake_case',
    render: (parts) => parts.join('_'),
    prefix: (rendered) => `upstream_${rendered}`,
    plural: 's',
    version: '_v2',
  },
  {
    label: 'SCREAMING_SNAKE',
    render: (parts) => parts.join('_').toUpperCase(),
    prefix: (rendered) => `UPSTREAM_${rendered}`,
    plural: 'S',
    version: '_V2',
  },
  {
    // `signedURL`, `originalFILENAME` — the last word as an acronym, which is
    // how a developer writes `URL` and `ID`.
    label: 'acronym',
    // `parts.slice(-1).join('')` rather than `parts.at(-1) ?? ''`: the fallback
    // can never fire, and an unreachable branch fails this package's threshold.
    render: (parts) => camelise(parts.slice(0, -1)) + parts.slice(-1).join('').toUpperCase(),
    prefix: (rendered) => `upstream${capitalise(rendered)}`,
    plural: 's',
    version: 'V2',
  },
  {
    // No word boundary at all. Reached because each name is ALSO matchable with
    // its own boundary removed — which is why `signedurl` is caught and `curl`
    // is not, and why a qualifier here has to bring a separator with it
    // (`upstream_signedurl`, never `upstreamsignedurl`; the latter is
    // `mysignedurl`, a declared survivor).
    label: 'concatenated',
    render: (parts) => parts.join(''),
    prefix: (rendered) => `upstream_${rendered}`,
    plural: 's',
    version: 'v2',
  },
];

/** The words of a name, as the styles above consume them. */
function wordsOfName(name: string): readonly string[] {
  return snake(name).split('_');
}

/** Every spelling of one name: the product of the four dimensions. */
function spellingsOf(name: string): readonly string[] {
  const parts = wordsOfName(name);
  const keys: string[] = [];
  for (const style of STYLES) {
    for (const prefixed of [false, true]) {
      for (const plural of [false, true]) {
        for (const ordinal of ['', '2', style.version]) {
          const base = style.render(parts);
          keys.push(
            `${prefixed ? style.prefix(base) : base}${plural ? style.plural : ''}${ordinal}`,
          );
        }
      }
    }
  }
  return keys;
}

/**
 * Names that MUST stay readable, and why each one is here.
 *
 * The cost of over-redaction, asserted rather than assumed. Every widening this
 * module has taken added rows here in the same commit: the plural rule brought
 * `cache_keys` and `url_counts`, the acronym branch brought `HTTPStatus`,
 * `AWSRegion`, `cacheKeys` and `statuses`, and the `v`-suffix rule brought
 * `rev2` and `dev2`.
 */
const MUST_SURVIVE: readonly string[] = [
  // The content-addressed identifier every pipeline log line carries. `key` is
  // the one credential-shaped word on this side whose values are safe.
  'key',
  'keys',
  'cacheKey',
  'cacheKeys',
  'cache_key',
  'cache_keys',
  // Why the rule is a WORD-suffix rule and not a substring one.
  'url_count',
  'url_counts',
  'token_count',
  // Why it is a word suffix and not a character suffix.
  'curl',
  // What the acronym branch could have swept in, and did not: it requires a
  // literal lowercase `s`, so an acronym followed by a capitalised word is
  // untouched. These were graded only in this package's own suite until the
  // corpus carried them across to the Python port.
  'HTTPStatus',
  'AWSRegion',
  'statuses',
  // What the `v`-suffix rule could have swept in. Each is a real identifier
  // whose stem is not on the list — the strip only fires after a trailing
  // number was popped, so an ordinary word ending in `v` is never touched.
  'rev2',
  'dev2',
  'env2',
  'nav2',
  'srv2',
  // The correlation fields. The processors that add them run BEFORE redaction,
  // so a name on both lists would produce a correlated line whose correlation
  // is censored.
  'requestId',
  'traceId',
  'spanId',
  'organizationId',
  'workflowId',
  'workflowRunId',
  'activityType',
  'attempt',
  'attempt_3',
  'modelId',
  // Ordinary worker vocabulary.
  'taskQueue',
  'task_queue',
  'address',
  'namespace',
  'activities',
  'status',
  'results',
  'md5',
  'worker',
  'event',
  'level',
  'timestamp',
  // The named limit: an invented concatenation that is not itself a listed
  // name. Reaching these needs the prefix heuristic that takes `curl`.
  'mysignedurl',
  'thetoken',
  // Degenerate inputs, so the matcher is exercised at its edges rather than
  // only in the middle.
  '',
  's',
  'v2',
  '2',
];

/**
 * Any name declared both ways, which must be none.
 *
 * A `MUST_SURVIVE` entry that some spelling also produces used to be resolved
 * silently in favour of redaction — so a deliberate negative declaration could
 * be discarded with no error, and the corpus would quietly stop making the
 * claim its author wrote. Returned as data rather than thrown, so the check is
 * a test assertion with no unreachable branch behind it.
 */
export function conflictingDeclarations(): readonly string[] {
  const redacted = new Set(RedactedFieldName.options.flatMap((name) => spellingsOf(name)));
  return MUST_SURVIVE.filter((key) => redacted.has(key));
}

/**
 * The corpus every sink grades itself against.
 *
 * **The verdicts are DECLARED, not computed.** A corpus produced by running a
 * matcher would record whatever that matcher does, so a wrong rule would
 * generate a corpus every port could agree with perfectly — implementations in
 * exact agreement and all of them wrong. It is built from the two tables above
 * instead, and `isRedactedKey` is graded by it exactly as the Python port is.
 *
 * Emitted to `redaction-corpus.json` by `pnpm contracts:emit` and diffed by CI,
 * so adding a name to `RedactedFieldName` extends the corpus mechanically —
 * sixty new rows nobody has to remember to write.
 */
export function redactionCorpus(): readonly { readonly key: string; readonly redacted: boolean }[] {
  // A `Set`, so the spellings that collide for a single-word name (`password`
  // is its own camelCase, snake_case and concatenated form) become one row
  // rather than three. Sorted, because this file is byte-diffed in CI and an
  // emitter whose output permutes turns that gate red on a tree nobody touched.
  const redacted = new Set(RedactedFieldName.options.flatMap((name) => spellingsOf(name)));
  const rows = [
    ...[...redacted].map((key) => ({ key, redacted: true })),
    ...MUST_SURVIVE.map((key) => ({ key, redacted: false })),
  ];
  // Two-way comparator, total because `conflictingDeclarations()` is asserted
  // empty and the `Set` above has already de-duplicated the positives.
  return rows.sort((left, right) => (left.key < right.key ? -1 : 1));
}
