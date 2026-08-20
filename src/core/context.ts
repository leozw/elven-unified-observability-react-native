import {
  ROOT_CONTEXT,
  context,
  createTraceState,
  isSpanContextValid,
  trace,
  type Context,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import type { TraceContext } from '../types';

export function toOtelContext(
  input: Context | TraceContext | undefined,
  fallback: Context = context.active()
): Context {
  if (!input) return fallback;
  if (isContext(input)) return input;
  const spanContext: SpanContext = {
    traceId: input.traceId,
    spanId: input.spanId,
    traceFlags: input.traceFlags,
    isRemote: true,
    ...(input.traceState
      ? { traceState: createTraceState(input.traceState) }
      : {}),
  };
  return isSpanContextValid(spanContext)
    ? trace.setSpanContext(ROOT_CONTEXT, spanContext)
    : fallback;
}

export function toTraceContext(
  input: Context | Span | SpanContext | undefined
): TraceContext | undefined {
  const spanContext = resolveSpanContext(input);
  if (!spanContext || !isSpanContextValid(spanContext)) return undefined;
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    ...(spanContext.traceState
      ? { traceState: spanContext.traceState.serialize() }
      : {}),
  };
}

export function activeTraceContext(): TraceContext | undefined {
  return toTraceContext(context.active());
}

function resolveSpanContext(
  input: Context | Span | SpanContext | undefined
): SpanContext | undefined {
  if (!input) return trace.getSpanContext(context.active());
  if (isContext(input)) return trace.getSpanContext(input);
  if ('spanContext' in input && typeof input.spanContext === 'function') {
    return input.spanContext();
  }
  return input as SpanContext;
}

function isContext(input: unknown): input is Context {
  return (
    typeof input === 'object' &&
    input !== null &&
    'getValue' in input &&
    typeof input.getValue === 'function'
  );
}
