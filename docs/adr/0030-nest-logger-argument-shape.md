# ADR-0030 — Where Nest's `Logger.error` second argument lands, so ADR-0029's obligation 8 is wrong

**Status:** Accepted · **Date:** 2026-08-12 · **Corrects** obligation 8 and four
smaller assertions in [ADR-0029](./0029-observability-stack.md). Everything else
ADR-0029 decides — every pin, the Sentry/OTel shared-provider configuration, the
composite propagator, the `makeWorkflowExporter` shim, the redaction paths —
stands unchanged and was re-measured while writing this.

## Context

ADR-0029 obligation 8 tells Task 2 to log the exception filter's cause through
Nest's **three-argument** `Logger.error(message, stack, context)`, on the
strength of a measurement that `nestjs-pino` then routes the stack into `err`
where the redaction paths reach it.

**At the call site that actually exists, the three-argument form discards the
cause entirely.** `domain-exception.filter.ts:41` holds
`private readonly logger = new Logger(DomainExceptionFilter.name)`, and Nest's
`Logger` **appends `this.context`** to the argument list it forwards to the
`LoggerService`. `nestjs-pino` branches on `params.length`, so a
context-carrying `Logger` does not present the same call to it as a bare one.
ADR-0029 measured `nestjs-pino`'s `Logger` **directly** — no Nest wrapper, no
context — and stated the result of the wrapped, contexted one.

That is the same failure as the round-1 claim this obligation already replaced:
a measurement of one configuration, written up as a property of another. It
matters more this time, because the previous version was wrong in a direction
that lost nothing, and following this one deletes the diagnostic obligation 8
exists to preserve.

### Why this is a new file rather than another edit to ADR-0029

ADR-0029 has not merged, and its round-2 corrections were made in place citing
[ADR-0027](./0027-python-toolchain.md), which marks its own corrections in place
and says why. **That citation does not survive its own test, and the reason is
in the commit order.** `ca8e71b` carried ADR-0027's traps into Plan 0B-3 —
i.e. the text was relied on — and only then did `da7b3df` correct ADR-0027 in
place. So the rule proposed below condemns ADR-0027's in-place correction too;
it is not a precedent that licenses anything.

It is worse than a weak precedent. **[ADR-0028](./0028-temporal-bind-on-ip.md)
was written after `da7b3df`, about that exact practice, and rejected it.** So
citing ADR-0027 in `edb6404` was citing an **overruled** precedent, not merely a
contested one. ADR-0028 says, of exactly this situation:

> Editing the two sentences in place would rewrite an assertion a reviewer
> accepted, which this repository disallows **even while the ADR is unmerged**,
> and it would erase the more interesting fact: that the count was wrong for a
> second reason, of a different kind from the first.

ADR-0028's trigger was a **counted** claim — "five environment variables", said
as a complete count. ADR-0029's round-2 edits included one of precisely that
shape (a Sentry integration count corrected from 22 to 44) and several
decision-bearing assertions that a reviewer had already accepted and propagated
into the implementation plan. So the round-2 edits sat against ADR-0028's
sentence, and citing ADR-0027 alone was not sufficient to justify them.

Three things follow, and they are recorded rather than quietly fixed:

- **`edb6404` should have been an ADR.** Under the rule below it was a mistake,
  and it cited a precedent ADR-0028 had already overruled.
- **The round-2 in-place edits stand anyway.** Reverting them would be a third
  rewrite of the same text and would delete measurements that are correct — a
  worse outcome than a recorded misstep. ADR-0029's `CORRECTED (round 2)`
  markers make them legible, which is the property ADR-0028 is protecting.
- **This round stops.** Every correction is here, including the small ones, so
  ADR-0029's body is not rewritten again. ADR-0029 gains only **pointers** — one
  in its header and one at each of the three places that still restate a
  corrected claim — which assert nothing new and are the same after-the-fact
  annotation [ADR-0021](./0021-next-major-and-frontend-stack.md) carries from
  ADR-0023 and ADR-0024. Pointers are needed because the plan references
  obligations **by number**, so landing on obligation 8 without reading the
  header is a realistic path.

**The rule, stated so it can be applied rather than re-litigated: an ADR's body
may be edited only while nothing has relied on it. Merge is not the test —
citation is.** A claim has been relied on the moment another document, plan or
commit acts on it; from then on it is corrected by a new ADR. This is now in
[`docs/adr/README.md`](./README.md), because that is where a reader looks for
the immutability rule and it previously said only "never edited", which is both
stricter than the practice and silent about the two times the practice diverged.

## The measurement

Node 24.19.0, `@nestjs/common@11.1.28`, `pino@10.3.1`, `nestjs-pino@4.6.1`, in a
throwaway directory outside the workspace, destroyed afterwards. One case per
process — `nestjs-pino` caches a static root logger, so a second instance in the
same process silently reuses the first one's destination.

`CAUSE` is a stack string carrying a DSN. `err.stack=CAUSE` means the passed
cause arrived in `err.stack`; `err.message` is then the **log message**, not the
cause's own message.

| #     | Logger                                | Call                     | Adapter       | `context`               | `err`                             | cause in line      |
| ----- | ------------------------------------- | ------------------------ | ------------- | ----------------------- | --------------------------------- | ------------------ |
| **A** | `new Logger('DomainExceptionFilter')` | `error(msg, cause)`      | `nestjs-pino` | `DomainExceptionFilter` | present, `stack=CAUSE`            | **yes**            |
| **B** | `new Logger('DomainExceptionFilter')` | `error(msg, cause, ctx)` | `nestjs-pino` | `DomainExceptionFilter` | **ABSENT**                        | **no — DISCARDED** |
| C     | `new Logger()`                        | `error(msg, cause)`      | `nestjs-pino` | **= the cause string**  | ABSENT                            | yes                |
| D     | `new Logger()`                        | `error(msg, cause, ctx)` | `nestjs-pino` | `DomainExceptionFilter` | present, `stack=CAUSE`            | yes                |
| E     | `nestjs-pino` `Logger` **directly**   | `error(msg, cause)`      | —             | **= the cause string**  | ABSENT                            | yes                |
| F     | `nestjs-pino` `Logger` **directly**   | `error(msg, cause, ctx)` | —             | `DomainExceptionFilter` | present, `stack=CAUSE`            | yes                |
| **G** | `new Logger('DomainExceptionFilter')` | `error(msg, cause)`      | raw pino      | absent                  | **ABSENT**                        | **no — DISCARDED** |
| **H** | `new Logger('DomainExceptionFilter')` | `error({ err }, msg)`    | `nestjs-pino` | `DomainExceptionFilter` | present, `message=CAUSE`, `stack` | **yes**            |
| **I** | `new Logger('DomainExceptionFilter')` | `error({ err }, msg)`    | raw pino      | absent                  | present, `message=CAUSE`, `stack` | **yes**            |

**C ≡ E and D ≡ F.** That equality is the proof of what went wrong: ADR-0029's
two rows describe the direct-use shape, they are accurate for it, and they are
not the shape the filter has. Rows A and B are the same two calls once a
`Logger` with a context is in front.

With `redact: { paths: [… , 'err.message', 'err.stack'] }` applied — obligation
7's list, unchanged — rows **A, H and I all emit no secret** (`err.message`
`[REDACTED]`, `err.stack` `[REDACTED]`, nothing else in the line). So the
redaction half of the answer was right; only the call shape was wrong.

## Decision

**Obligation 8 of ADR-0029 is replaced by the following.**

1. **Do not adopt the three-argument `Logger.error(message, stack, context)`.**
   At the filter's call site it is row **B**: the cause is silently dropped and
   the line still exits 0 with a plausible-looking `context`. This is the one
   instruction in ADR-0029 that actively destroys the thing the obligation
   protects.

2. **The existing two-argument call at `domain-exception.filter.ts:88` reaches
   `err.stack` only when the cause carries a real stack.** Row A holds under
   `nestjs-pino` **and** `/\n\s*at /`: that library's
   `isWrongExceptionsHandlerContract` tests the second argument for stack frames
   and, failing the test, treats it as a context string instead. `describeCause`
   returns a stack for a normal `Error` — but returns `${name}: ${message}` when
   `stack` is `undefined`, and `non-Error thrown (typeof …)` for anything not an
   `Error`. **Both of those fail the regex and collapse row A into row B, where
   the cause is discarded.** Measured: with the fallback string, `err` is
   `ABSENT` and the line carries no cause at all. So this call shape is correct
   for the common case and silently loses the diagnostic for the two uncommon
   ones — which is not a property to build on.

3. **The adapter choice is load-bearing for the diagnostic, not only for
   redaction.** Row G: a hand-written `LoggerService` over raw pino forwards the
   second argument to `pino.error(msg, extra)`, where pino treats it as an
   unused interpolation argument and drops it. The filter's cause disappears
   with no error — and Plan 0B-1's comment on that call records that it exists
   because, without it, an unexpected 500 produced literally zero bytes of
   diagnostic output.

4. **The recommended shape is `logger.error({ err }, message)` where `err`
   holds an `Error` INSTANCE — never `describeCause`'s string.** This is the
   part of the first version of this ADR that was wrong, and it was wrong in the
   same way everything else on this document's record has been: rows H and I
   were measured with an `Error` instance, and stated of a call site where the
   value is a `string`.

   `describeCause(exception): string`. Pino serialises a **scalar** `err`
   verbatim, and `err.message` / `err.stack` are paths that match nothing on a
   string, so redaction does not apply. Measured, with obligation 7's paths
   active, under **both** adapters:

   | `err` holds                              | serialised as                                                  | leaks?  |
   | ---------------------------------------- | -------------------------------------------------------------- | ------- |
   | `describeCause(err)` — a stack string    | `"err":"Error: DB_DSN=postgres://user:PASSWORD@…"`             | **YES** |
   | `describeCause(err)` — the fallback form | `"err":"Error: DB_DSN=postgres://user:PASSWORD@…"`             | **YES** |
   | an `Error` instance                      | `{"type":"Error","message":"[REDACTED]","stack":"[REDACTED]"}` | no      |

   So the call must pass the exception itself, coerced when it is not an
   `Error`:

   ```ts
   const err = exception instanceof Error
     ? exception
     : new Error(`non-Error thrown (typeof ${typeof exception})`);
   this.logger.error({ err }, `Unhandled exception (requestId=${requestId})`);
   ```

   Measured clean under `nestjs-pino` and under a hand-written raw-pino adapter,
   for an `Error` with a stack, an `Error` without one, and a thrown plain object
   — and the coercion preserves the property `describeCause`'s comment exists
   for: a thrown non-`Error` is **described**, never stringified, so a plain
   object carrying a password still cannot reach the log.

   **`describeCause` therefore stops being the thing that is logged.** Task 2's
   choice is between deleting it and changing its return type; either is fine,
   and what is not fine is keeping it and passing its output as `err`.
   Alternatively a custom `err` serialiser can normalise a scalar into
   `{type, message, stack}` so the paths apply again — measured working — but
   that guards a mistake rather than preventing it, and the coercion above
   prevents it.

### And closing the leak this way destroys the diagnostic

This is the finding worth more than the correction above, and it is the reason
Task 2 needs a decision rather than a snippet. Obligation 7 puts **both**
`err.message` and `err.stack` in the redaction paths. Measured, that is
literally all an operator gets from an unhandled 500:

```jsonc
{ "context": "DomainExceptionFilter",
  "err": { "type": "Error", "message": "[REDACTED]", "stack": "[REDACTED]" },
  "msg": "Unhandled exception (requestId=req-1)" }
```

An `Error` happened. Nothing else survives. Plan 0B-1's comment on this exact
call records that it exists because, without it, an unexpected 500 produced
**literally zero bytes** of diagnostic output — and a line that says only "an
Error happened" is barely better. Closing the leak by censoring the two fields
that carry every clue is a control that passes its own test and leaves the
system unoperable.

A stack is `<message>\n    at <frame>\n    at <frame>…`. **The secret is in the
message; the frames are file paths and function names.** So an `err` serialiser
that keeps the frames and drops the message line resolves the tension, measured:

| Configuration                                      | leaks | `err.message` | frames kept        |
| -------------------------------------------------- | ----- | ------------- | ------------------ |
| obligation 7 as written                            | no    | `[REDACTED]`  | **0**              |
| frame-preserving `err` serialiser + the same paths | no    | `[REDACTED]`  | **4** (real ones)  |
| the same, cause passed as a **string**             | no    | `[REDACTED]`  | 14                 |
| the same, a non-`Error` thrown                     | no    | `[REDACTED]`  | 10 — **synthetic** |

The last row is the caveat: for a thrown non-`Error` there is no original stack,
so the frames come from wherever the serialiser constructed its replacement and
are worthless. That case should emit no frames rather than misleading ones.

This is **not** a decision this ADR makes — obligation 7 is ADR-0029's and Task 2
owns the serialiser. It is recorded because the obvious implementation of
obligation 7 produces an undiagnosable service, and nothing in ADR-0029 says so.

## The smaller corrections

Four assertions in ADR-0029 that are wrong or unqualified. None changes a
decision; they are here so that ADR-0029's body is not edited again.

- **The call site is `domain-exception.filter.ts:88`, not `:89`** — cited twice.
- **ADR-0029's absolute span and OTLP-POST counts are harness artefacts, and
  its Q5 field-by-field results are not.** The OTLP figures (1 / 1 / 3 posts)
  were taken through a `BatchSpanProcessor` with a 200 ms delay, so the count is
  decided by batching and by how long the process lived, not by the stack; the
  reproducible finding is **which spans arrive** — `RunWorkflow` and both
  `StartActivity` spans absent under the cast and present under the shim. The
  per-request span totals (11 / 12 / 10) were taken through a
  `SimpleSpanProcessor` into an `InMemorySpanExporter` and depend on the probe
  code in the spike's own controller; an independent re-measurement with a
  different controller got 9 / 10 / 7. **The number that reproduced across both
  harnesses is the comparative one: 3 route-bearing spans for
  `@opentelemetry/instrumentation-fastify@0.57.0` against 4 for
  `@fastify/otel@0.20.1`.** Read the totals as comparative within a row, never
  as properties of the stack.
- **Q5's `errorKey: 'error'` row states no call shape, and the answer differs by
  shape.** Measured with paths `['err.message','err.stack']` and
  `errorKey: 'error'`: `logger.error(err)` and `logger.error({ error: err }, …)`
  both serialise the error under `error`, the static `err.*` paths miss, and
  both **LEAK**; `logger.error({ err: … }, …)` still lands under the literal key
  `err` and is **redacted**. The mechanism ADR-0029 gives is right — a static
  path is coupled to `errorKey` — and the row should have been read as applying
  to the first two shapes only.
- **The gate row reading "one `[WARN] deprecated` line, on
  `instrumentation-fastify`" is stale.** It described round 1's pin set. A cold
  `pnpm install` of the **corrected** set — `@fastify/otel@0.20.1`, no
  `@opentelemetry/instrumentation-fastify` — emits **zero** deprecation
  warnings, and `pnpm peers check` still reports none. Measured 2026-08-12.

## Alternatives

- **Edit ADR-0029 in place a second time.** Rejected on ADR-0028's sentence,
  which is unambiguous and which round 2 did not address. The cost of this
  choice is real: a reader of ADR-0029 alone will follow a recommendation that
  drops the cause, which is why its header now points here.
- **Revert ADR-0029 to its round-1 text and start again.** Rejected: it would
  delete measurements that are correct, and a document's history of being wrong
  is the part this repository has decided to keep.
- **Tell Task 2 to keep the two-argument call and mandate `nestjs-pino`.**
  Rejected as over-reach. It is the correct configuration today (row A), but
  ADR-0029 deliberately left the adapter to Task 2, and the `{ err }` shape
  makes that freedom safe instead of removing it.
- **Assert the behaviour with a test in `apps/api` instead of an ADR.** Not an
  alternative — it is an addition, and Task 2 should write one. A test that
  asserts the cause reaches `err.stack` would have caught row B, and nothing in
  the current plan would.

## Consequences

**Accepted:** ADR-0029 now has a correction ADR against it, as ADR-0027 does,
and the pair must be read together. It is the **second** such pair on a stated
basis: `docs/adr/README.md` records exactly two entries that _correct part of_
another ADR — 0028→0027 and 0030→0029 — as distinct from the four that _scope_
one and the three that _supersede_ one.
The behaviour corrected here is a property of an interaction between three
things (`@nestjs/common`'s `Logger` appending its context, `nestjs-pino`'s
arity-based parsing, and pino's positional-argument handling), so it is not
discoverable from any one package's documentation and will need re-measuring on
any of their major bumps. And the filter's diagnostic can vanish with no error
in two of the nine configurations measured, which means Task 2 owes a test that
asserts the cause **arrives**, not merely that it is redacted — a redaction test
passes trivially when there is nothing to redact. And obligation 7's paths,
applied literally, leave an unhandled 500 with no diagnostic beyond
`"type":"Error"`, so Task 2 owns a second decision this plan had not surfaced:
what an operator is left with after the control fires.

**Gained:** the answer is now measured at the shape the code actually has, with
the two configurations ADR-0029 measured kept in the table so the discrepancy is
visible rather than overwritten. Task 2 gets a call shape that works under
either adapter, which turns the adapter from a prerequisite decision into a
reversible one. And the in-place-versus-new-file question, which this repository
has now answered inconsistently twice, has an explicit rule attached to it: the
test is whether the text has been relied on, not whether it has merged.
