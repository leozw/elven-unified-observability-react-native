import { AppState } from 'react-native';
import { ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';
import { Diagnostics } from '../core/diagnostics';
import type { DynamicTelemetryContext } from '../core/dynamicContext';
import type { StructuredLogger } from '../core/logger';
import type { MetricRecorder } from '../core/metrics';
import type { ElvenTracer } from '../core/tracer';
import { LifecycleInstrumentation } from '../instrumentation/lifecycle';
import { ReactNavigationInstrumentation } from '../instrumentation/navigation';
import { NativeEventProcessor } from '../instrumentation/nativeEvents';
import type { NativeBridge } from '../native/bridge';
import { resolvedConfiguration } from '../__fixtures__/testConfig';
import type {
  AttributeInputs,
  NativeTelemetryEvent,
  SpanOptions,
  SpanStatus,
} from '../types';

class InstrumentationSpan {
  readonly context = ROOT_CONTEXT;
  readonly statuses: SpanStatus[] = [];
  endedAt: number | undefined;

  setStatus(status: SpanStatus): this {
    this.statuses.push(status);
    return this;
  }

  end(endTime?: number): void {
    this.endedAt = endTime ?? Date.now();
  }
}

function tracerDouble() {
  const spans: InstrumentationSpan[] = [];
  const calls: Array<{ name: string; options?: SpanOptions }> = [];
  const startSpan = jest.fn((name: string, options?: SpanOptions) => {
    const span = new InstrumentationSpan();
    calls.push({ name, ...(options ? { options } : {}) });
    spans.push(span);
    return span;
  });
  return {
    tracer: { startSpan } as unknown as ElvenTracer,
    spans,
    calls,
    startSpan,
  };
}

describe('LifecycleInstrumentation', () => {
  it('records startup, lifecycle, memory pressure, background flush, and cleanup', () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const removals: jest.Mock[] = [];
    const addListener = jest.spyOn(AppState, 'addEventListener');
    (addListener as unknown as jest.Mock).mockImplementation(
      (type: string, listener: (value?: unknown) => void) => {
        listeners.set(type, listener);
        const remove = jest.fn();
        removals.push(remove);
        return { remove };
      }
    );
    const tracer = tracerDouble();
    const logger = { info: jest.fn(), warn: jest.fn() };
    const metrics = { counter: jest.fn(), histogram: jest.fn() };
    const flush = jest.fn(async () => undefined);
    const now = Date.now();
    const instrumentation = new LifecycleInstrumentation(
      resolvedConfiguration({
        instrumentations: {
          console: false,
          network: false,
          errors: false,
          lifecycle: { enabled: true, flushOnBackground: true },
        },
      }),
      { platform: 'android', processStartUnixMillis: now - 500 },
      tracer.tracer,
      logger as unknown as StructuredLogger,
      metrics as unknown as MetricRecorder,
      flush
    );

    instrumentation.start();
    listeners.get('change')?.('background');
    listeners.get('change')?.('background');
    listeners.get('memoryWarning')?.();

    expect(tracer.calls.map((call) => call.name)).toEqual([
      'app.start',
      'app.lifecycle.change',
      'app.memory.warning',
    ]);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(metrics.counter).toHaveBeenCalledTimes(3);
    expect(metrics.histogram).toHaveBeenCalledWith(
      'app.start.duration',
      expect.any(Number),
      undefined,
      expect.objectContaining({ unit: 's' })
    );
    expect(flush).toHaveBeenCalledTimes(1);

    instrumentation.shutdown();
    expect(removals).toHaveLength(2);
    expect(removals.every((remove) => remove.mock.calls.length === 1)).toBe(
      true
    );
    addListener.mockRestore();
  });
});

describe('ReactNavigationInstrumentation', () => {
  it('creates one span per route, excludes params by default, and closes spans', () => {
    let route = {
      key: 'home-1',
      name: 'Home',
      params: { token: 'must-not-be-read' },
    };
    const navigation = { getCurrentRoute: () => route };
    const tracer = tracerDouble();
    const logger = { info: jest.fn() };
    const metrics = { counter: jest.fn() };
    const context = { setNavigationContext: jest.fn() };
    const instrumentation = new ReactNavigationInstrumentation(
      navigation,
      {},
      tracer.tracer,
      logger as unknown as StructuredLogger,
      metrics as unknown as MetricRecorder,
      context as unknown as DynamicTelemetryContext
    );

    instrumentation.onReady();
    instrumentation.onStateChange();
    route = {
      key: 'checkout-1',
      name: 'Checkout',
      params: { token: 'still-private' },
    };
    instrumentation.onStateChange();

    expect(tracer.calls).toHaveLength(2);
    expect(tracer.calls[0]).toEqual(
      expect.objectContaining({ name: 'screen Home' })
    );
    expect(JSON.stringify(tracer.calls)).not.toContain('must-not-be-read');
    expect(JSON.stringify(tracer.calls)).not.toContain('still-private');
    expect(tracer.spans[0]?.statuses).toContainEqual({
      code: SpanStatusCode.OK,
    });
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(metrics.counter).toHaveBeenCalledTimes(2);

    instrumentation.shutdown();
    expect(tracer.spans[1]?.statuses).toContainEqual({
      code: SpanStatusCode.OK,
    });
    expect(context.setNavigationContext).toHaveBeenLastCalledWith(null);
  });

  it('falls back safely when optional navigation callbacks throw', () => {
    const tracer = tracerDouble();
    const instrumentation = new ReactNavigationInstrumentation(
      { getCurrentRoute: () => ({ name: 'SafeScreen' }) },
      {
        attributes: (): AttributeInputs => {
          throw new Error('consumer callback');
        },
        spanName: (): string => {
          throw new Error('consumer callback');
        },
      },
      tracer.tracer,
      { info: jest.fn() } as unknown as StructuredLogger,
      { counter: jest.fn() } as unknown as MetricRecorder,
      { setNavigationContext: jest.fn() } as unknown as DynamicTelemetryContext
    );
    expect(() => instrumentation.onReady()).not.toThrow();
    expect(tracer.calls[0]?.name).toBe('screen SafeScreen');
    instrumentation.shutdown();
  });
});

describe('NativeEventProcessor', () => {
  const crash: NativeTelemetryEvent = {
    id: 'crash-1',
    type: 'crash',
    name: 'app.native.crash',
    timestampUnixMillis: 1_725_000_000_000,
    attributes: { 'exception.type': 'NativeException' },
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: '0123456789abcdef',
  };
  const frames: NativeTelemetryEvent = {
    id: 'frames-1',
    type: 'performance',
    name: 'app.frames',
    timestampUnixMillis: 1_725_000_001_000,
    durationMillis: 2_000,
    attributes: { 'frame.frozen.count': 1 },
  };

  it('deduplicates native events and maps errors, durations, and parents', async () => {
    const bridge = {
      available: true,
      drainEvents: jest.fn(async () => [crash, frames]),
    };
    const tracer = tracerDouble();
    const logger = { emit: jest.fn(), info: jest.fn() };
    const metrics = { counter: jest.fn(), histogram: jest.fn() };
    const processor = new NativeEventProcessor(
      bridge as unknown as NativeBridge,
      tracer.tracer,
      logger as unknown as StructuredLogger,
      metrics as unknown as MetricRecorder,
      new Diagnostics({ enabled: false, verbose: false })
    );

    await processor.drain();
    await processor.drain();
    expect(tracer.calls).toHaveLength(2);
    expect(tracer.calls[0]?.options).toEqual(
      expect.objectContaining({
        parent: expect.objectContaining({
          traceId: crash.traceId,
          spanId: crash.spanId,
        }),
      })
    );
    expect(tracer.spans[0]?.statuses).toContainEqual(
      expect.objectContaining({ code: SpanStatusCode.ERROR })
    );
    expect(tracer.spans[1]?.endedAt).toBe(
      frames.timestampUnixMillis + (frames.durationMillis ?? 0)
    );
    expect(logger.emit).toHaveBeenCalledWith(
      'fatal',
      expect.any(String),
      expect.any(Object),
      expect.any(Object)
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(metrics.counter).toHaveBeenCalledTimes(2);
    expect(metrics.histogram).toHaveBeenCalledTimes(1);
  });

  it('does not touch the bridge when the native module is unavailable', async () => {
    const drainEvents = jest.fn(async () => [crash]);
    const processor = new NativeEventProcessor(
      { available: false, drainEvents } as unknown as NativeBridge,
      tracerDouble().tracer,
      { emit: jest.fn(), info: jest.fn() } as unknown as StructuredLogger,
      { counter: jest.fn(), histogram: jest.fn() } as unknown as MetricRecorder,
      new Diagnostics({ enabled: false, verbose: false })
    );
    await processor.drain();
    expect(drainEvents).not.toHaveBeenCalled();
  });
});
