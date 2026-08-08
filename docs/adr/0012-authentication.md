# ADR-0012 — Clerk for authentication only; Metrika owns organizations

**Status:** Accepted · **Date:** 2026-08-07

## Context

Metrika needs email/password, Google and Microsoft sign-in now, enterprise SSO eventually, and multi-tenant organizations with roles from day one. Building authentication is a distraction; building tenancy is the product.

## Decision

**Clerk provides authentication only.** It answers "who is this person" with a verified JWT.

**Metrika owns `Organization`, `OrganizationMember`, `OrganizationInvitation` and every role.** The domain's primary key is our own `UserId`; `User.externalAuthId` + `authProvider` map to Clerk with a unique constraint.

**Authorization decisions never read organization claims from the JWT.** The token establishes identity; the database establishes permission. An `organizationId` in a request is a claim to be verified, never a fact.

## Alternatives

- **Clerk Organizations** — would mean mirroring membership into our database via webhooks, creating a drift surface on exactly the data authorization depends on. A missed webhook becomes a permissions bug. Rejected.
- **Auth0** — the best enterprise SSO story and genuinely standards-first, but heavier DX for organizations and it gets expensive quickly.
- **WorkOS** — strongest SSO/SCIM story; a good candidate if enterprise customers arrive sooner than expected.
- **Self-hosted (better-auth, Lucia)** — full control and no per-MAU cost, but it means owning password reset, MFA, session security and eventually SAML. For a solo builder that is time taken directly from the product.

## Consequences

**Accepted:** A per-MAU vendor cost. The invitation flow must be built ourselves (roughly a day). Discipline is required to keep resisting Clerk's Organizations feature, which will look convenient at some point.

**Gained:** No webhook synchronisation and no drift on permission data. Switching auth providers becomes a data migration on one column rather than a rewrite of the tenancy model. And because Vercel and AWS are different origins, bearer tokens rather than cookies sidestep the entire `SameSite`/CSRF problem class.
