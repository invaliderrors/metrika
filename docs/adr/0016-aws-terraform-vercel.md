# ADR-0016 — AWS + Terraform for the backend; Vercel for the web app

**Status:** Accepted · **Date:** 2026-08-07

## Context

The backend needs containers with hard CPU and memory limits, no-egress networking for the workers, encrypted managed Postgres, object storage with fine-grained IAM, and a secrets store. The frontend needs excellent RSC support and preview deployments.

## Decision

**AWS** for the API, workers, database, cache and storage, defined entirely in **Terraform** from Phase 0, with separate AWS accounts for staging and production.

**Vercel** for `apps/web`.

**VPC endpoints instead of a NAT Gateway** — the primary security control for the workers (no internet egress at all) and the largest single cost saving in a small AWS footprint.

## Alternatives

- **Everything on Vercel** — no way to run a containerised slicer with hard resource limits and no network egress. Not viable.
- **Everything on AWS, Next on ECS** — one ops surface and one secret store, at the cost of worse RSC ergonomics, no preview deployments, and a CDN to configure. A reasonable fallback if the split proves painful; revisit at Phase 13.
- **Fly.io / Railway** — much better DX for a solo operator, but weaker IAM, weaker network isolation for the workers, and less mature secrets management. The worker isolation requirement decides it.
- **Pulumi / CDK** — real programming languages for infrastructure, at the cost of `terraform plan`'s reviewability, which matters more when the reviewer is the same person who wrote the change.
- **Deferring Terraform** — rejected. Retrofitting IaC onto hand-clicked AWS is consistently worse than starting with it, and there is no deadline forcing the shortcut.

## Consequences

**Accepted:** Two deploy surfaces, two secret stores, and a cross-origin API. The last is neutralised by bearer-token authentication (ADR-0012) rather than cookies. Terraform is verbose and has a learning curve.

**Gained:** Hard resource limits and no-egress networking for the components processing hostile input. Account-level blast-radius isolation between staging and production. Reviewable infrastructure changes as `terraform plan` comments on pull requests. Nightly drift detection, so a hand-edited resource is caught rather than discovered during the next apply. And the frontend deploys with per-pull-request previews at effectively no operational cost.
