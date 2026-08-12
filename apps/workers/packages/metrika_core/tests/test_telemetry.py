"""The correlation chain, asserted on the Python leg of it.

`docs/OBSERVABILITY.md` §2 makes one promise: a request ID given by a customer
resolves to a trace spanning the browser, the API, Temporal and both Python
workers. This suite asserts the last hop of that — an activity dispatched by a
caller that started a trace and put a request ID in baggage must run INSIDE that
trace and must log the same two identifiers.

**Against a real server, not a mock.** The thing under test is a boundary: two
propagations (a trace context and a baggage entry) crossing a process boundary
through Temporal's headers and coming out the other side. A mock asserts that
`build_client` was called with an interceptor, which is the one fact that cannot
be wrong. What can be wrong is everything on the wire — a propagator that
carries `traceparent` and drops `baggage` (ADR-0029 measured exactly that, on
the Node side, and it produced three unrelated traces at exit 0), a header key
that changed, an interceptor registered in an order that puts the span outside
the activity's own context.

**Every assertion here has a negative half**, because Plan 0B-3 shipped five
defects through a boundary whose guards were all positive — "this field is
present", "this bound arrived", and nothing at all asserting the absence of what
must not cross. So: the activity's span must have a parent AND that parent must
be the caller's; a log line inside a trace carries `traceId` AND a log line
outside one carries no `traceId` at all rather than the all-zero sentinel; the
telemetry bootstrap installs an exporter when configured AND installs none when
it is not.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator

import pytest
import structlog
from opentelemetry import baggage, context, trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from temporalio import activity
from temporalio.worker import Worker

from metrika_core.logging import configure_logging
from metrika_core.settings import WorkerSettings
from metrika_core.telemetry import (
    BAGGAGE_ORGANIZATION_ID,
    BAGGAGE_REQUEST_ID,
    build_tracer_provider,
    configure_telemetry,
    temporal_tracing_interceptor,
)
from metrika_core.temporal import build_client, build_worker

from _probe_workflow import TELEMETRY_ACTIVITY, TelemetryProbeWorkflow  # isort: skip
from _temporal_server import WORKFLOW_QUEUE  # isort: skip

# A URL with a signature in it, handed to the activity so that the redaction
# processor has something to catch on the WORKER leg. Correlation and redaction
# are one pipeline in the end: a log line that carries a request ID and a signed
# URL together is a correlated credential leak.
SIGNED_URL = "https://s3.example/models/abc.3mf?X-Amz-Signature=deadbeefcafe"
SIGNATURE = "deadbeefcafe"

_SERVICE_NAME = "metrika-core-tests"


@pytest.fixture(scope="session")
def exported_spans() -> Iterator[InMemorySpanExporter]:
    """One tracer provider for the session, with a collector attached.

    `trace.set_tracer_provider` REFUSES a second registration — it logs
    "Overriding of current TracerProvider is not allowed" and keeps the first,
    at exit 0 — so `configure_telemetry` is called exactly once per process and
    the exporter is attached to the provider it returns. A per-test provider
    would silently be the first test's provider for every test after it.

    `SimpleSpanProcessor`, not `Batch`: a batch processor flushes on a timer,
    and a test that asserts on a span the worker has just finished would be
    asserting on an empty list most of the time.
    """
    provider = configure_telemetry(_settings_without_an_endpoint(), service_name=_SERVICE_NAME)
    assert trace.get_tracer_provider() is provider, (
        "something installed a TracerProvider before this fixture did. `set_tracer_provider` "
        "keeps the FIRST one at exit 0, so the exporter below would be attached to a provider "
        "no span reaches and every span assertion here would fail on an empty list"
    )
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    yield exporter
    exporter.clear()


def _settings_without_an_endpoint() -> WorkerSettings:
    return WorkerSettings(temporal_task_queue="unused", s3_bucket="unused")


def _activity_span(exporter: InMemorySpanExporter) -> ReadableSpan:
    """The one span the worker leg produced, found by name rather than by index.

    `RunActivity:<type>` is what `temporalio.contrib.opentelemetry` names it.
    Selecting by index would pass while the span set changed shape underneath —
    which is exactly how a correlation test stops testing correlation.
    """
    spans = [
        span
        for span in exporter.get_finished_spans()
        if span.name == f"RunActivity:{TELEMETRY_ACTIVITY}"
    ]
    assert len(spans) == 1, f"expected one activity span, found {[s.name for s in spans]}"
    return spans[0]


@activity.defn(name=TELEMETRY_ACTIVITY)
async def telemetry_probe(signed_url: str) -> dict[str, str]:
    """Logs one line, and reports what it could see of the caller's context.

    Returns the correlation it OBSERVED rather than asserting on it here: an
    assertion inside an activity fails as an `ApplicationError` wrapped in a
    `WorkflowFailureError` several frames away, which reports as "the workflow
    failed" and names nothing useful.
    """
    structlog.get_logger().info("telemetry.probe", presigned_url=signed_url)

    span_context = trace.get_current_span().get_span_context()
    return {
        "traceId": format(span_context.trace_id, "032x"),
        "spanId": format(span_context.span_id, "016x"),
        "requestId": str(baggage.get_baggage(BAGGAGE_REQUEST_ID) or ""),
        "organizationId": str(baggage.get_baggage(BAGGAGE_ORGANIZATION_ID) or ""),
    }


def _lines(captured: str) -> list[dict[str, object]]:
    return [json.loads(line) for line in captured.strip().splitlines() if line.startswith("{")]


def _probe_line(captured: str) -> dict[str, object]:
    lines = [line for line in _lines(captured) if line.get("event") == "telemetry.probe"]
    assert len(lines) == 1, f"expected one probe log line, found {len(lines)}"
    return lines[0]


# ------------------------------- the round trip -------------------------------


@pytest.mark.integration
async def test_an_activity_runs_inside_the_callers_trace_and_logs_its_correlation(
    settings: WorkerSettings,
    exported_spans: InMemorySpanExporter,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`docs/OBSERVABILITY.md` §2's last hop, end to end on a real server.

    The caller starts a span and puts a request ID in baggage; a workflow
    dispatches an activity onto the queue this worker polls; the activity logs.
    Three things must then be true, and each of them is a different mechanism:

      * the activity's log line carries the caller's `requestId` — that is the
        BAGGAGE propagation, and it is the one ADR-0029 measured Sentry's
        propagator dropping;
      * the same log line carries the caller's `traceId` — that is the TRACE
        CONTEXT propagation reaching structlog;
      * the activity's span has the workflow's span as a REMOTE parent on the
        caller's trace — that is the trace context reaching the tracer, which is
        not the same claim as the line above and fails separately.
    """
    exported_spans.clear()
    configure_logging("info")

    request_id = f"req-{uuid.uuid4()}"
    organization_id = f"org-{uuid.uuid4()}"

    client = await build_client(settings)
    tracer = trace.get_tracer(_SERVICE_NAME)

    async with (
        Worker(client, task_queue=WORKFLOW_QUEUE, workflows=[TelemetryProbeWorkflow]),
        build_worker(client, settings, [telemetry_probe]),
    ):
        with tracer.start_as_current_span("test.caller") as caller_span:
            caller_trace_id = caller_span.get_span_context().trace_id
            # Baggage is a Context value, not span state, so it has to be
            # ATTACHED to be picked up by the propagator on the way out. The
            # `set_baggage` chain returns a new context each time; attaching the
            # last one keeps the caller span current because it was built from
            # the context that already had it.
            token = context.attach(
                baggage.set_baggage(
                    BAGGAGE_ORGANIZATION_ID,
                    organization_id,
                    baggage.set_baggage(BAGGAGE_REQUEST_ID, request_id),
                )
            )
            try:
                observed = await client.execute_workflow(
                    TelemetryProbeWorkflow.run,
                    args=[settings.temporal_task_queue, SIGNED_URL],
                    id=f"telemetry-{uuid.uuid4()}",
                    task_queue=WORKFLOW_QUEUE,
                )
            finally:
                context.detach(token)

    expected_trace_id = format(caller_trace_id, "032x")

    # What the activity could see of the caller, from inside the worker leg.
    assert observed["requestId"] == request_id
    assert observed["organizationId"] == organization_id
    assert observed["traceId"] == expected_trace_id

    # What it wrote down. This is the assertion `docs/OBSERVABILITY.md` §3's
    # example log line describes, and the camelCase spellings are the contract:
    # a Grafana query for `requestId` has to match Pino's lines and structlog's.
    line = _probe_line(capsys.readouterr().out)
    assert line["requestId"] == request_id
    assert line["traceId"] == expected_trace_id
    assert line["organizationId"] == organization_id
    assert line["spanId"] == observed["spanId"]
    assert line["workflowId"] is not None
    assert line["activityType"] == TELEMETRY_ACTIVITY

    # The span, which is the half the log line cannot prove. A worker that
    # started a fresh trace would still log a `traceId` — its own.
    span = _activity_span(exported_spans)
    assert span.parent is not None, (
        "the activity span is a ROOT: the caller's trace context did not reach the worker, so "
        "one request has become two unrelated traces"
    )
    assert span.parent.is_remote, "the parent was created in this process, not extracted"
    assert format(span.context.trace_id, "032x") == expected_trace_id
    assert span.parent.trace_id == caller_trace_id


@pytest.mark.integration
async def test_the_activitys_log_line_redacts_a_signed_url_it_was_handed(
    settings: WorkerSettings,
    exported_spans: InMemorySpanExporter,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Correlation and redaction meet on the same line, so they are tested there.

    The activity above logs the signed URL it is given under `presigned_url`.
    This asserts the worker leg censors it — a correlated log line that carries a
    bearer credential for the customer's model is a worse outcome than an
    uncorrelated one, and the two controls are configured in the same module.
    """
    exported_spans.clear()
    configure_logging("info")

    client = await build_client(settings)

    async with (
        Worker(client, task_queue=WORKFLOW_QUEUE, workflows=[TelemetryProbeWorkflow]),
        build_worker(client, settings, [telemetry_probe]),
    ):
        await client.execute_workflow(
            TelemetryProbeWorkflow.run,
            args=[settings.temporal_task_queue, SIGNED_URL],
            id=f"telemetry-{uuid.uuid4()}",
            task_queue=WORKFLOW_QUEUE,
        )

    captured = capsys.readouterr().out
    assert _probe_line(captured)["presigned_url"] == "[redacted]"
    assert SIGNATURE not in captured, "the signature survived somewhere in the captured output"


# --------------------------- the pieces, on their own -------------------------


def test_the_temporal_interceptor_carries_both_trace_context_and_baggage() -> None:
    """ADR-0029's question 4, as a control rather than a note.

    A propagator that carries `traceparent` and drops `baggage` is the measured
    failure: one request becomes several traces, and the correlation ID goes
    missing from the leg most likely to have failed. Nothing about that looks
    like an error — every component reports success — so the only thing that can
    catch it is an assertion on the propagator's own `fields`.

    Temporal does NOT read the global propagator. `TracingInterceptor` holds its
    own `text_map_propagator`, so `set_global_textmap` has no effect on anything
    this suite cares about, and setting it would be a control that looks like it
    works and does not. This is why `temporal_tracing_interceptor()` exists at
    all rather than the call sites constructing `TracingInterceptor()`.
    """
    fields = set(temporal_tracing_interceptor().text_map_propagator.fields)

    assert "traceparent" in fields
    assert "baggage" in fields


# `build_tracer_provider`, NOT `configure_telemetry`, in all three tests below —
# and that distinction is the reason the pair of functions exists.
# `trace.set_tracer_provider` refuses a second registration and keeps the first,
# at exit 0, so a unit test that called the installing function would (a) be
# asserting on a provider that is not the global one anyway and (b) claim the
# process's one global registration, leaving the integration fixture's exporter
# attached to a provider nothing uses. MEASURED: with these three calling
# `configure_telemetry`, `test_a_log_line_inside_a_span…` below passed only
# because one of them happened to run first and install an SDK provider — a
# green test standing on collection order.


def test_the_tracer_provider_builds_no_exporter_without_an_endpoint() -> None:
    """An absence, and it is the one Plan 0C's ordering constraint depends on.

    No task in this plan may ship an exporter before the API's redaction lands,
    because an exporter turns a local-only exposure into an exported one. A
    worker with no `METRIKA_WORKER_OTLP_ENDPOINT` must therefore build no
    exporter at all — not an exporter pointed at a default, and not one that
    fails quietly at flush time.
    """
    settings = _settings_without_an_endpoint()

    assert settings.otlp_endpoint is None
    assert _span_processor_count(build_tracer_provider(settings, service_name="probe")) == 0


def test_the_tracer_provider_builds_an_exporter_when_an_endpoint_is_configured() -> None:
    """The other half, so the test above is not passing because nothing works."""
    settings = WorkerSettings(
        temporal_task_queue="unused",
        s3_bucket="unused",
        otlp_endpoint="http://collector.invalid:4318/v1/traces",
    )

    assert _span_processor_count(build_tracer_provider(settings, service_name="probe")) == 1


def test_the_tracer_provider_names_the_service_on_its_resource() -> None:
    """ADR-0029 obligation 11's Python half.

    Two worker processes share this module. A resource that did not carry the
    service name would put both of their spans under one unnamed service, which
    is indistinguishable from working right up to the point somebody asks which
    worker was slow.
    """
    provider = build_tracer_provider(_settings_without_an_endpoint(), service_name="metrika-probe")

    assert provider.resource.attributes["service.name"] == "metrika-probe"


def _span_processor_count(provider: TracerProvider) -> int:
    """How many processors a provider carries, read without private-API guessing.

    `TracerProvider` keeps them in a multi-processor; the list below is the only
    place this suite reaches into the SDK, and it is asserted non-empty by the
    positive test above so a rename cannot make both tests vacuous.
    """
    return len(provider._active_span_processor._span_processors)


# ------------------------- correlation outside an activity --------------------


def test_a_log_line_inside_a_span_carries_the_trace_and_span_ids(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A LOCAL provider, deliberately, and not `trace.get_tracer(...)`.

    The processor reads whatever span is current, which is a context question
    rather than a provider question — so this needs no global registration, and
    taking one would make the test depend on whether some other test had
    installed an SDK provider first. That is not hypothetical: it is what the
    first version of this file did.
    """
    configure_logging("info")
    tracer = build_tracer_provider(
        _settings_without_an_endpoint(), service_name=_SERVICE_NAME
    ).get_tracer(_SERVICE_NAME)

    with tracer.start_as_current_span("probe") as span:
        structlog.get_logger().info("in.a.span")
        span_context = span.get_span_context()

    line = _probe_event(capsys.readouterr().out, "in.a.span")
    assert line["traceId"] == format(span_context.trace_id, "032x")
    assert line["spanId"] == format(span_context.span_id, "016x")


def test_a_log_line_outside_a_span_carries_no_correlation_at_all(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The absence assertion, and it is not pedantry.

    An invalid span context is all zeroes and formats perfectly happily as
    `"00000000000000000000000000000000"`. A processor that emitted it
    unconditionally would put a plausible-looking trace ID on every line a
    worker writes outside an activity — startup, shutdown, a poll error — and
    every one of them would resolve to nothing in Grafana. Absent is the honest
    answer; a zero is a wrong one that looks right.
    """
    configure_logging("info")

    structlog.get_logger().info("outside.any.span")

    line = _probe_event(capsys.readouterr().out, "outside.any.span")
    assert "traceId" not in line
    assert "spanId" not in line
    assert "requestId" not in line


def test_baggage_becomes_the_request_id_without_a_span(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`requestId` comes from baggage, `traceId` from the span — two mechanisms.

    Asserted apart from each other because they fail apart from each other: the
    propagator can carry one and drop the other, which is precisely ADR-0029's
    question-4 finding.
    """
    configure_logging("info")

    token = context.attach(baggage.set_baggage(BAGGAGE_REQUEST_ID, "req-standalone"))
    try:
        structlog.get_logger().info("baggage.only")
    finally:
        context.detach(token)

    line = _probe_event(capsys.readouterr().out, "baggage.only")
    assert line["requestId"] == "req-standalone"
    assert "traceId" not in line


def _probe_event(captured: str, event: str) -> dict[str, object]:
    lines = [line for line in _lines(captured) if line.get("event") == event]
    assert len(lines) == 1, f"expected one {event!r} line, found {len(lines)}"
    return lines[0]
