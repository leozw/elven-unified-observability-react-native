import { SpanStatusCode, type Attributes } from '@opentelemetry/api';
import {
  resourceFromAttributes,
  type Resource,
} from '@opentelemetry/resources';
import {
  AlwaysOffSampler,
  BatchSpanProcessor,
  BasicTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
  SDK_NAME,
  SDK_VERSION,
} from './constants';
import { DynamicTelemetryContext } from './dynamicContext';
import { StructuredLogger } from './logger';
import { MetricRecorder } from './metrics';
import { MetricExemplarRegistry } from './metricExemplars';
import { ElvenTracer } from './tracer';
import type { Diagnostics } from './diagnostics';
import type { Sanitizer } from './sanitizer';
import type { NativeBridge } from '../native/bridge';
import type { NativePlatformContext, ResolvedConfig } from '../types';
import type { DurableTransport } from '../transport/durableTransport';
import {
  OtlpLogTransportExporter,
  OtlpMetricTransportExporter,
  OtlpTraceTransportExporter,
} from '../transport/exporters';

export interface TelemetryProviders {
  resource: Resource;
  context: DynamicTelemetryContext;
  tracer: ElvenTracer;
  logger: StructuredLogger;
  metrics: MetricRecorder;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createTelemetryProviders(
  config: ResolvedConfig,
  platform: NativePlatformContext,
  transport: DurableTransport,
  nativeBridge: NativeBridge,
  sanitizer: Sanitizer,
  diagnostics: Diagnostics
): TelemetryProviders {
  const resource = createResource(config, platform, sanitizer);
  const traceExporter = new OtlpTraceTransportExporter(transport);
  const logExporter = new OtlpLogTransportExporter(transport);
  const exemplars = new MetricExemplarRegistry(
    config.privacy.maxMetricCardinality
  );
  const metricExporter = new OtlpMetricTransportExporter(transport, exemplars);

  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler: config.signals.traces
      ? new ParentBasedSampler({
          root: new TraceIdRatioBasedSampler(config.sampling.traceRatio),
        })
      : new AlwaysOffSampler(),
    spanProcessors: config.signals.traces
      ? [
          new BatchSpanProcessor(traceExporter, {
            maxQueueSize: config.batch.maxQueueSize,
            maxExportBatchSize: config.batch.maxExportBatchSize,
            scheduledDelayMillis: config.batch.scheduledDelayMillis,
            exportTimeoutMillis: config.batch.exportTimeoutMillis,
          }),
        ]
      : [],
    spanLimits: {
      attributeCountLimit: config.privacy.maxAttributeCount,
      attributeValueLengthLimit: config.privacy.maxAttributeValueLength,
      eventCountLimit: 64,
      linkCountLimit: 16,
      attributePerEventCountLimit: config.privacy.maxAttributeCount,
      attributePerLinkCountLimit: 16,
    },
  });

  const loggerProvider = new LoggerProvider({
    resource,
    logRecordLimits: {
      attributeCountLimit: config.privacy.maxAttributeCount,
      attributeValueLengthLimit: config.privacy.maxAttributeValueLength,
    },
    processors: config.signals.logs
      ? [
          new BatchLogRecordProcessor({
            exporter: logExporter,
            maxQueueSize: config.batch.maxQueueSize,
            maxExportBatchSize: config.batch.maxExportBatchSize,
            scheduledDelayMillis: config.batch.scheduledDelayMillis,
            exportTimeoutMillis: config.batch.exportTimeoutMillis,
          }),
        ]
      : [],
  });

  const metricReader = config.signals.metrics
    ? new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.batch.metricExportIntervalMillis,
        exportTimeoutMillis: Math.min(
          config.batch.exportTimeoutMillis,
          config.batch.metricExportIntervalMillis
        ),
        cardinalityLimits: {
          default: config.privacy.maxMetricCardinality,
        },
        maxExportBatchSize: config.batch.maxExportBatchSize,
      })
    : undefined;
  const meterProvider = new MeterProvider({
    resource,
    readers: metricReader ? [metricReader] : [],
  });

  const dynamicContext = new DynamicTelemetryContext(config, sanitizer);
  const tracer = new ElvenTracer(
    tracerProvider.getTracer(SDK_NAME, SDK_VERSION),
    dynamicContext,
    sanitizer,
    nativeBridge,
    diagnostics
  );
  const logger = new StructuredLogger(
    loggerProvider.getLogger(SDK_NAME, SDK_VERSION),
    dynamicContext,
    sanitizer,
    config
  );
  const metrics = new MetricRecorder(
    meterProvider.getMeter(SDK_NAME, SDK_VERSION),
    dynamicContext,
    sanitizer,
    diagnostics,
    config,
    exemplars
  );

  return {
    resource,
    context: dynamicContext,
    tracer,
    logger,
    metrics,
    async forceFlush(): Promise<void> {
      const results = await Promise.allSettled([
        tracerProvider.forceFlush(),
        loggerProvider.forceFlush({
          timeoutMillis: config.batch.exportTimeoutMillis,
        }),
        meterProvider.forceFlush({
          timeoutMillis: config.batch.exportTimeoutMillis,
        }),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') {
          diagnostics.debug('A telemetry provider could not flush.', {
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
        }
      }
    },
    async shutdown(): Promise<void> {
      const results = await Promise.allSettled([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
      dynamicContext.shutdown();
      exemplars.clear();
      if (results.some((result) => result.status === 'rejected')) {
        diagnostics.debug(
          'One or more telemetry providers failed to shut down.'
        );
      }
    },
  };
}

function createResource(
  config: ResolvedConfig,
  platform: NativePlatformContext,
  sanitizer: Sanitizer
): Resource {
  const version =
    config.version === '0.0.0' && platform.appVersion
      ? platform.appVersion
      : config.version;
  const attributes: Attributes = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: version,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
    ...(config.serviceNamespace
      ? { [ATTR_SERVICE_NAMESPACE]: config.serviceNamespace }
      : {}),
    'telemetry.distro.name': SDK_NAME,
    'telemetry.distro.version': SDK_VERSION,
    'process.runtime.name': hasHermes() ? 'hermes' : 'javascript',
    'os.name': platform.platform,
    ...(platform.osVersion ? { 'os.version': platform.osVersion } : {}),
    ...(platform.deviceModel
      ? { 'device.model.name': platform.deviceModel }
      : {}),
    ...(platform.appBuild ? { 'app.build_id': platform.appBuild } : {}),
    ...(platform.appBundleId ? { 'app.bundle.id': platform.appBundleId } : {}),
    ...(platform.isEmulator !== undefined
      ? { 'device.emulator': platform.isEmulator }
      : {}),
    ...config.resourceAttributes,
  };
  return resourceFromAttributes(sanitizer.attributes(attributes));
}

function hasHermes(): boolean {
  return Boolean(
    (globalThis as unknown as { HermesInternal?: unknown }).HermesInternal
  );
}

export { SpanStatusCode };
