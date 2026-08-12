# ADR-0036 — our own browser does not send `sentry-trace`, so ADR-0035's operational justification is false

**Status:** Accepted · **Date:** 2026-08-12 · **Corrects part of**
[ADR-0035](./0035-the-sampling-label-is-propagator-specific.md). Its eight
measured cells all stand, and so do its Decision points 1 and 2. What is wrong is
Decision point 3, the sentence that explains why the finding matters
operationally — and that sentence is the one both operator documents copied.

> **Every claim below is labelled MEASURED or INFERENCE.** This is the fourth
> false consequence in this chain and all four had one shape: a sentence that
> reads like an implication of something genuinely measured, sitting beside
> claims that were. The label is the cheapest defence against a fifth.

## Context

ADR-0035 Decision 3 says, in full:

> **This is operationally live, not pedantic.** `apps/web` ships
> `@sentry/nextjs`, so the browser sends `sentry-trace` and its own client-side
> sample rate silently becomes this API's — including zero.

`.env.example:68-71` and `docs/OBSERVABILITY.md:78-80` carry it in almost those
words.

**MEASURED (ADR-0035, reproduced here by reading its harness): all eight of its
cells were curl-supplied headers.** Not one of them came from `apps/web`. The
claim that our own browser is such a caller was inferred from the fact that
`@sentry/nextjs` is installed, and installing `@sentry/nextjs` is not what makes
a browser send that header.

### Why this is a new ADR rather than an edit to ADR-0035

Under the rule this repository now follows —
[`docs/adr/README.md`](./README.md), stated by
[ADR-0030](./0030-nest-logger-argument-shape.md): _an ADR's body may be corrected
in place only while nothing has relied on it; the test is citation, not merge._
ADR-0035 has not merged, and it has been relied on three times: the Phase 0C
plan, `.env.example` and `docs/OBSERVABILITY.md`. Two of those are operator
documents, which is the strongest form of reliance there is — somebody
configuring a service reads them and acts.

It is a correction and not a supersession, for the reason ADR-0035 itself gives
about ADR-0034: Decision points 1 and 2 are correct and are the live record of
the propagator difference. Moving them into a sixth document to change a
justification would make a reader trace six files for a fact that has not
changed. This is the shape [ADR-0028](./0028-temporal-bind-on-ip.md),
ADR-0030 and [ADR-0031](./0031-sentry-nextjs-integration-allowlist.md) use.

The argument against — that this chain is now six documents deep and a seventh
file is itself a cost — is real and loses. The chain is long because four
consequences were written without measurement; shortening it by editing the
record is how the fifth would get written.

## The measurement

`@sentry/nextjs@10.70.0` and `next@16.3.0` in a throwaway directory outside the
workspace, destroyed afterwards. `next build` was **not** run. Two cells
differing only in the `integrations` callback, each: `init`, then one `fetch`
through the global to a local HTTP server that records the request headers.

| Configuration                                                     | `BrowserTracing` active | `sentry-trace` sent | `baggage` sent |
| ----------------------------------------------------------------- | ----------------------- | ------------------- | -------------- |
| SDK defaults + `tracesSampleRate: 1` — **positive control**       | **true**                | **yes**             | **yes**        |
| `apps/web`'s `keepAllowedIntegrations` allowlist — **what ships** | **false**               | **no**              | **no**         |

**MEASURED.** The twelve integrations that survive the allowlist, exactly:
`InboundFilters`, `FunctionToString`, `ConversationId`, `BrowserApiErrors`,
`Breadcrumbs`, `GlobalHandlers`, `LinkedErrors`, `Dedupe`, `HttpContext`,
`CultureContext`, `BrowserSession`, `NextjsClientStackFrameNormalization`. The
control's fourteen add `BrowserTracing` and `WebVitals`.

**MEASURED:** in the shipped configuration the outbound request carried
`host, connection, accept, accept-language, sec-fetch-mode, user-agent,
accept-encoding` and nothing else. In the control it carried `sentry-trace` and
`baggage` in addition. **The positive control is what makes the negative worth
anything** — the same harness, one option different, detects the header when it
is there.

**MEASURED, in the repository rather than the spike:**
`apps/web/src/lib/telemetry/sentry.ts:78` omits `BrowserTracing` from
`ALLOWED_INTEGRATION_NAMES`, `keepAllowedIntegrations` (`:124`) filters by that
set, `apps/web/src/instrumentation-client.ts` sets no `tracesSampleRate` and
records the exclusion as deliberate, and
`apps/web/test/sentry-integrations.test.ts:173` already asserts that
`BrowserTracing` is the one and only integration the allowlist drops from the
SDK's real client defaults.

**INFERENCE, marked as such:** that no _other_ browser integration could attach
the header on some request shape this measurement did not exercise — XHR,
`next/router` prefetches, `navigator.sendBeacon`. What was measured is one
`fetch`. The reason to believe the general statement is that tracing-header
attachment lives in `browserTracingIntegration`'s fetch/XHR instrumentation, and
that integration is absent; but that is read from source, not run.

**INFERENCE:** that this stays true across a `@sentry/nextjs` upgrade. It is
guarded rather than assumed — the test at `sentry-integrations.test.ts:173`
compares against the SDK's _real_ defaults, so an upstream rename that
reintroduces tracing under another name fails it.

**Harness limit, stated:** Node with a minimal DOM shim, not a real browser, and
no `next build`. That weakens a positive result far more than a negative one,
and the control was positive in the same shim.

## Decision

1. **ADR-0035 Decision 3 is replaced by:** any caller that sends `sentry-trace`
   decides this API's sampling for that trace in both directions, and **nothing
   in the API restricts who may send it** — that is the operational point, and it
   is measured. **Our own browser is not such a caller today**: `apps/web` ships
   `@sentry/nextjs` but excludes `BrowserTracing` from its integration allowlist,
   and the shipped client attaches neither `sentry-trace` nor `baggage`.

2. **`.env.example` says so**, corrected in the same commit as this ADR.

3. **`docs/OBSERVABILITY.md` §2 says so.** Its replacement wording is handed to
   the agent holding that file rather than written here, because two agents must
   not both edit it.

4. **A claim about what `apps/web` sends is measured against `apps/web`.** The
   defect was not that the inference was unreasonable — it is a reasonable
   inference and it is false. It was that a sentence about a second application
   was written from a spike that never ran that application.

## Consequences

**Accepted:** the true statement is weaker and less alarming than the false one,
and it is worth being clear that this makes the underlying finding _more_
load-bearing rather than less: ADR-0035's `sentry-trace` cells are unchanged, an
inbound `sentry-trace: …-0` still exports zero spans at rate 1, and the API still
has no control over who sends it. What changed is that the example given was our
own front end, and it is not. A reader who acted on the old sentence would have
gone looking for a client-side sample rate in `apps/web` that does not exist —
`instrumentation-client.ts` sets none, deliberately.

**Gained:** the fourth instance of this defect class was caught before merge, by
someone reading the shipped code rather than the ADR. The property is now pinned
by a test that already existed for a different reason, and the labelling
convention in this document is the first attempt in the chain to make the
measured/inferred boundary visible at the sentence level rather than in a
retrospective.

**Not verified:** whether any browser request shape other than `fetch` attaches
the header; whether a real browser under `next start` behaves as the shim did.
Both are marked INFERENCE above rather than left to be assumed.
