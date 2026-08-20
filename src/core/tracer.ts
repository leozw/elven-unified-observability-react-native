import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import type { Diagnostics } from './diagnostics';
import type { DynamicTelemetryContext } from './dynamicContext';
import type { NativeBridge } from '../native/bridge';
import type { Sanitizer } from './sanitizer';
import { toOtelContext, toTraceContext } from './context';
import type {
  AttributeInputs,
  SpanOptions,
  SpanHandle,
  SpanStatus,
  TraceContext,
} from '../types';

export class ElvenTracer {
  constructor(
    private readonly tracer: Tracer,
    private readonly contextManager: DynamicTelemetryContext,
    private readonly sanitizer: Sanitizer,
    private readonly nativeBridge: NativeBridge,
    private readonly diagnostics: Diagnostics
  ) {}

  startSpan(name: string, options: SpanOptions = {}): ElvenSpan {
    const parent = toOtelContext(options.parent, this.contextManager.active());
    const span = this.tracer.startSpan(
      this.sanitizer.eventName(name),
      {
        ...(options.kind !== undefined ? { kind: options.kind } : {}),
        attributes: {
          ...this.contextManager.telemetryAttributes(),
          ...this.sanitizer.attributes(options.attributes),
        },
        ...(options.startTimeUnixMillis !== undefined
          ? { startTime: options.startTimeUnixMillis }
          : {}),
      },
      parent
    );
    const spanContext = trace.setSpan(parent, span);
    return new ElvenSpan(
      span,
      spanContext,
      this.contextManager,
      this.sanitizer,
      this.nativeBridge
    );
  }

  withSpan<T>(
    name: string,
    operation: (span: ElvenSpan) => T,
    options?: SpanOptions
  ): T {
    const span = this.startSpan(name, options);
    try {
      const result = span.run(() => operation(span));
      if (isPromiseLike(result)) {
        return Promise.resolve(result)
          .then((value) => {
            span.setStatus({ code: SpanStatusCode.OK });
            return value;
          })
          .catch((error: unknown) => {
            span.recordException(error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            throw error;
          })
          .finally(() => span.end()) as T;
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.end();
      throw error;
    }
  }

  currentTraceContext(): TraceContext | undefined {
    return toTraceContext(this.contextManager.active());
  }

  restore<T>(traceContext: TraceContext, operation: () => T): T {
    try {
      return this.contextManager.run(traceContext, operation);
    } catch (error) {
      this.diagnostics.debug('Could not restore the supplied trace context.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return operation();
    }
  }
}

export class ElvenSpan implements SpanHandle {
  private ended = false;

  constructor(
    private readonly span: Span,
    readonly context: Context,
    private readonly contextManager: DynamicTelemetryContext,
    private readonly sanitizer: Sanitizer,
    private readonly nativeBridge: NativeBridge
  ) {}

  traceContext(): TraceContext | undefined {
    return toTraceContext(this.span);
  }

  setAttribute(key: string, value: unknown): this {
    const attributes = this.sanitizer.attributes({ [key]: value }, 1);
    const entry = Object.entries(attributes)[0];
    if (entry?.[1] !== undefined) this.span.setAttribute(entry[0], entry[1]);
    return this;
  }

  setAttributes(values: AttributeInputs): this {
    this.span.setAttributes(this.sanitizer.attributes(values));
    return this;
  }

  addEvent(
    name: string,
    attributes?: AttributeInputs,
    timestampUnixMillis?: number
  ): this {
    this.span.addEvent(
      this.sanitizer.eventName(name),
      this.sanitizer.attributes(attributes),
      timestampUnixMillis
    );
    return this;
  }

  recordException(error: unknown): this {
    const attributes = this.sanitizer.exception(error);
    this.span.recordException({
      name: String(attributes['exception.type'] ?? 'Error'),
      message: String(attributes['exception.message'] ?? 'Unknown error'),
      ...(attributes['exception.stacktrace']
        ? { stack: String(attributes['exception.stacktrace']) }
        : {}),
    });
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.span.setStatus({
      code: status.code,
      ...(status.message
        ? { message: this.sanitizer.message(status.message) }
        : {}),
    });
    return this;
  }

  run<T>(operation: () => T): T {
    const previous = toTraceContext(this.contextManager.active());
    return this.contextManager.run(this.context, () => {
      this.nativeBridge.setCurrentTraceContext(this.traceContext());
      try {
        return operation();
      } finally {
        this.nativeBridge.setCurrentTraceContext(previous);
      }
    });
  }

  bind<T>(value: T): T {
    return this.contextManager.bind(this.context, value);
  }

  end(endTimeUnixMillis?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.span.end(endTimeUnixMillis);
  }

  attributes(): Attributes {
    const traceContext = this.traceContext();
    return traceContext
      ? { trace_id: traceContext.traceId, span_id: traceContext.spanId }
      : {};
  }
}

function isPromiseLike<T>(value: T): value is T & PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
