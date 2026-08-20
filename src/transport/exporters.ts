import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import {
  JsonLogsSerializer,
  JsonMetricsSerializer,
  JsonTraceSerializer,
} from '@opentelemetry/otlp-transformer';
import type {
  ReadableLogRecord,
  LogRecordExporter,
} from '@opentelemetry/sdk-logs';
import type {
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ensureTextEncoder, utf8BytesToString } from '../core/encoding';
import type { MetricExemplarRegistry } from '../core/metricExemplars';
import type { DurableTransport } from './durableTransport';

type ResultCallback = (result: ExportResult) => void;

abstract class TransportExporter {
  protected closed = false;

  constructor(protected readonly transport: DurableTransport) {}

  async forceFlush(): Promise<void> {
    await this.transport.flush(true);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
  }

  protected complete(
    payload: Uint8Array | undefined,
    signal: 'logs' | 'metrics' | 'traces',
    priority: number,
    callback: ResultCallback
  ): void {
    if (this.closed || !payload || payload.length === 0) {
      callback({
        code: ExportResultCode.FAILED,
        error: new Error(`Cannot export ${signal}: exporter is unavailable.`),
      });
      return;
    }
    this.transport
      .enqueue(signal, utf8BytesToString(payload), priority)
      .then((accepted) => {
        callback(
          accepted
            ? { code: ExportResultCode.SUCCESS }
            : {
                code: ExportResultCode.FAILED,
                error: new Error(
                  `The ${signal} batch was rejected by backpressure.`
                ),
              }
        );
      })
      .catch((error: unknown) => {
        callback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
  }
}

export class OtlpTraceTransportExporter
  extends TransportExporter
  implements SpanExporter
{
  export(spans: ReadableSpan[], callback: ResultCallback): void {
    try {
      ensureTextEncoder();
      const hasError = spans.some((span) => span.status.code === 2);
      this.complete(
        JsonTraceSerializer.serializeRequest(spans),
        'traces',
        hasError ? 3 : 2,
        callback
      );
    } catch (error) {
      callback(failedResult(error));
    }
  }
}

export class OtlpLogTransportExporter
  extends TransportExporter
  implements LogRecordExporter
{
  export(records: ReadableLogRecord[], callback: ResultCallback): void {
    try {
      ensureTextEncoder();
      this.complete(
        JsonLogsSerializer.serializeRequest(records),
        'logs',
        logPriority(records),
        callback
      );
    } catch (error) {
      callback(failedResult(error));
    }
  }
}

export class OtlpMetricTransportExporter
  extends TransportExporter
  implements PushMetricExporter
{
  constructor(
    transport: DurableTransport,
    private readonly exemplars: MetricExemplarRegistry
  ) {
    super(transport);
  }

  export(metrics: ResourceMetrics, callback: ResultCallback): void {
    try {
      ensureTextEncoder();
      this.complete(
        this.exemplars.decorate(
          JsonMetricsSerializer.serializeRequest(metrics),
          metrics
        ),
        'metrics',
        1,
        callback
      );
    } catch (error) {
      callback(failedResult(error));
    }
  }
}

function logPriority(records: ReadonlyArray<ReadableLogRecord>): number {
  const maximumSeverity = records.reduce(
    (maximum, record) => Math.max(maximum, record.severityNumber ?? 0),
    0
  );
  if (maximumSeverity >= 17) return 3;
  if (maximumSeverity >= 13) return 2;
  if (maximumSeverity >= 9) return 1;
  return 0;
}

function failedResult(error: unknown): ExportResult {
  return {
    code: ExportResultCode.FAILED,
    error: error instanceof Error ? error : new Error(String(error)),
  };
}
