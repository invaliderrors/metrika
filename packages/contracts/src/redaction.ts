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
 * object graph. Each sink derives its own matcher from these names, and each
 * matcher is as good as its runtime allows:
 *
 *   - **Pino** (`apps/api`) needs a path per name, and needs BOTH the top-level
 *     and the one-level-deep wildcard form — `redact.paths` matches paths, not
 *     names, so `password` and `*.password` are two different rules and neither
 *     implies the other.
 *   - **structlog** (`apps/workers`) matches the log event's keys directly, and
 *     matches a name's WORD SUFFIX as well as the whole name, so `s3_url`,
 *     `downloadUrl`, `presigned_urls`, `signedURL2` and `signedurl` are all
 *     caught by entries here. It can afford to, because a structlog event dict
 *     is flat. Pino cannot: `redact.paths` is a path list, so **every spelling
 *     a Node caller might write needs its own entry here or its own path
 *     there** — that asymmetry is the reason this list is names and not paths,
 *     and the reason the two sinks are not asserted equal.
 *   - **Sentry** (`apps/web`) walks the event and applies the same names.
 *
 * So the sinks agree on the NAMES and cannot agree on the matching, and this
 * comment is the place that says so out loud — an equality assertion between
 * three matchers would be asserting something false.
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

/** `signedUrl` → `signedURL`: the last word as an acronym, which is a real spelling. */
function acronym(name: string): string {
  // Written as two replacements rather than a split-and-index, so there is no
  // unreachable `?? ''` for the coverage threshold to fail on: `split('_')`
  // cannot return an empty array, and a fallback that can never fire is a
  // branch no test can cover.
  return snake(name)
    .replace(/[^_]+$/, (word) => word.toUpperCase())
    .replaceAll('_', '');
}

function capitalise(name: string): string {
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

/**
 * Every spelling of a redacted name that MUST be caught, as transforms rather
 * than literals.
 *
 * A table, because the first version of the workers' fixture listed two shapes —
 * the name and an `upstream`-prefixed one — and so could not see a spelling
 * nobody had thought to write down. Six got through: `presigned_urls`,
 * `signed_urls`, `file_names`, `signedURL2`, `presigned_url_v2` and `signedurl`.
 * The acronym rows were the second wave, and they are here rather than in a test
 * so that BOTH sides grade the same set.
 */
const MUST_REDACT: readonly (readonly [string, (name: string) => string])[] = [
  ['camelCase', (name) => name],
  ['snake_case', snake],
  ['SCREAMING_SNAKE', (name) => snake(name).toUpperCase()],
  ['prefixed camelCase', (name) => `upstream${capitalise(name)}`],
  ['prefixed snake_case', (name) => `upstream_${snake(name)}`],
  ['plural camelCase', (name) => `${name}s`],
  ['plural snake_case', (name) => `${snake(name)}s`],
  ['prefixed plural', (name) => `upstream_${snake(name)}s`],
  ['ordinal', (name) => `${name}2`],
  ['versioned', (name) => `${snake(name)}_v2`],
  ['concatenated', (name) => name.toLowerCase()],
  ['concatenated plural', (name) => `${name.toLowerCase()}s`],
  ['acronym', acronym],
  ['acronym plural', (name) => `${acronym(name)}s`],
  ['acronym ordinal', (name) => `${acronym(name)}2`],
];

/**
 * Names that MUST stay readable, and why each one is here.
 *
 * The cost of over-redaction, asserted rather than assumed. Teaching a matcher
 * to strip a trailing `s` is exactly the widening that quietly takes
 * `cache_keys` and `url_counts` with it, so this list grew in the same commit
 * that added the plural rule.
 */
const MUST_SURVIVE: readonly string[] = [
  // The content-addressed identifier every pipeline log line carries. `key` is
  // the one credential-shaped word on this side whose values are safe.
  'key',
  'keys',
  'cacheKey',
  'cache_key',
  'cache_keys',
  // Why the rule is a WORD-suffix rule and not a substring one.
  'url_count',
  'url_counts',
  'token_count',
  // Why it is a word suffix and not a character suffix.
  'curl',
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
 * The corpus both sides grade themselves against.
 *
 * **The verdicts are DECLARED, not computed.** A corpus generated by running
 * `isRedactedKey` would record whatever the rule does, so a wrong rule would
 * produce a corpus the Python port could agree with perfectly — two
 * implementations in perfect agreement and both wrong. Built from the two
 * tables above instead, it is an independent statement of what must happen, and
 * `isRedactedKey` is graded by it exactly as the Python matcher is.
 *
 * Emitted to `redaction-corpus.json` by `pnpm contracts:emit` and diffed by CI,
 * so adding a name to `RedactedFieldName` extends the corpus mechanically —
 * fifteen new rows nobody has to remember to write.
 */
export function redactionCorpus(): readonly { readonly key: string; readonly redacted: boolean }[] {
  const rows = RedactedFieldName.options.flatMap((name) =>
    MUST_REDACT.map(([, spell]) => ({ key: spell(name), redacted: true })),
  );
  const survivors = MUST_SURVIVE.map((key) => ({ key, redacted: false }));

  // De-duplicated, because `filename`'s camelCase and concatenated spellings are
  // the same string. Sorted, because the emitted file is byte-diffed in CI and
  // an emitter whose output permutes turns that gate red on a tree nobody
  // touched.
  const byKey = new Map<string, boolean>();
  for (const { key, redacted } of [...rows, ...survivors]) {
    byKey.set(key, (byKey.get(key) ?? false) || redacted);
  }
  // Two-way comparator, which is total here because the `Map` above guarantees
  // the keys are unique — an equal case would be unreachable, and an
  // unreachable branch fails this package's 100% threshold.
  return [...byKey.entries()]
    .map(([key, redacted]) => ({ key, redacted }))
    .sort((left, right) => (left.key < right.key ? -1 : 1));
}
