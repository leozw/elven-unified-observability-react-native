import { SpanStatusCode } from '@opentelemetry/api';
import type { Diagnostics } from '../core/diagnostics';
import type { StructuredLogger } from '../core/logger';
import type { MetricRecorder } from '../core/metrics';
import type { ElvenTracer } from '../core/tracer';
import type { NativeBridge } from '../native/bridge';
import type { NativeTelemetryEvent, TraceContext } from '../types';

export class NativeEventProcessor {
  private readonly seen = new Set<string>();

  constructor(
    private readonly bridge: NativeBridge,
    private readonly tracer: ElvenTracer,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricRecorder,
    private readonly diagnostics: Diagnostics
  ) {}

  async drain(): Promise<void> {
    if (!this.bridge.available) return;
    const events = await this.bridge.drainEvents();
    for (const event of events) {
      if (this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      if (this.seen.size > 256) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      try {
        this.process(event);
      } catch (error) {
        this.diagnostics.debug(
          'A native telemetry event could not be processed.',
          {
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    }
  }

  private process(event: NativeTelemetryEvent): void {
    const parent = nativeParent(event);
    const attributes = {
      'event.id': event.id,
      'event.type': event.type,
      'event.name': event.name,
      'telemetry.source': 'native',
      ...event.attributes,
      ...(event.durationMillis !== undefined
        ? { 'event.duration_ms': event.durationMillis }
        : {}),
    };
    const span = this.tracer.startSpan(`native.${event.name}`, {
      attributes,
      ...(parent ? { parent } : {}),
      startTimeUnixMillis: event.timestampUnixMillis,
    });
    if (event.type === 'crash' || event.type === 'error') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: event.name });
      this.logger.emit(
        event.type === 'crash' ? 'fatal' : 'error',
        `Native ${event.type}: ${event.name}`,
        attributes,
        { context: span.context, eventName: `native.${event.type}` }
      );
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
      this.logger.info(`Native event: ${event.name}`, attributes, {
        context: span.context,
        eventName: `native.${event.type}`,
      });
    }
    span.end(
      event.durationMillis !== undefined
        ? event.timestampUnixMillis + event.durationMillis
        : event.timestampUnixMillis
    );
    this.metrics.counter(
      'app.native.event.count',
      1,
      { 'event.type': event.type, 'event.name': event.name },
      { context: span.context }
    );
    if (event.durationMillis !== undefined) {
      this.metrics.histogram(
        'app.native.event.duration',
        event.durationMillis / 1_000,
        { 'event.type': event.type, 'event.name': event.name },
        { unit: 's', context: span.context }
      );
    }
  }
}

function nativeParent(event: NativeTelemetryEvent): TraceContext | undefined {
  if (!event.traceId || !event.spanId) return undefined;
  return {
    traceId: event.traceId,
    spanId: event.spanId,
    traceFlags: 1,
  };
}
