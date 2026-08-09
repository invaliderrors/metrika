# Metrika — Slicing Architecture

> How a mesh becomes manufacturing metrics, reproducibly. Companion to [3D_PIPELINE.md](./3D_PIPELINE.md) and [PRICING_ENGINE.md](./PRICING_ENGINE.md).

---

## 1. The abstraction

Slicing is an infrastructure concern behind a port. **No business code ever references OrcaSlicer.**

```ts
// apps/api/src/modules/slicing/application/ports/slicer-engine.port.ts

export interface SlicerEngine {
  readonly kind: SlicerEngineKind;               // 'ORCA_SLICER' | 'CURA_ENGINE' | 'FAKE'

  getVersion(): Promise<SlicerVersion>;          // { engine, semver, imageDigest }
  getCapabilities(): Promise<SlicerCapabilities>;
  validateProfile(profile: SlicerProfilePayload): Promise<Result<void, ProfileValidationError>>;
  estimate(request: SliceRequest): Promise<Result<SliceEstimate, SlicingError>>;   // fast, approximate
  slice(request: SliceRequest, signal: AbortSignal): Promise<Result<SliceOutput, SlicingError>>;
}

export interface SliceRequest {
  readonly inputMeshUri: S3Uri;                  // SLICE_INPUT_3MF derivative
  readonly transform: { scale: ScaleSpec; orientation: Orientation };
  readonly printerProfile: SlicerProfilePayload;
  readonly printProfile: SlicerProfilePayload;
  readonly materialProfile: SlicerProfilePayload;
  readonly supportStrategy: SupportStrategy;
  readonly overrides: ValidatedOverrides;
  readonly cacheKey: SliceCacheKey;
}

export interface SliceOutput {
  readonly metrics: SliceMetrics;                // branded units
  readonly gcodeUri: S3Uri;
  readonly slicerVersion: SlicerVersion;
  readonly rawMetrics: Readonly<Record<string, string>>;   // everything the slicer emitted
  readonly warnings: readonly SlicerWarning[];
}
```

Implementations:

| Implementation     | Where                                                                 | Used by                                    |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------ |
| `OrcaSlicerEngine` | dispatches a Temporal activity to the slicer worker                   | staging, production                        |
| `FakeSlicerEngine` | `packages/testing` — deterministic metrics from a hash of the request | E2E, local dev by default, CI              |
| `CuraSlicerEngine` | not built                                                             | contingency if OrcaSlicer becomes unusable |

`FakeSlicerEngine` is not a convenience; it is a load-bearing architectural payoff. It makes the Playwright golden-path test run in seconds instead of minutes, makes it deterministic, and lets a developer get a complete quote flow working locally without a 400 MB slicer container. Real slicer behaviour is covered by the regression suite, where it belongs.

---

## 2. Why OrcaSlicer

| Option             | For                                                                                                                                                                                              | Against                                                                                                 | Verdict          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------- |
| **OrcaSlicer CLI** | Profile ecosystem tracks the printers actually being bought, Bambu included; metrics land as structured data in `Metadata/slice_info.config`, filament reported **per slot**; actively developed | **AGPL-3.0**; CLI surface changes between majors; AppImage extraction at image build; heavyweight image | **Chosen**       |
| PrusaSlicer CLI    | Mature; its `--info` output is a genuinely independent second metrics source, which OrcaSlicer's is not                                                                                          | Thinner coverage of the modern printers this business buys                                              | Superseded       |
| CuraEngine         | Also AGPL; lighter; embeddable                                                                                                                                                                   | Its metrics are less directly exposed; profile model is more awkward to drive from a CLI                | Contingency      |
| Write our own      | No licence question                                                                                                                                                                              | Years of work to reach industrial quality; would produce wrong estimates for a long time                | Rejected         |
| Commercial SDK     | Clear licensing                                                                                                                                                                                  | Cost and lock-in at a stage where neither is affordable                                                 | Rejected for now |

Every credible open slicer is AGPL. That is the state of the ecosystem, and it means the licensing question must be answered rather than avoided. OrcaSlicer's lineage is Slic3r → PrusaSlicer → Bambu Studio → OrcaSlicer, so switching between them changes nothing about the licence. See [ADR-0022](./adr/0022-orcaslicer.md), which supersedes [ADR-0008](./adr/0008-prusaslicer.md).

---

## 3. Licensing — an open, launch-blocking question

**OrcaSlicer is licensed AGPL-3.0.**

What this architecture does, factually:

- Invokes an **unmodified upstream binary** as a **separate operating-system process**.
- Does **not** link against slicer code — no shared address space, no library linkage, no derived work in the linking sense.
- Communicates over `argv`, files and exit codes.
- Ships the binary and its licence text inside a container image that Metrika operates but does not distribute.
- Does not expose the slicer's own user interface or API to end users; Metrika's API is a distinct application that consumes its output.

**What remains genuinely open** is how AGPL §13 (the network-interaction clause) applies to a hosted service that invokes an AGPL program as a subprocess as part of delivering a commercial service. Reasonable, informed people read this differently. That is a question for counsel with the actual facts of the deployment in front of them, not a question an engineer should answer in an architecture document — and this document does not answer it.

**Therefore:**

1. **Formal legal review is a launch gate.** It appears in [RISK_REGISTER.md](./RISK_REGISTER.md) and in the Phase 13 definition of done. Launching without it is not an acceptable risk decision.
2. Until it is cleared, treat the outcome as uncertain and preserve optionality. The `SlicerEngine` port exists partly for this reason.
3. Record exactly what is deployed: the image digest, the upstream version, the source URL and the unmodified-binary attestation, in `infra/docker/slicer/PROVENANCE.md`. If the answer requires offering corresponding source, having the provenance already recorded turns a crisis into an afternoon.
4. Do not modify the slicer source. A patched binary changes the analysis materially and removes the simplest available position.

---

## 4. The slicer worker

```
apps/workers/slicer/
├── Dockerfile              # python:3.12-slim + OrcaSlicer AppImage, extracted, pinned by checksum
├── src/metrika_slicer/
│   ├── activities.py       # Temporal activities
│   ├── engine.py           # subprocess invocation, argv construction, timeout
│   ├── profiles.py         # JSON profile payload → OrcaSlicer machine/process/filament JSON
│   ├── parser.py           # slice_info.config + G-code comments → SliceMetrics
│   └── sandbox.py          # rlimits, tmpfs scratch, cleanup
└── tests/
    ├── test_parser.py      # against committed G-code fixtures
    └── test_regression.py  # nightly, pinned digest, tolerance assertions
```

Execution, step by step:

1. Download `SLICE_INPUT_3MF` from S3 to a `tmpfs` scratch directory with a size cap.
2. Render the three profile payloads (printer, print, material) into OrcaSlicer's machine, process and filament JSON. Overrides are applied here, from an **allowlist** — a customer-supplied key that is not on the list is `INVALID_PRINT_CONFIGURATION`, never passed through. Config injection into a CLI is a real attack surface, and it does not become less of one because the format is JSON rather than `.ini`.
3. Apply scale and orientation as explicit transform arguments.
4. Invoke the binary with `--slice` and `--export-3mf`, profiles passed as `--load-settings "machine.json;process.json"` and `--load-filaments` (one file per slot, semicolon-separated), with `RLIMIT_AS` and `RLIMIT_CPU` set, a wall-clock alarm, no network, and a non-root user.
5. Heartbeat to Temporal every 10 s so a hung slice is detected in seconds rather than at the schedule-to-close timeout.
6. Parse the metrics: filament volume/mass, support volume/mass, estimated print time, layer count, first-layer footprint. **Parse from `Metadata/slice_info.config` inside the exported `.gcode.3mf` and from the G-code comment block, cross-checking both.** A disagreement beyond tolerance is a `SLICING_FAILED`, not a silently-picked number.

   Note what this cross-check is and is not. Under PrusaSlicer the two sources — `--info` and the G-code comments — came from separate code paths, so they could disagree about a genuinely bad slice. OrcaSlicer's `--info` reports model information _without slicing_ and is not a metrics source at all; both replacement sources are produced by the same slice run. **The check therefore catches parser drift and format changes across upgrades — which is what it fires on in practice — but not a fault in the slicing itself, which would corrupt both consistently.** Recorded as weaker rather than quietly carried over; if Phase 6 finds a genuinely independent second source, take it.

   `slice_info.config` reports filament usage in millimetres and grams **per slot**. Sum across slots for the single-material case rather than reading slot 0, or a multi-material print is priced as though it used one filament.

7. Compress the G-code with zstd and upload to `gcode/{orgId}/{sliceJobId}/{cacheKey}.gcode.zst`.
8. Return `SliceOutput` — metrics and S3 keys only. G-code never travels through Temporal.
9. Scrub the scratch directory unconditionally, including on failure.

**Fargate Spot** runs this workload. A Spot interruption mid-slice is simply an activity retry, which Temporal already handles, and slicing is the most CPU-expensive thing the platform does. This is one of the clearest wins available in the infrastructure.

---

## 5. Reproducibility and the cache

The cache key is the reproducibility key. They are the same value because they answer the same question: _does this exact combination of inputs already have an answer?_

```
cacheKey = sha256(canonicalJson({
  cacheKeySchemaVersion: 1,
  sliceInputSha256,          // content hash of the actual mesh bytes
  scaleSpec,                 // normalised
  orientation,               // normalised quaternion, fixed precision
  supportStrategy,
  overrides,                 // sorted keys
  printProfileVersionHash,
  printerProfileVersionHash,
  materialProfileVersionHash,
  slicerEngine,
  slicerVersion,             // includes image digest
}))
```

Canonical serialisation — sorted keys, no whitespace, fixed decimal precision, explicit `null` handling — is defined once in `packages/contracts/src/hashing.ts` and property-tested for stability across platforms and Node versions. A hash function that is not stable is worse than no cache.

**`SliceJob.cacheKey` is `UNIQUE`.** A duplicate slice request fails to insert and returns the existing result. Duplicate work is impossible at the database level, not merely unlikely at the application level.

Consequences that follow automatically:

- Upgrading the slicer changes `slicerVersion` → changes every key → nothing stale is ever reused, and old quotes remain reproducible against their recorded version.
- Publishing a new material profile version changes its hash → new key. A customer who reconfigures back to a previous setup gets an instant cache hit.
- `cacheKeySchemaVersion` is the escape hatch: if we discover an input that should have been in the key (a real bug), bumping it invalidates the entire cache safely rather than silently serving wrong results.

**Cache hits are recorded** (`sliceCacheHitRate`) because the metric is a direct proxy for compute cost — and because a hit rate that suddenly drops means someone changed something that should not have changed the key.

---

## 6. Failure taxonomy

| Failure                                | Retry                      | Customer sees                                                                   |
| -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| Spot interruption / worker crash       | Yes, Temporal automatic    | Nothing — "calculando" continues                                                |
| S3 transient error                     | Yes, exponential backoff   | Nothing                                                                         |
| Slicer non-zero exit, geometry-related | **No**                     | `SLICING_FAILED` with the slicer's diagnostic, plus the related geometry issues |
| Slicer timeout                         | Once, on the large queue   | `SLICING_FAILED` — "model too complex for automatic quoting; contact us"        |
| Profile validation failure             | No                         | `INVALID_PRINT_CONFIGURATION`, naming the parameter                             |
| Metrics disagreement beyond tolerance  | Once                       | `SLICING_FAILED` — a bug alert fires internally                                 |
| Model does not fit build volume        | No — caught before slicing | `DOES_NOT_FIT_BUILD_VOLUME` with the overflow per axis                          |

The distinction that matters: **retry infrastructure failures, never retry deterministic failures.** A slicer that rejected this geometry will reject it again, and retrying wastes CPU and delays the customer's answer.

The fit check runs **before** slicing precisely so that the most common configuration error costs nothing.

---

## 7. Regression testing

Pinned digest, fixed fixtures, documented tolerance:

```python
@pytest.mark.regression
@pytest.mark.parametrize("fixture,profile,expected", REGRESSION_MATRIX)
def test_slice_metrics_within_tolerance(fixture, profile, expected):
    out = slice_with_pinned_engine(fixture, profile)
    assert relative_error(out.filament_mass_g,   expected.filament_mass_g)   <= 0.02   # ±2%
    assert relative_error(out.print_duration_s,  expected.print_duration_s)  <= 0.05   # ±5%
    assert out.layer_count == expected.layer_count                                     # exact
```

Runs **nightly, not per-PR** — it is slow, and its failure is informational (the slicer changed, or a profile changed) rather than a reason to block an unrelated pull request. A failure opens an issue automatically and posts the metric deltas.

The regression matrix covers: a calibration cube, a thin-walled maquette, a model with heavy overhangs, a multi-component assembly, and a model at the build-volume limit — each against every published printer profile version.

**Upgrading the slicer is a deliberate, reviewed event**: bump the digest, run the regression suite, review the metric deltas, and decide whether the change warrants recalibrating the pricing rule set. It is never an automatic dependency update, and Renovate is configured to exclude it.

---

## 8. Estimation without slicing

`estimate()` exists for the pre-slice price indication described in [PRICING_ENGINE.md](./PRICING_ENGINE.md#11-estimated-pricing-before-slicing). It derives approximate metrics from geometry (volume × infill heuristic × density; time from a volumetric rate per printer profile) without invoking the slicer at all. It is fast, it is wrong by a margin, and everything it produces is marked `isEstimate: true` all the way to the UI. It can never produce a `Quote`.
