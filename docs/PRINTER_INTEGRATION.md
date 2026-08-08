# Metrika — Printer Integration

> **TODO: Printer Infrastructure.** No hardware integration is implemented. This document defines the abstraction so it can be added later without touching business logic.

---

## 1. The principle

Rule §105.13: **no hardware-specific logic inside the order domain.** The order domain knows that a `ManufacturingJob` exists and has a state. It does not know whether that state changed because an operator clicked a button or because a Klipper instance reported `print_stats.state == "complete"`.

This is enforced structurally: `packages/printer-sdk` may not import order, quote or pricing types, and `ManufacturingModule` interacts with printers only through the `PrinterDriver` interface.

The consequence that matters: **the `PrintJob` state machine does not change when hardware arrives.** Only who calls `transition()` changes. In MVP an operator drives it through the admin UI; from Phase 14 a driver drives it from telemetry. If adding a printer required changing the state machine, the abstraction would have failed.

---

## 2. The interface

```ts
// packages/printer-sdk/src/driver.ts

export interface PrinterDriver {
  readonly kind: PrinterDriverKind;   // 'MANUAL' | 'OCTOPRINT' | 'KLIPPER' | 'PRUSA_CONNECT' | 'BAMBU' | 'SIMULATOR'

  getCapabilities(): Promise<PrinterCapabilities>;
  getStatus(): Promise<PrinterStatus>;

  submitJob(job: PrinterJobSubmission): Promise<Result<PrinterJobHandle, PrinterError>>;
  cancelJob(handle: PrinterJobHandle): Promise<Result<void, PrinterError>>;
  pauseJob(handle: PrinterJobHandle): Promise<Result<void, PrinterError>>;
  resumeJob(handle: PrinterJobHandle): Promise<Result<void, PrinterError>>;
  getJobStatus(handle: PrinterJobHandle): Promise<Result<PrinterJobStatus, PrinterError>>;

  subscribeTelemetry(handle: PrinterJobHandle, signal: AbortSignal): AsyncIterable<PrinterTelemetry>;
}

export interface PrinterCapabilities {
  readonly technology: PrintTechnology;
  readonly buildVolumeMm: Vec3Mm;
  readonly nozzleDiametersMm: readonly number[];
  readonly supportedMaterials: readonly MaterialCode[];
  readonly supportsPause: boolean;
  readonly supportsRemoteCancel: boolean;
  readonly supportsTelemetry: boolean;
  readonly supportsCamera: boolean;
  readonly maxQueueDepth: number;
}

export interface PrinterTelemetry {
  readonly at: IsoDateTime;
  readonly progressRatio: number;              // 0..1
  readonly currentLayer?: number;
  readonly nozzleTempC?: number;
  readonly bedTempC?: number;
  readonly elapsedS: Seconds;
  readonly estimatedRemainingS?: Seconds;
  readonly filamentUsedMm?: number;
}
```

Every method returns a `Result` rather than throwing: printer errors are expected, enumerable and part of the contract. A network-unreachable printer is normal operation, not an exception.

Capabilities are queried rather than assumed. A driver that cannot pause reports `supportsPause: false`, and the UI hides the button — instead of offering an action that fails.

---

## 3. Implementations

| Driver | Status | Notes |
|---|---|---|
| `NullPrinterDriver` | **Now** | Rejects everything; used where a driver is required but none is configured |
| `ManualPrinterDriver` | **Now (Phase 11)** | State changes come from operator actions in the admin UI. `submitJob` records the assignment and marks the G-code ready for download |
| `SimulatorPrinterDriver` | **Now** | Simulates a print with realistic timing and telemetry. Powers the driver conformance suite and the ops UI development |
| `OctoPrintDriver` | Phase 14 | REST + WebSocket. The most widely deployed option and the natural first real driver |
| `KlipperDriver` | Phase 14 | Moonraker JSON-RPC + WebSocket |
| `PrusaConnectDriver` | Future | Prusa's cloud API |
| `BambuDriver` | Future | MQTT-based; the protocol is less openly documented, which is a real integration risk |

`ManualPrinterDriver` is the important one. It means the manufacturing domain is complete and exercised from Phase 11 with zero hardware — the same code path, the same state machine, the same events. Phase 14 swaps an implementation rather than building a subsystem.

---

## 4. Conformance suite

```ts
// packages/printer-sdk/src/testing/conformance.ts
export function runDriverConformanceSuite(
  name: string,
  createDriver: () => Promise<PrinterDriver>,
): void;
```

Every driver must pass the same suite, which asserts the behavioural contract rather than the implementation:

- Capabilities are stable across calls.
- `submitJob` is idempotent for the same submission ID.
- `cancelJob` on an already-finished job is a no-op, not an error.
- `pauseJob` fails cleanly with `UNSUPPORTED` when `supportsPause` is false.
- Telemetry `progressRatio` is monotonic and terminates.
- Every error maps to a declared `PrinterError` code.
- The driver survives a mid-job connection loss and reports a recoverable state.

Written once, run against every driver. It exists before any real driver does, so the first real integration is validated against a specification rather than against nothing.

---

## 5. Assignment and scheduling

Deliberately out of scope until there is a real fleet. The shape it will take:

```
ManufacturingJob (QUEUED)
  → scheduler selects a Printer whose PrinterProfileVersion matches the job's,
    with capacity, correct material loaded, and the shortest queue
  → PrintJob created (attemptNumber = 1)
  → driver.submitJob(gcode)
  → telemetry drives PrintJob transitions
  → on failure: PrintJob FAILED; policy decides retry → attemptNumber + 1
```

The scheduler is a pure function over `(queuedJobs, printers, constraints)` returning assignments — testable without hardware, and replaceable when "shortest queue" stops being good enough. At 100 printers this becomes a genuine optimisation problem; the interface does not change.

**Material changeover is the constraint that will actually matter.** A printer loaded with black PLA should batch black PLA jobs rather than alternate materials. The scheduler must account for changeover cost, and the data to do so (`MaterialColor` on the configuration, current load on the printer) is already in the schema.

---

## 6. Telemetry transport

Printer telemetry is the one place where WebSockets are justified — bidirectional, high-frequency, and requiring commands to flow back to the machine. Everything else in the platform uses SSE ([WORKFLOWS.md](./WORKFLOWS.md#8-real-time-progress)).

The intended shape: drivers hold WebSocket connections to printers from a dedicated `printer-gateway` service; telemetry is throttled and written to Redis; the operator UI subscribes over SSE for the dashboard and over WebSocket only where live control is needed. Raw telemetry is not persisted at full frequency — samples every 30 seconds plus state transitions are enough for forensics, and full-rate persistence would be a large, low-value write load.

---

## 7. Security

Printers are the weakest devices on any network. Assumptions:

- Printers live on an isolated network segment with no route to the application VPC.
- The `printer-gateway` is the only component that talks to them, over mTLS or a VPN.
- API keys per printer, stored in Secrets Manager, rotated on a schedule.
- G-code is fetched by the gateway from S3 and pushed to the printer; a printer never receives an S3 credential or a signed URL.
- Telemetry is untrusted input and is parsed with a schema, exactly like any other external data.
