import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getEnv } from '../config/env.ts';
import { createLogger } from '../shared/logger.ts';

const logger = createLogger('tracing');

let sdk: NodeSDK | null = null;

export const startTracing = (): void => {
  const env = getEnv();
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  try {
    sdk = new NodeSDK({
      serviceName: env.OTEL_SERVICE_NAME,
      traceExporter: new OTLPTraceExporter({
        url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '')}/v1/traces`,
      }),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
    logger.info({ endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }, 'otel tracing started');
  } catch (error) {
    logger.warn({ err: error }, 'otel tracing failed to start; continuing without tracing');
  }
};

export const stopTracing = async (): Promise<void> => {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (error) {
    logger.warn({ err: error }, 'otel tracing shutdown failed');
  }
};

startTracing();
