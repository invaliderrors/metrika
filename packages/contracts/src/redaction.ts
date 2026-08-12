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
 *     matches a name's WORD SUFFIX as well as the whole name, so `s3_url` and
 *     `downloadUrl` are both caught by `url`. It can afford to, because a
 *     structlog event dict is flat.
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
 *     Python matcher catch `s3_url`, `object_url` and every other name a caller
 *     invents at 2am. It has a cost on the Node side — see the note below.
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
