# ADR-0022 — OrcaSlicer CLI behind the `SlicerEngine` port

**Status:** Accepted, pending legal review · **Date:** 2026-08-09 · **Supersedes:** [ADR-0008](./0008-prusaslicer.md)

## Context

[ADR-0008](./0008-prusaslicer.md) chose PrusaSlicer and listed OrcaSlicer as an alternative with "better modern-printer profiles, actively developed", to be re-evaluated at Phase 14. That re-evaluation is being taken now, before Phase 6 builds anything against a CLI surface — which is the cheap moment to take it, because the engine is still only a port with a fake behind it.

The `SlicerEngine` port exists precisely so this decision can change without a rewrite. This ADR is that port being used as intended, not a reversal of a mistake.

## Decision

**OrcaSlicer**, invoked as an unmodified binary in a separate process from a containerised worker, pinned by image digest, behind the same `SlicerEngine` port. `FakeSlicerEngine` remains the default for local development, E2E and CI.

Everything ADR-0008 decided about _how_ the slicer is used is unchanged: unmodified upstream binary, separate process, no linking, no network, non-root, `RLIMIT_AS`/`RLIMIT_CPU`, provenance recorded in `infra/docker/slicer/PROVENANCE.md`, the digest recorded on every `SliceResult`, and slicer upgrades excluded from Renovate because they invalidate the entire slice cache.

## Why

- **Modern-printer profile coverage.** OrcaSlicer's profile ecosystem tracks the printers this business actually buys, including Bambu hardware, without hand-maintaining a profile per machine. This was ADR-0008's stated reason to revisit.
- **Machine-readable metrics.** Slice results land in `Metadata/slice_info.config` inside the exported `.gcode.3mf` as structured data — filament usage in millimetres and grams **per slot**, estimated print time, layer count — rather than being scraped from a human-readable CLI summary. Per-slot reporting is strictly better for a multi-material future.
- **Active development.** ADR-0008's own risk note about a CLI surface that changes between majors applies to both; an actively developed project is the better side of that trade.

## Consequences

**Licensing is unchanged, and remains open.** OrcaSlicer is **AGPL-3.0**, exactly as PrusaSlicer is — its lineage is Slic3r → PrusaSlicer → Bambu Studio → OrcaSlicer. ADR-0008 already recorded that the licensing position for a fork is identical, and switching neither improves nor worsens it. How AGPL §13 applies to a hosted commercial service invoking an AGPL program as a subprocess is still genuinely open, informed people still read it differently, and **this ADR does not resolve it either**. Formal legal review remains a launch gate in Phase 13. See [R3](../RISK_REGISTER.md#r3--slicer-agpl-obligations).

**Three things in the pipeline change shape**, and they are the reason this is an ADR rather than a find-and-replace:

1. **Profiles are JSON, not `.ini`.** Loaded as `--load-settings "machine.json;process.json"` and `--load-filaments "f1.json;f2.json"`, semicolon-separated, one filament file per slot. `PrintProfileVersion.slicerProfilePayload` is stored as structured JSON either way, so the domain model is unaffected — but the renderer that turns a payload into slicer input targets a different format, and the override allowlist is keyed on different names.

2. **The metrics cross-check loses one of its two sources.** SLICING.md required parsing metrics from `--info` **and** the G-code comment block and treating a disagreement beyond tolerance as `SLICING_FAILED`. OrcaSlicer's `--info` reports model information _without slicing_, so it is not a metrics source at all. The replacement pair is `Metadata/slice_info.config` and the G-code comment block, both inside the exported 3MF.

   **This is weaker than what it replaces, and is recorded as weaker.** Under PrusaSlicer the two sources came from separate code paths; here both are produced by the same slice run, so a fault in the slicing itself would corrupt both consistently and the cross-check would not fire. It still catches parser drift and format changes across upgrades, which is what it fires on in practice. If Phase 6 finds a genuinely independent second source, take it.

3. **The container build differs.** OrcaSlicer ships as an AppImage; the binary is extracted at image build time rather than installed from a package. Headless slicing is expected to work without an X server — plate thumbnails are blank in headless mode, which we do not use — but **this is the one claim here that has not been measured**, and Phase 6 must verify it before the pipeline depends on it — with a spike that proves a slice completes in the real container, not merely that the binary answers `--help`.

**Accepted:** ADR-0008's implementation notes are superseded before anything was built against them, so the cost is documentation rather than code. The cross-check weakens as described. One unverified assumption is carried into Phase 6 with an owner.

**Gained:** Profile coverage for the printers actually being bought, structured per-slot metrics instead of scraped text, and an actively maintained upstream — at no change to the licensing position, which was the thing worth protecting.

## Alternatives

- **Stay on PrusaSlicer.** Its CLI is mature and its `--info`/G-code cross-check is genuinely more independent than the replacement. Rejected because the profile ecosystem is the binding constraint on which printers can be quoted, and because switching later — after Phase 6 has built a renderer, a parser and a regression matrix against `.ini` and `--info` — costs far more than switching now.
- **CuraEngine.** Unchanged from ADR-0008: also AGPL, lighter, metrics less directly exposed, profile model more awkward to drive. Retained as the contingency.
- **Support both behind the port.** The port makes it possible, and it is the obvious hedge. Rejected for now: two engines means two profile renderers, two metric parsers and two regression matrices, and the slice cache key would have to carry the engine identity. Reconsider only if a printer is bought that one engine cannot drive.
- **Writing our own slicer.** Unchanged from ADR-0008: rejected.
