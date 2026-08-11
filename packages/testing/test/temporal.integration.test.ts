import { Connection } from '@temporalio/client';
import { afterAll, describe, expect, it } from 'vitest';
// Not '../src/index.js' — the harness is intentionally not in the barrel; see
// the comment there.
import { startTemporal, stopTemporal, TEMPORAL_ADDRESS_VAR } from '../src/temporal.js';

/**
 * Bounded on purpose. Every connection in this file is to an address the
 * harness has already dialled successfully, so a slow one means something is
 * wrong — and an unbounded connect would turn that into a suite timeout, which
 * reads as infrastructure trouble rather than as a failing assertion.
 */
const CONNECT_TIMEOUT_MS = 10_000;

// A no-op here, and that is the point being relied on: the address came from
// the globalSetup, so this module registry owns no container and `stopTemporal`
// leaves the shared server alone for whatever file runs next. See the doc
// comment on `stopTemporal`.
afterAll(async () => {
  await stopTemporal();
});

describe('the Testcontainers Temporal harness', () => {
  it('hands out an address a real client can connect to', async () => {
    const handle = await startTemporal();

    const connection = await Connection.connect({
      address: handle.address,
      connectTimeout: CONNECT_TIMEOUT_MS,
      interceptors: [],
    });
    try {
      // `Connection.connect` has already made a `GetSystemInfo` round trip, so
      // reaching this line is itself the connectivity assertion. Reading the
      // server's own reported capabilities keeps it from being a bare
      // `expect(true)` and proves the response was parsed, not just received.
      const info = await connection.workflowService.getSystemInfo({});
      expect(info.serverVersion).toBeTruthy();
    } finally {
      await connection.close();
    }
  });

  it('reaches the namespace auto-setup provisions, by name', async () => {
    const handle = await startTemporal();

    const connection = await Connection.connect({
      address: handle.address,
      connectTimeout: CONNECT_TIMEOUT_MS,
      interceptors: [],
    });
    try {
      const described = await connection.workflowService.describeNamespace({
        namespace: handle.namespace,
      });
      expect(described.namespaceInfo?.name).toBe(handle.namespace);

      // Usable, not merely described — this is the assertion that separates
      // "the frontend answered" from "a worker could actually run here".
      // auto-setup registers `default` LAST, after two schema migrations, and
      // a namespace-SCOPED call is what fails with NamespaceNotFound across
      // that window. `describeNamespace` alone would not: its own `state`
      // field decodes as the raw protobuf enum ordinal (`1`), so asserting on
      // it means committing a magic number to the test, and `@temporalio/proto`
      // — where the symbolic name lives — is a transitive dependency this
      // package does not declare. A real scoped RPC is both stronger and
      // self-explaining.
      const listed = await connection.workflowService.listWorkflowExecutions({
        namespace: handle.namespace,
        pageSize: 1,
      });
      expect(listed.executions).toEqual([]);
    } finally {
      await connection.close();
    }
  });

  it('fails fast on a dead address rather than hanging', async () => {
    // The property that makes every failure above legible. Port 1 on loopback
    // is not something Docker publishes, so nothing is listening and nothing
    // will be. A harness that hangs here would surface as a suite timeout —
    // indistinguishable from a slow machine — instead of as an error naming
    // the address.
    const start = Date.now();
    await expect(
      Connection.connect({
        address: '127.0.0.1:1',
        connectTimeout: 2_000,
        interceptors: [],
      }),
    ).rejects.toThrow();
    // Comfortably under the 2s connectTimeout's own slack, and far under the
    // suite's 30s testTimeout: the assertion is that the bound is enforced,
    // not merely configured.
    expect(Date.now() - start).toBeLessThan(15_000);
  });

  it('reuses the server the globalSetup started rather than starting a second', async () => {
    const first = await startTemporal();
    const second = await startTemporal();
    expect(second.address).toBe(first.address);
    // Without this line the test would also pass on a per-file container,
    // which is the exact regression it exists to catch.
    expect(first.address).toBe(process.env[TEMPORAL_ADDRESS_VAR]);
  });

  it('publishes a mapped port, never the container-internal 7233', async () => {
    const handle = await startTemporal();
    const port = handle.address.split(':').at(-1);
    expect(port).toBeDefined();
    // Testcontainers maps to an ephemeral host port. Seeing 7233 here would
    // mean the address was assembled from the container-internal port, which
    // dials whatever else happens to be on the host's 7233 — including the
    // compose stack, whose data this suite must never touch.
    expect(port).not.toBe('7233');
    expect(Number(port)).toBeGreaterThan(0);
  });
});
