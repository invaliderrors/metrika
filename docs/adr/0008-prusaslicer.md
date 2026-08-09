# ADR-0008 — PrusaSlicer CLI behind a `SlicerEngine` port

**Status:** Superseded by [ADR-0022](./0022-orcaslicer.md) · **Date:** 2026-08-07

## Context

Pricing must be based on actual manufacturing metrics — filament mass, support mass, print time, layer count — not on geometric volume. That requires a real slicer.

## Decision

PrusaSlicer, invoked as an unmodified binary in a separate process from a containerised worker, pinned by image digest, behind a `SlicerEngine` port so no business code references it.

`FakeSlicerEngine` (deterministic) is the default for local development, E2E and CI.

## Alternatives

- **CuraEngine** — also AGPL, lighter, but its metrics are less directly exposed and its profile model is more awkward to drive from a CLI. Retained as a contingency.
- **OrcaSlicer** — better modern-printer profiles, actively developed, and the natural candidate when Bambu support matters. It is a PrusaSlicer fork, so the licensing position is identical. Re-evaluate at Phase 14.
- **Writing our own slicer** — years of work to reach industrial quality, and wrong estimates for most of that time. Rejected.
- **Commercial SDK** — clear licensing, but cost and lock-in at a stage where neither is affordable.

## Consequences

**Accepted — licensing is an open question.** PrusaSlicer is AGPL-3.0. This architecture invokes an unmodified upstream binary as a separate process, with no linking, communicating over `argv` and files. What remains genuinely open is how AGPL §13 applies to a hosted commercial service that invokes an AGPL program as a subprocess. Informed people read this differently, and **this ADR does not resolve it**. Formal legal review is a launch gate in Phase 13.

Three things follow: do not modify the binary, because a patched build removes the simplest available position; record provenance (upstream version, source URL, image digest, unmodified attestation) in `infra/docker/slicer/PROVENANCE.md`; and keep the `SlicerEngine` port so the answer can change without a rewrite.

**Also accepted:** slicer upgrades change the cache key and invalidate the entire slice cache — correct, but it means an upgrade is a deliberate reviewed event, not an automatic dependency bump. Renovate is configured to exclude it.

**Gained:** Industry-standard metrics, a large profile ecosystem, full reproducibility through the pinned digest recorded on every `SliceResult`, and a fast deterministic fake that makes the E2E suite viable.
