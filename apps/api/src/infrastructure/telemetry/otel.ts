import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import type { Env } from '../../config/env.js';

/**
 * OpenTelemetry bootstrap. Must be imported before any instrumented module.
 * No-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset (local dev).
 */
export function startTelemetry(env: Env): NodeSDK | null {
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined || env.OTEL_EXPORTER_OTLP_ENDPOINT === '') {
    return null;
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.serviceName,
      'deployment.environment': env.NODE_ENV,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return sdk;
}
