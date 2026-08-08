# Metrika — Testing Strategy

> Coverage targets are per-package and meaningful. There is no global percentage, because a global percentage is satisfied by testing the easy code.

---

## 1. What gets tested hardest, and why

| Code                                  | Target                        | Why                                                                       |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `packages/pricing-engine`             | **100% line + branch**        | It decides what customers pay. It is pure and small. There is no excuse   |
| `apps/api/src/authorization/policies` | **100% branch**               | A missed branch is a cross-tenant data leak                               |
| State machine transition tables       | **100%, exhaustive**          | An unreachable state or a permitted illegal transition is a corrupt order |
| Money and unit conversion             | **100%**                      | A rounding bug compounds silently across every quote                      |
| Domain services                       | ≥ 90%                         | Business rules                                                            |
| Contract schemas                      | Parse/reject table per schema | The boundary against untyped external data                                |
| API modules                           | ≥ 70%                         | Integration-tested against a real database                                |
| Python workers                        | ≥ 60% + property tests        | Geometry maths deserves property testing more than line coverage          |
| UI components                         | untargeted                    | Behaviour is covered by E2E; component coverage measures the wrong thing  |

Coverage is enforced per-package in CI. A pull request that lowers `pricing-engine` below 100% fails.

---

## 2. Unit tests

**Vitest** for all TypeScript. One runner, native ESM, fast watch mode, and no separate config for integration tests.

### Golden-file tests for the pricing engine

The single most valuable test pattern in this codebase:

```ts
// packages/pricing-engine/test/golden/standard-fdm-medium-complexity.test.ts
const input = loadFixture('standard-fdm-medium-complexity.input.json');
const result = computePrice(input);
expect(result).toMatchFileSnapshot('./__golden__/standard-fdm-medium-complexity.trace.json');
```

The value is not the assertion — it is the diff. A change to the engine produces a diff in committed expected-output files showing exactly which scenarios move and by how much. A pricing change becomes reviewable rather than a leap of faith. The golden corpus covers every component kind, every combination phase, tax-inclusive and exclusive jurisdictions, minimum-order floors, quantity tiers and full-discount edges.

### Property tests

```ts
test.prop([arbitrarySliceMetrics(), arbitraryRuleSet()])(
  'total always equals the sum of trace lines plus the rounding adjustment',
  (slice, ruleSet) => {
    const r = computePrice(makeInput(slice, ruleSet));
    if (!r.ok) return;
    const sum = r.value.trace.lines.reduce((a, l) => a + BigInt(l.amountMinor), 0n);
    expect(sum).toBe(BigInt(r.value.totalMinor));
  },
);
```

Also property-tested: determinism (same input twice → identical bytes), monotonicity (more material never lowers price), non-negativity, and the stability of canonical JSON hashing across platforms.

### State machines

```ts
describe('QUOTE_TRANSITIONS', () => {
  it('every state is reachable from the initial state', () => {
    /* BFS over the table */
  });
  it('terminal states have no outgoing transitions', () => {
    /* ... */
  });
  it.each(illegalPairs(QUOTE_TRANSITIONS))('rejects %s --%s-->', (from, event) => {
    expect(() => transition({ state: from }, event, ctx)).toThrow(InvalidStateTransitionError);
  });
});
```

Generating the illegal pairs from the table means the test grows automatically with the machine — a new state cannot be added without its illegal transitions being asserted.

### Authorization policies

Every policy is a pure function, so the test is a truth table over (subject kind × role × ownership × resource state). Exhaustive, fast and readable.

---

## 3. Integration tests

**Testcontainers** for everything. No test depends on a developer's local setup, and no test can pass on one machine and fail on another for environmental reasons.

```ts
// packages/testing/src/harness.ts
export async function withDatabase<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T>;
export async function withStorage<T>(fn: (s3: S3Client) => Promise<T>): Promise<T>; // MinIO
export async function withTemporal<T>(fn: (env: TestWorkflowEnvironment) => Promise<T>): Promise<T>;
```

Containers start once per suite; each test runs inside a transaction that is rolled back, giving isolation without container churn.

Covered: repositories against real Postgres (including RLS behaviour), API modules end to end through the ts-rest handler, the S3 adapter against MinIO, Temporal activities against the time-skipping test environment, migration up/down smoke tests, and the outbox poller's at-least-once delivery under concurrent writers.

### RLS tests are their own category

```ts
it('returns zero rows when the org context does not match', async () => {
  await withOrgContext(orgA, async (db) => {
    const found = await db.project.findUnique({ where: { id: projectOwnedByOrgB } });
    expect(found).toBeNull(); // RLS, not application logic
  });
});
```

These test the backstop specifically — with the application-level check bypassed — because the whole point of a backstop is that it works when the primary control has failed.

### The cross-tenant IDOR suite

Generated from the route table, so it cannot fall behind:

```ts
describe.each(ALL_TENANT_SCOPED_ROUTES)('IDOR: %s', (route) => {
  it('denies access to another organization resource', async () => {
    const res = await asUser(orgAUser).request(route.method, route.pathFor(orgBResourceId));
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});
```

Runs on every pull request. Adding a tenant-scoped route without an authorization check fails CI immediately. This is the highest-value security test in the repository.

---

## 4. Contract tests

Three boundaries, each with a mechanical check:

| Boundary                    | Check                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| API ↔ client                | Generated OpenAPI diffed against a committed baseline; breaking changes fail unless explicitly labelled |
| Event producers ↔ consumers | A v2 schema must still parse committed v1 payload fixtures                                              |
| TypeScript ↔ Python         | `pnpm contracts:emit` then `git diff --exit-code`                                                       |

The third one is the one most likely to be skipped and most likely to bite. A contract change that is not reflected in the pydantic models breaks the build at the moment of the change, not in a worker three weeks later.

---

## 5. Geometry tests

### Fixtures

Committed under `fixtures/models/`, **generated by a committed script** wherever possible so they are reproducible and reviewable rather than opaque binaries:

| Fixture                         | Tests                                                                      |
| ------------------------------- | -------------------------------------------------------------------------- |
| `cube-20mm.stl`                 | Baseline: exact volume 8000 mm³, watertight, 12 triangles                  |
| `cube-20mm.3mf`                 | Unit declaration honoured                                                  |
| `open-box.stl`                  | Not watertight → volume is `null`, not a number                            |
| `non-manifold-edge.stl`         | Non-manifold detection, edge sampling for viewer highlight                 |
| `self-intersecting.stl`         | Detection without a crash                                                  |
| `inverted-normals.stl`          | Winding correction, conservative repair path                               |
| `degenerate-faces.stl`          | Zero-area triangle removal                                                 |
| `disconnected-3-parts.stl`      | Component counting                                                         |
| `thin-wall-0.3mm.stl`           | Wall-thickness heuristic below nozzle diameter                             |
| `ambiguous-units.stl`           | 18.4 × 12.7 × 7.2 raw — plausible as metres or as millimetres → must block |
| `implausible-scale.stl`         | Implies a 4 km building → `IMPLAUSIBLE_SCALE`                              |
| `huge-20m-triangles.stl`        | Memory limits, large-queue routing, timeout behaviour                      |
| `truncated-header.stl`          | Malformed input handling                                                   |
| `zip-bomb.3mf`                  | Archive limits                                                             |
| `xml-bomb.3mf`                  | Entity expansion defence                                                   |
| `obj-with-traversal-mtllib.obj` | Reference stripping                                                        |
| `building-maquette.3mf`         | Realistic end-to-end fixture for the regression matrix                     |

Each fixture asserts a **specific expected outcome**, including the exact error code for the hostile ones. A security control without a fixture asserting rejection is an intention, not a control.

### Property tests for geometry maths

Hypothesis, on the invariants that must hold regardless of input:

- Scaling by `k` scales volume by `k³` and area by `k²` (within floating tolerance).
- A watertight mesh has non-negative volume.
- Repair never increases the degenerate-face count.
- Conservative repair never moves a vertex further than the weld epsilon.
- Unit normalisation is idempotent.

---

## 6. Slicer regression tests

Pinned image digest, fixed fixtures, documented tolerance, **nightly rather than per-PR**. Detail in [SLICING.md](./SLICING.md#7-regression-testing).

The distinction matters: a slicer regression failure means "the slicer or a profile changed and metrics moved", which is information that should open an issue and prompt a recalibration decision — not a reason to block an unrelated pull request.

---

## 7. End-to-end tests

**Playwright**, against an ephemeral environment, with `FakeSlicerEngine` and a deterministic fake geometry analyzer for speed and stability.

The golden path:

```
register → create organization → create project → upload model (real fixture file)
→ wait for analysis (real workflow, fake analyzer)
→ confirm units → view the 3D model → configure print (scale 1:100, PLA, standard)
→ see fit indicator → request quote → receive price
→ accept quote → checkout (fake payment provider) → order created
```

Additional flows: ambiguous-unit confirmation; a rejected hostile file; an oversized model showing `DOES_NOT_FIT_BUILD_VOLUME`; quote expiry then re-quote; organization invitation and role-based access; admin publishing a pricing rule set version.

Rules that keep E2E from becoming the flaky suite everyone ignores:

- **No arbitrary waits.** Wait on state, never on time.
- **No shared state between tests.** Each creates its own organization.
- **Deterministic fakes** for slicing, payments and email.
- **Real files** for uploads — a fixture that never touches the real parser is testing nothing.
- **Traces and video retained on failure**, uploaded as CI artefacts.

E2E covers about a dozen flows. It is not where coverage comes from; it is where "the pieces actually fit together" comes from.

---

## 8. Performance tests

Not a large investment, but three specific things are measured because they degrade silently:

| Test                                                   | Budget                                        | Cadence  |
| ------------------------------------------------------ | --------------------------------------------- | -------- |
| API endpoint latency under a modest load profile (k6)  | p95 < 300 ms for reads                        | Nightly  |
| Query count per endpoint (Prisma middleware assertion) | Per-endpoint budget; fails the test on exceed | Every PR |
| Viewer memory after 50 mount/unmount cycles            | Returns to baseline                           | Every PR |

The N+1 test is the one that pays for itself. A query-count assertion catches an accidental N+1 the moment it is introduced, when it is a one-line fix, rather than in production when it is a 400-query page load.

---

## 9. What is deliberately not tested

Stated so their absence is a decision:

- Third-party SDK behaviour — mocked at the boundary, not re-verified.
- Prisma's own query generation.
- Exhaustive UI component permutations — E2E plus type safety cover the risk more cheaply.
- Visual regression — deferred to V1; the design surface is too unstable to be worth pinning at MVP.
- Load beyond a modest profile — there is no traffic to justify it yet, and a load test against an imaginary traffic shape measures nothing.
