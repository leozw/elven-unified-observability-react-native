import { trace, type Attributes, type Context } from '@opentelemetry/api';
import {
  SeverityNumber,
  type Logger as OtelLogger,
} from '@opentelemetry/api-logs';
import type { DynamicTelemetryContext } from './dynamicContext';
import type { Sanitizer } from './sanitizer';
import { toOtelContext } from './context';
import type {
  AttributeInputs,
  LogLevel,
  LogOptions,
  ResolvedConfig,
  TraceContext,
} from '../types';

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

export class StructuredLogger {
  constructor(
    private readonly logger: OtelLogger,
    private readonly contextManager: DynamicTelemetryContext,
    private readonly sanitizer: Sanitizer,
    private readonly config: ResolvedConfig,
    private readonly random: () => number = Math.random
  ) {}

  debug(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.emit('debug', message, attributes, options);
  }

  info(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.emit('info', message, attributes, options);
  }

  warn(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.emit('warn', message, attributes, options);
  }

  error(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.emit('error', message, attributes, options);
  }

  fatal(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.emit('fatal', message, attributes, options);
  }

  emit(
    level: LogLevel,
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    const sampleRatio = this.config.sampling.logRatio[level];
    if (
      !this.config.signals.logs ||
      sampleRatio <= 0 ||
      (sampleRatio < 1 && this.random() >= sampleRatio)
    ) {
      return;
    }
    try {
      const otelContext = toOtelContext(
        options?.context,
        this.contextManager.active()
      );
      const spanContext = trace.getSpanContext(otelContext);
      const correlation: Attributes = spanContext
        ? {
            trace_id: spanContext.traceId,
            span_id: spanContext.spanId,
          }
        : {};
      const exceptionAttributes = options?.error
        ? this.sanitizer.exception(options.error)
        : {};
      this.logger.emit({
        body: this.sanitizer.message(message),
        severityNumber: SEVERITY[level],
        severityText: level.toUpperCase(),
        ...(options?.eventName
          ? { eventName: this.sanitizer.eventName(options.eventName) }
          : {}),
        attributes: {
          ...this.contextManager.telemetryAttributes(),
          ...this.sanitizer.attributes(attributes),
          ...exceptionAttributes,
          ...correlation,
        },
        context: otelContext,
      });
    } catch {
      // Application logging cannot be coupled to telemetry health.
    }
  }

  child(
    context: Context | TraceContext,
    fixedAttributes?: AttributeInputs
  ): ContextualLogger {
    return new ContextualLogger(this, context, fixedAttributes);
  }
}

export class ContextualLogger {
  constructor(
    private readonly parent: StructuredLogger,
    private readonly context: Context | TraceContext,
    private readonly fixedAttributes?: AttributeInputs
  ) {}

  debug(message: unknown, attributes?: AttributeInputs): void {
    this.write('debug', message, attributes);
  }

  info(message: unknown, attributes?: AttributeInputs): void {
    this.write('info', message, attributes);
  }

  warn(message: unknown, attributes?: AttributeInputs): void {
    this.write('warn', message, attributes);
  }

  error(message: unknown, attributes?: AttributeInputs, error?: unknown): void {
    this.write('error', message, attributes, error);
  }

  fatal(message: unknown, attributes?: AttributeInputs, error?: unknown): void {
    this.write('fatal', message, attributes, error);
  }

  private write(
    level: LogLevel,
    message: unknown,
    attributes?: AttributeInputs,
    error?: unknown
  ): void {
    this.parent.emit(
      level,
      message,
      { ...this.fixedAttributes, ...attributes },
      { context: this.context, ...(error !== undefined ? { error } : {}) }
    );
  }
}
