/* eslint-disable no-bitwise -- OpenTelemetry trace flags are a bit field. */

import {
  TraceFlags,
  isSpanContextValid,
  trace,
  type Attributes,
  type Context,
} from '@opentelemetry/api';
import type { ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { utf8BytesToString, utf8StringToBytes } from './encoding';

interface MetricExemplar {
  asDouble: number;
  timeUnixNano: string;
  traceId: string;
  spanId: string;
}

type JsonRecord = Record<string, unknown>;

/**
 * The stable JS metrics SDK does not currently attach exemplars to aggregated
 * points. This bounded registry bridges sampled measurements into OTLP/JSON
 * without adding trace IDs as metric labels.
 */
export class MetricExemplarRegistry {
  private readonly exemplars = new Map<string, MetricExemplar>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now
  ) {}

  record(
    metricName: string,
    value: number,
    attributes: Attributes,
    context: Context
  ): void {
    const spanContext = trace.getSpanContext(context);
    if (
      !spanContext ||
      !isSpanContextValid(spanContext) ||
      (spanContext.traceFlags & TraceFlags.SAMPLED) === 0
    ) {
      return;
    }
    const key = pointKey(metricName, attributes);
    if (!this.exemplars.has(key) && this.exemplars.size >= this.maxEntries) {
      const oldest = this.exemplars.keys().next().value;
      if (oldest !== undefined) this.exemplars.delete(oldest);
    }
    this.exemplars.set(key, {
      asDouble: value,
      timeUnixNano: `${Math.max(0, Math.trunc(this.now()))}000000`,
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    });
  }

  decorate(
    payload: Uint8Array | undefined,
    metrics: ResourceMetrics
  ): Uint8Array | undefined {
    if (!payload) return undefined;
    if (this.exemplars.size === 0) return payload;
    try {
      const root = JSON.parse(utf8BytesToString(payload)) as JsonRecord;
      const resourceMetrics = asArray(root.resourceMetrics)?.[0];
      if (!isRecord(resourceMetrics)) return payload;
      const outputScopes = asArray(resourceMetrics.scopeMetrics);
      if (!outputScopes) return payload;

      let decorated = false;
      metrics.scopeMetrics.forEach((scope, scopeIndex) => {
        const outputScope = outputScopes[scopeIndex];
        if (!isRecord(outputScope)) return;
        const outputMetrics = asArray(outputScope.metrics);
        if (!outputMetrics) return;
        scope.metrics.forEach((metric, metricIndex) => {
          const outputMetric = outputMetrics[metricIndex];
          if (!isRecord(outputMetric)) return;
          const outputPoints = metricDataPoints(outputMetric);
          if (!outputPoints) return;
          metric.dataPoints.forEach((point, pointIndex) => {
            const exemplar = this.exemplars.get(
              pointKey(metric.descriptor.name, point.attributes)
            );
            const outputPoint = outputPoints[pointIndex];
            if (!exemplar || !isRecord(outputPoint)) return;
            outputPoint.exemplars = [exemplar];
            this.exemplars.delete(
              pointKey(metric.descriptor.name, point.attributes)
            );
            decorated = true;
          });
        });
      });
      return decorated ? utf8StringToBytes(JSON.stringify(root)) : payload;
    } catch {
      return payload;
    }
  }

  clear(): void {
    this.exemplars.clear();
  }
}

function pointKey(name: string, attributes: Attributes): string {
  const normalized = Object.keys(attributes)
    .sort()
    .map((key) => [key, attributes[key]]);
  return `${name}:${JSON.stringify(normalized)}`;
}

function metricDataPoints(metric: JsonRecord): unknown[] | undefined {
  for (const field of ['sum', 'gauge', 'histogram', 'exponentialHistogram']) {
    const data = metric[field];
    if (isRecord(data)) return asArray(data.dataPoints);
  }
  return undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
