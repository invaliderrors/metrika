"""OpenTelemetry for the workers, and the correlation fields it feeds structlog.

`docs/OBSERVABILITY.md` §2 promises that a request ID resolves to one trace
across the browser, the API, Temporal and both Python workers. This module is
the Python leg of that, and it is three separate things that fail separately:

  1. **A tracer provider** with an explicit `Resource`, and an OTLP exporter
     only when a deployment has configured an endpoint.
  2. **The Temporal interceptor**, which is what actually carries a trace
     context and a baggage entry across the process boundary.
  3. **Two structlog processors**, which is how those identifiers reach a log
     line without every call site remembering to pass them.

**No search attributes here, and that is not an omission.** ADR-0029 obligation
10 provisions `MetrikaRequestId` and friends, and they are set by whoever STARTS
a workflow. The workflows live in `apps/api/src/workflows/**` in TypeScript
(CLAUDE.md); this side runs activities, and `temporalio.activity.info()` does
not expose the parent's search attributes at all. The Python half of ADR-0029's
question 4 is baggage, and that is what is below.

**Nothing here reads or writes the database, and nothing here can.** The module
imports an HTTP exporter, which is the only outbound thing a worker has beyond
S3 and Temporal — see `tests/test_dependencies.py`, which grades the whole
runtime closure.
"""

from __future__ import annotations

from opentelemetry import baggage, trace
from opentelemetry.baggage.propagation import W3CBaggagePropagator
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import INVALID_SPAN_ID, INVALID_TRACE_ID
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from structlog.typing import EventDict, WrappedLogger
from temporalio import activity
from temporalio.contrib.opentelemetry import TracingInterceptor

from metrika_core.settings import WorkerSettings

# The two baggage entries the API puts on the wire, spelled exactly as ADR-0029
# question 4 measured them round-tripping from a Node client to a Python
# activity. Baggage keys are dotted and snake_case because they are a W3C header
# value shared with other systems; the LOG FIELD names they become are camelCase
# because those are shared with Pino. The two conventions meet here, once.
BAGGAGE_REQUEST_ID = "metrika.request_id"
BAGGAGE_ORGANIZATION_ID = "metrika.organization_id"

# What a log line calls them. `docs/OBSERVABILITY.md` §3's example line is the
# contract: one Grafana query for `requestId` has to match a Pino line from
# `apps/api` and a structlog line from here. That is why these five are
# camelCase in a codebase whose every other log key is snake_case — they are the
# cross-runtime names, not this runtime's names, and ADR-0029 obligation 9 makes
# the Node side bend the same way (its Pino instrumentation emits `trace_id` by
# default and has to be configured out of it).
FIELD_REQUEST_ID = "requestId"
FIELD_ORGANIZATION_ID = "organizationId"
FIELD_TRACE_ID = "traceId"
FIELD_SPAN_ID = "spanId"

# `INVALID_TRACE_ID` and `INVALID_SPAN_ID` are imported from
# `opentelemetry.trace` rather than restated as `0` here. They are the SDK's own
# sentinels and comparing against a local copy would be a second statement of
# somebody else's constant — the kind that stays right until it does not.
#
# What they are FOR: an invalid `SpanContext` is all zeroes and formats
# perfectly happily as thirty-two of them. Emitting that would put a
# plausible-looking trace ID on every line a worker writes outside an activity —
# startup, shutdown, a poll failure — and every one would resolve to nothing in
# Grafana. The processors below emit NOTHING instead, and `test_telemetry.py`
# asserts the absence.


def build_tracer_provider(settings: WorkerSettings, *, service_name: str) -> TracerProvider:
    """A tracer provider, built but not installed.

    Split from `configure_telemetry` so that it can be tested without touching
    process-global state. `trace.set_tracer_provider` REFUSES a second
    registration — it logs "Overriding of current TracerProvider is not allowed"
    and keeps the first, at exit 0 — so a test suite that reached the installing
    function three times would be asserting on the first call's provider for the
    other two, silently.

    **An explicit `Resource`, per ADR-0029 obligation 11.** `service.name` is
    passed rather than left to `OTEL_SERVICE_NAME`, because the two worker
    processes share this module and every other line of it: a resource that did
    not name the service would file both workers' spans under one anonymous
    entry, which looks exactly like working until somebody asks which of the two
    was slow. `Resource.create` still merges `OTEL_RESOURCE_ATTRIBUTES`, so a
    deployment can add its region and version without a code change; our
    explicit attribute is merged last and wins.

    **The exporter is optional, and the default is none.** Plan 0C forbids
    shipping a sink before the API's `Error`-message leak is closed, and an
    endpoint is a deployment concern in any case. Credentials are deliberately
    NOT a `WorkerSettings` field: the OTLP exporter reads
    `OTEL_EXPORTER_OTLP_HEADERS` itself, so an authentication token never
    becomes an attribute of a settings object this repository logs and
    validates. That is the same reasoning `WorkerSettings` already applies to
    AWS credentials.

    `BatchSpanProcessor`, not `Simple`: a worker is a long-lived process doing
    multi-minute work, and one HTTP request per span from a slicer would be a
    second workload. The batch processor's queue is bounded and drops on
    overflow, which is the correct failure for telemetry — never back-pressure
    onto the activity.
    """
    provider = TracerProvider(resource=Resource.create({SERVICE_NAME: service_name}))
    if settings.otlp_endpoint is not None:
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=settings.otlp_endpoint))
        )
    return provider


def configure_telemetry(settings: WorkerSettings, *, service_name: str) -> TracerProvider:
    """Build the provider and install it as the global one.

    Called exactly once per process, from a worker's `__main__`. The global is
    what `temporalio.contrib.opentelemetry` reaches for when it is constructed
    without an explicit tracer, so this is what decides whether the activity
    spans exist at all.
    """
    provider = build_tracer_provider(settings, service_name=service_name)
    trace.set_tracer_provider(provider)
    return provider


def temporal_tracing_interceptor() -> TracingInterceptor:
    """The interceptor that carries the correlation across the wire.

    **The propagator is set explicitly, and Temporal does NOT read the global
    one.** `TracingInterceptor` holds its own `text_map_propagator`, so
    `propagate.set_global_textmap(...)` has no effect on anything in this
    system — it would be a control that looks like it works and does not. The
    composite below is what `temporalio` defaults to today; stating it here is
    what makes the requirement visible and what stops a `temporalio` bump
    changing it silently.

    **Both members are load-bearing, and they fail separately.** ADR-0029
    question 4 measured a propagator carrying `traceparent` and dropping
    `baggage`: the workflow completes, every component reports success, exit 0 —
    and one request has become three unrelated traces with the request ID
    missing from the leg most likely to have failed. `test_telemetry.py` asserts
    on `.fields`, which is the only place that is observable before it happens.

    Not `OpenTelemetryPlugin` / `OpenTelemetryInterceptor`, which
    `temporalio@1.31.0` also ships: both are marked experimental in their own
    docstrings ("may change in future versions, use with caution in production"),
    and `TracingInterceptor` is the one ADR-0029 measured carrying a trace from a
    Node client into a Python activity. The experimental pair's advantage is
    accurate span parenting INSIDE a workflow, and there are no Python workflows
    here by design.
    """
    interceptor = TracingInterceptor()
    interceptor.text_map_propagator = CompositePropagator(
        [TraceContextTextMapPropagator(), W3CBaggagePropagator()]
    )
    return interceptor


def bind_correlation(_logger: WrappedLogger, _method_name: str, event_dict: EventDict) -> EventDict:
    """Put the caller's identifiers on the line, from the live OTel context.

    A PROCESSOR rather than a `bind_contextvars` call in an interceptor, and the
    difference matters: a processor reads the context at the moment the line is
    written, so it covers every log call in the process — including ones from a
    library that has never heard of Temporal — and there is nothing for an
    activity to forget to do. It also cannot go stale, which a bound contextvar
    can when work moves between activities in the same task.

    `requestId` comes from BAGGAGE and `traceId` from the SPAN. Two mechanisms,
    two failure modes, and the propagator can carry one without the other; the
    tests assert them apart from each other for that reason.

    A value already on the event dict wins. A caller that passed an explicit
    `requestId=` is talking about something other than its own context, and
    silently overwriting it would be the processor lying.
    """
    span_context = trace.get_current_span().get_span_context()
    if span_context.trace_id != INVALID_TRACE_ID:
        event_dict.setdefault(FIELD_TRACE_ID, format(span_context.trace_id, "032x"))
    if span_context.span_id != INVALID_SPAN_ID:
        event_dict.setdefault(FIELD_SPAN_ID, format(span_context.span_id, "016x"))

    for baggage_key, field in (
        (BAGGAGE_REQUEST_ID, FIELD_REQUEST_ID),
        (BAGGAGE_ORGANIZATION_ID, FIELD_ORGANIZATION_ID),
    ):
        value = baggage.get_baggage(baggage_key)
        if value is not None:
            event_dict.setdefault(field, str(value))

    return event_dict


def bind_activity_context(
    _logger: WrappedLogger, _method_name: str, event_dict: EventDict
) -> EventDict:
    """Name the Temporal execution a line came from, when there is one.

    `traceId` finds the trace; these find the RUN, which is what an operator
    opens in the Temporal UI and what a retry storm is diagnosed from. `attempt`
    especially: an activity logging the same failure four times is a different
    picture from four activities failing once.

    Guarded by `in_activity()` because `activity.info()` raises outside one, and
    a logging processor that can raise turns every log call in the process into
    a possible crash — including the one reporting the original failure.
    """
    if not activity.in_activity():
        return event_dict

    info = activity.info()
    event_dict.setdefault("activityType", info.activity_type)
    event_dict.setdefault("attempt", info.attempt)
    if info.workflow_id:
        event_dict.setdefault("workflowId", info.workflow_id)
    if info.workflow_run_id:
        event_dict.setdefault("workflowRunId", info.workflow_run_id)
    return event_dict
