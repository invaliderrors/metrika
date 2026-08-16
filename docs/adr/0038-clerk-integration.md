# ADR-0038 — Clerk verification is networkless, and four of its checks are not what the name suggests

**Status:** Accepted · **Date:** 2026-08-14 · **Scopes**
[ADR-0012](./0012-authentication.md), which chose Clerk for authentication only
and declared that authorization decisions never read organization claims from
the JWT — without naming a package, a version, or a verification path.

## Context

Plan 1A Task 1 asks five questions, and the first one decides whether Phase 1 is
testable at all: **there is no Clerk instance on this machine, and CI has never
held a secret.** Every environment variable in `.github/workflows/ci.yml` is a
non-secret literal, and the two `NEXT_PUBLIC_*` keys carry an inline comment
saying they are "NOT SECRETS, and they never can be". If verifying a token
requires reaching Clerk, then the forged-token fixture
[`SECURITY.md`](../SECURITY.md) row 12 demands cannot run in `verify` or
`integration`, and neither can any test that boots the app behind the guard.

The spike ran in a throwaway directory outside the workspace on node 24.19.0,
against `@clerk/backend@3.16.6`, `@clerk/nextjs@7.7.6` and `jose@6.2.9`, with no
network access to Clerk and no account. Every negative case was minted locally
from a generated RS256 keypair. Exit values and thrown types were read from the
caught error object, never from a log line.

This repository has now lost a class of checking three times to the softer
failure — a dependency that installs, warns, and then silently does less than it
appears to ([ADR-0021](./0021-next-major-and-frontend-stack.md),
[ADR-0023](./0023-eslint-plugin-resolution.md),
[ADR-0032](./0032-sentry-fastify-collision-is-swallowed.md)). A verifier is the
worst possible place for that shape, because the silent version of "did less"
is "accepted a token it should have refused". So each check was exercised for
what it does when it is **not** doing its job, and four of them turned out not
to do what their name suggests.

### Peer and engine ranges, measured before installing anything

| Package          | Version | Declares                                                                                            | Our pin      | Verdict |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------- | ------------ | ------- |
| `@clerk/backend` | 3.16.6  | `engines.node >=20.9.0`, no `peerDependencies` at all                                               | node 24.19.0 | inside  |
| `@clerk/nextjs`  | 7.7.6   | `next: ^15.2.8 \|\| ^15.3.8 \|\| ^15.4.10 \|\| ^15.5.9 \|\| ^15.6.0-0 \|\| ^16.0.10 \|\| ^16.1.0-0` | next 16.3.0  | inside  |
| `@clerk/nextjs`  | 7.7.6   | `react` / `react-dom: ^18.0.0 \|\| ~19.0.3 \|\| ~19.1.4 \|\| ~19.2.3 \|\| ~19.3.0-0`                | 19.2.8       | inside  |
| `@clerk/nextjs`  | 7.7.6   | `engines.node >=20.9.0`                                                                             | node 24.19.0 | inside  |
| `jose`           | 6.2.9   | no `engines`                                                                                        | node 24.19.0 | n/a     |

`~19.2.3` is `>=19.2.3 <19.3.0`, and `^16.1.0-0` is `>=16.1.0-0 <17.0.0`; both
of our pins fall inside. **Neither package declares a TypeScript peer**, so
TypeScript 6.0.3 cannot be excluded by a range — which means it also cannot be
_cleared_ by one, and the first `pnpm typecheck` after Task 5 installs
`@clerk/backend` is the real measurement. That is stated here so a green install
is not mistaken for evidence.

## Decision

**1. `@clerk/backend@3.16.6`, verified networkless through `verifyToken(token, { jwtKey })`.**
Not `jose` + a hand-rolled JWKS client. The spike's fallback trigger was
"`verifyToken` insists on fetching from a Clerk-hosted JWKS URL", and it does
not: `jwtKey` is a documented, first-class option
(`node_modules/@clerk/backend/dist/tokens/verify.d.ts`, `VerifyTokenOptions`),
and a token signed by a locally generated RS256 key verified against its own
exported SPKI PEM with no network and no account.

```
A verifyToken({ jwtKey: PEM })       OK sub=user_2abcDEF sid=sess_2xyz
D jose createLocalJWKSet             OK sub=user_2abcDEF      (the rejected alternative, also works)
```

**2. Every negative fixture Task 5 needs runs offline**, because the same
`jwtKey` path produces a typed rejection for each one. Measured, with the exact
`reason` code Task 5 maps to `DomainError('UNAUTHENTICATED')`:

| Case                               | Thrown                   | `reason`                           |
| ---------------------------------- | ------------------------ | ---------------------------------- |
| signature from another key         | `TokenVerificationError` | `token-invalid-signature`          |
| `exp` in the past                  | `TokenVerificationError` | `token-expired`                    |
| `nbf` in the future                | `TokenVerificationError` | `token-not-active-yet`             |
| `alg: none`                        | `TokenVerificationError` | `token-invalid-algorithm`          |
| HS256 signed with the public key   | `TokenVerificationError` | `token-invalid-algorithm`          |
| structurally malformed             | `TokenVerificationError` | `token-invalid`                    |
| `sub` absent                       | `TokenVerificationError` | `token-verification-failed`        |
| `typ` not exactly `JWT`, or absent | `TokenVerificationError` | `token-invalid`                    |
| `azp` mismatched **or absent**     | `TokenVerificationError` | `token-invalid-authorized-parties` |

The algorithm-confusion pair is worth its own line: the error message enumerates
`Supported: RS256,RS384,RS512`, so the allowlist is on the library's side of the
boundary rather than ours. The class name is exported as `TokenVerificationError`
but arrives as `_TokenVerificationError` on `constructor.name` — **match on
`reason`, never on the constructor name.**

**3. `authorizedParties` is a real control and fails closed.** A token whose
`azp` is absent is rejected when `authorizedParties` is supplied. Task 5 passes
the `apps/web` origin.

**4. Task 5 asserts `iss` itself, in our code, because the library never will.**

**5. `@clerk/nextjs` requires `clerkMiddleware()`, so `apps/web` gains a fourth runtime.**
`auth()` in a Server Component throws without it, with the literal text
`Clerk: auth() was called but Clerk can't detect usage of clerkMiddleware().`
(`dist/esm/server/errors.js:23`). There is no configuration that removes the
requirement. Task 8 therefore adds `apps/web/src/middleware.ts`, and it does so
knowing the cost: a runtime with no Sentry init branch, no request-ID story, and
no sanctioned `process.env` reader — `apps/web/src/config/env.ts` is the only
one, per CLAUDE.md.

**6. An RSC obtains the token through `auth()` from `@clerk/nextjs/server`,
whose returned object carries `getToken`** (`@clerk/backend`'s `AuthObject`,
`authObjects.d.ts:32`). Task 8 is an RSC fetch, not a client-side one.

## What the names promise and the measurements refuse

Four checks do not do what an engineer would reasonably assume, and every one of
them fails **open**. They are listed here rather than in Consequences because
each is a decision Task 5 must implement, not a caveat to remember.

This is not academic. [`SECURITY.md`](../SECURITY.md)'s threat table, row 12
("Auth bypass via forged JWT", Critical), names its mitigation as
"JWKS verification, `aud`/`iss`/`exp` checks". Of those three, **`exp` is the
only one `@clerk/backend` actually delivers.** A Task 5 written against that row
by reading it — passing `audience`, assuming `iss` is covered by "JWKS
verification" — would satisfy the document and mitigate one third of the threat.

**`iss` is never validated. There is no option for it.** `VerifyJwtOptions`
exposes exactly `audience`, `authorizedParties`, `clockSkewInMs`, `key` and
`headerType` (`dist/jwt/verifyJwt.d.ts`) — no `issuer`. Measured: a token whose
`iss` is `https://evil.test`, signed with the expected key, is **accepted**.
Pinning `jwtKey` to one public key binds the issuer implicitly _today_, so this
is not currently exploitable; it becomes exploitable the moment anyone moves to
the remote-JWKS path, where several issuers can share a key set. Task 5 compares
`payload.iss` against a configured value and rejects on mismatch, with a fixture.

**`audience` is not a control, because an absent `aud` passes it.** Measured: a
token carrying **no** `aud` claim, verified with `audience: 'metrika-api'`
supplied, is **accepted**; only a token that carries a _different_ `aud` is
rejected. An option that is enforced only when the attacker includes the claim
is not a gate. Task 5 does not rely on `audience`; if an audience check is ever
wanted it is our own assertion, like `iss`.

**`kid` is ignored on the `jwtKey` path.** Measured: a token whose header
`kid` names a key that is not the one supplied is **accepted**, because with a
single injected PEM there is no key set to miss. This is correct behaviour for
the option and it deletes a fixture the plan assumed: **"`kid` not in the key
set" is untestable through `verifyToken` + `jwtKey`.** Task 5 either drops that
case with this ADR cited, or exercises it against `jose`'s
`createLocalJWKSet`, which does resolve by `kid`. Do not write a fixture that
asserts rejection here — it would fail, and the temptation would be to weaken it.

**`typ` is enforced by default, which is the one that fails closed** — and it is
recorded because the type declaration says the opposite. `JwtHeader.typ` is
declared **optional** (`@clerk/shared/dist/types/jwtv2.d.ts:18`), while at
runtime an absent `typ` is rejected without any `headerType` option being
passed. A fixture built from the type would be minting tokens the verifier
refuses.

## The claim set, and the trap inside it

`sub` is the stable user identifier and becomes `User.externalAuthId`. It is
declared required, as are `iss`, `sid`, `nbf`, `exp` and `iat`. `azp`, `act`
(actor — impersonation), `fva`, `sts`, `fea` and `pla` are optional.

**The organization claims exist in two mutually exclusive versioned shapes**, and
this is the finding Task 5 must act on rather than merely know:

| Version | Discriminator   | Organization claims                                                |
| ------- | --------------- | ------------------------------------------------------------------ |
| v1      | `v?: undefined` | `org_id`, `org_slug`, `org_role`, `org_permissions`                |
| v2      | `v: 2`          | `o: { id, slg?, rol?, per?, fpm? }`; all four v1 names are `never` |

[ADR-0012](./0012-authentication.md) forbids reading a role from a token, so
Metrika ignores all of them — but ignoring must be **deliberate and complete**.
Someone later "adding organization support" by reading `org_id` would handle v1
and silently miss every v2 token, which is the failure mode where the code looks
correct and the tenancy is wrong. Task 5 names both shapes in the comment that
explains why neither is read.

## Alternatives

**`jose` + a hand-rolled JWKS client.** Measured working
(`createLocalJWKSet` verified the same token, and unlike `verifyToken` it
resolves by `kid`). Rejected as the primary path because it puts a
security-critical parser under our maintenance for no capability we lack, and
because `verifyToken`'s `reason` codes are a better error surface than
re-deriving one. `jose` is still a direct dependency — Task 5 uses it to mint
tokens in fixtures, and it is the escape hatch if the `kid` gap ever needs
closing.

**`authenticateRequest()` instead of `verifyToken()`.** The library recommends
it and it does more: cookie handling, handshake, satellite domains. Rejected for
`apps/api`, which takes a bearer token from a first-party browser and has no
cookie or handshake story; the extra surface is extra behaviour we would not
test. Revisit if Phase 9's payment redirects need it.

**Deferring the spike until a Clerk account exists.** Rejected: it would have
put the discovery that `iss` is unchecked and `aud` is not a gate _after_ Task 5
was written against the assumption that they were.

## Consequences

1. **Tasks 5 and 8 install `@clerk/backend@3.16.6`, `@clerk/nextjs@7.7.6` and
   `jose@6.2.9`, pinned exactly** — `packages/typescript-config/test/dependency-pins.test.ts`
   fails on a range.
2. **`iss` is asserted by our code, with a fixture.** So is anything else the
   table above marks as failing open.
3. **The "`kid` not in the key set" fixture is dropped from Task 5**, citing this
   ADR, or moved onto `jose`. It cannot pass on the chosen path.
4. **`apps/web` gains `src/middleware.ts`**, and with it a fourth runtime whose
   Sentry, request-ID and configuration stories are unwritten. Task 8 states
   which of them it leaves open.
5. **CI needs no secret for the authentication tests.** Every fixture in the
   table above is minted locally. The Clerk **publishable** key Task 8 needs for
   the browser half is not a secret and can be a literal, exactly like the two
   `NEXT_PUBLIC_*` keys already in the workflow.
6. **Error mapping keys on `reason`, not on the constructor name**, which is
   mangled to `_TokenVerificationError`.
7. **TypeScript 6.0.3 is uncleared.** No Clerk package declares a TypeScript
   peer, so the first `pnpm typecheck` after the install in Task 5 is the
   measurement. If the types do not resolve, that is a spike result arriving
   late, not a Task 5 defect.

## What did not work

- `clerk.verifyJwt` — assumed to exist as a lower-level primitive; it is not
  exported. `TypeError: clerk.verifyJwt is not a function`. The only
  auth-relevant export of `@clerk/backend`'s root is `verifyToken`.
- The first `typ` measurement in this spike was **wrong and was re-run**. The
  minting helper set `typ: 'JWT'` unconditionally, so the case labelled "typ:
  JWS instead of JWT" tested a `JWT` token and reported ACCEPTED. Re-measured
  with the header actually varied, `typ` is enforced in all three directions.
  The claim in this ADR is the second measurement; the first is recorded because
  a spike that reports only its successes is the one to distrust.
- `npm i @clerk/nextjs` without `--legacy-peer-deps` pulls Next 16 into the
  spike directory. Irrelevant to the decision, noted so the next spike is faster.
