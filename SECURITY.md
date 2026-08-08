# Security Policy

> This is the disclosure policy. The security **architecture** and threat model are in [docs/SECURITY.md](./docs/SECURITY.md).

## Reporting a vulnerability

Email **security@metrika.co** with:

- What you found and where
- Steps to reproduce
- What an attacker could achieve
- Any proof-of-concept code

Please do **not** open a public issue.

**Response targets:** acknowledgement within 2 business days · initial assessment within 5 business days · a remediation plan for confirmed issues within 10 business days.

We will keep you informed, credit you if you would like, and let you know when the issue is resolved.

## Scope

In scope: the Metrika web application, API, workers, and infrastructure configuration.

Out of scope: third-party services we do not operate (Clerk, Vercel, AWS, Temporal Cloud, payment providers — report those to their own programmes); social engineering; physical attacks; automated scanner output without a demonstrated impact; and denial of service through sheer volume.

## Safe harbour

We will not pursue legal action against good-faith research that respects user privacy, avoids degrading our service, and does not access, modify or retain data belonging to anyone other than yourself. If you are unsure whether something is in bounds, ask first.

## What we care most about

Metrika stores confidential architectural designs — unbuilt buildings that would be professionally damaging for a customer to have leaked. Findings in these areas are treated as the highest severity:

- **Cross-tenant data access.** Any path by which one organization can read another's models, quotes or orders.
- **Signed URL abuse.** Any way to obtain or extend access to an original model file.
- **Authentication or authorization bypass.**
- **Code execution in the geometry or slicing workers** via a crafted model file.
- **Payment webhook forgery or replay.**

## Our commitments

- All data encrypted in transit (TLS 1.2+) and at rest (AWS KMS).
- Customer models are private by default; original files are never served through a CDN, and the browser receives only decimated derivatives.
- Every access to an original model file is audited.
- Tenant isolation is enforced at three independent layers, including PostgreSQL row-level security, with an automated cross-tenant test suite on every pull request.
- Mesh parsing — the component most exposed to hostile input — runs with no network egress, no database credentials, a read-only filesystem and hard resource limits.
- Dependency, container, secret and static analysis scanning run in CI.
- An external penetration test is a launch gate.

## Disclosure

We prefer coordinated disclosure. Once a fix is deployed and users have had a reasonable window to be protected, we are happy for you to publish. We will not ask for indefinite silence.
