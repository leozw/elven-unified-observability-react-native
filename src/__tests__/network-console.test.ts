import { ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';
import { ConsoleInstrumentation } from '../instrumentation/console';
import { NetworkInstrumentation } from '../instrumentation/network';
import { Diagnostics } from '../core/diagnostics';
import type { DynamicTelemetryContext } from '../core/dynamicContext';
import type { StructuredLogger } from '../core/logger';
import type { MetricRecorder } from '../core/metrics';
import { Sanitizer } from '../core/sanitizer';
import type { ElvenTracer } from '../core/tracer';
import { resolvedConfiguration } from '../__fixtures__/testConfig';
import type { AttributeInputs, SpanStatus } from '../types';

class FakeSpan {
  readonly context = ROOT_CONTEXT;
  readonly attributes: AttributeInputs[] = [];
  readonly statuses: SpanStatus[] = [];
  readonly exceptions: unknown[] = [];
  ended = 0;

  setAttributes(attributes: AttributeInputs): this {
    this.attributes.push(attributes);
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.statuses.push(status);
    return this;
  }

  recordException(error: unknown): this {
    this.exceptions.push(error);
    return this;
  }

  run<T>(operation: () => T): T {
    return operation();
  }

  end(): void {
    this.ended += 1;
  }
}

interface NetworkFakes {
  tracer: ElvenTracer;
  logger: StructuredLogger;
  metrics: MetricRecorder;
  context: DynamicTelemetryContext;
  spans: FakeSpan[];
  startSpan: jest.Mock;
  logError: jest.Mock;
  metricCounter: jest.Mock;
  metricHistogram: jest.Mock;
}

function networkFakes(): NetworkFakes {
  const spans: FakeSpan[] = [];
  const startSpan = jest.fn(() => {
    const span = new FakeSpan();
    spans.push(span);
    return span;
  });
  const logError = jest.fn();
  const metricCounter = jest.fn();
  const metricHistogram = jest.fn();
  return {
    tracer: { startSpan } as unknown as ElvenTracer,
    logger: { error: logError } as unknown as StructuredLogger,
    metrics: {
      counter: metricCounter,
      histogram: metricHistogram,
    } as unknown as MetricRecorder,
    context: {
      inject: () => ({
        traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      }),
    } as unknown as DynamicTelemetryContext,
    spans,
    startSpan,
    logError,
    metricCounter,
    metricHistogram,
  };
}

function response(status: number): Response {
  return {
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'x-response-id' ? 'response-42' : null,
    },
  } as unknown as Response;
}

describe('NetworkInstrumentation fetch', () => {
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;

  afterEach(() => {
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  it('propagates only to trusted origins and never captures query values or bodies', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const original = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(async (input, init) => {
      const url = String(input);
      calls.push({ input: url, ...(init ? { init } : {}) });
      if (url.includes('/failure')) throw new Error('offline');
      return response(url.includes('/server-error') ? 503 : 201);
    });
    (globalThis as { fetch?: typeof fetch }).fetch = original;
    const config = resolvedConfiguration({
      instrumentations: {
        console: false,
        errors: false,
        lifecycle: false,
        network: {
          enabled: true,
          fetch: true,
          xhr: false,
          propagateTraceHeadersTo: ['https://api.example.test'],
          captureRequestHeaders: ['x-request-id', 'authorization'],
          captureResponseHeaders: ['x-response-id'],
        },
      },
    });
    const fakes = networkFakes();
    const instrumentation = new NetworkInstrumentation(
      config,
      fakes.tracer,
      fakes.logger,
      fakes.metrics,
      fakes.context,
      new Sanitizer(config.privacy),
      new Diagnostics({ enabled: false, verbose: false }),
      original
    );
    instrumentation.start();

    await globalThis.fetch(
      'https://api.example.test/orders?token=secret&customer=person',
      {
        method: 'POST',
        headers: {
          'x-request-id': 'request-42',
          'authorization': 'Bearer application-secret',
        },
        body: '{"password":"never-capture-this"}',
      }
    );
    await globalThis.fetch('https://api.example.test.evil.test/orders');
    await globalThis.fetch('https://api.example.test/server-error');
    await expect(
      globalThis.fetch('https://api.example.test/failure')
    ).rejects.toThrow('offline');
    await globalThis.fetch('https://collector.example.test/v1/logs');

    expect(headerValue(calls[0]?.init?.headers, 'traceparent')).toMatch(
      /^00-[0-9a-f-]+-01$/
    );
    expect(headerValue(calls[1]?.init?.headers, 'traceparent')).toBeUndefined();
    expect(fakes.startSpan).toHaveBeenCalledTimes(4);
    const firstOptions = fakes.startSpan.mock.calls[0]?.[1] as {
      attributes: Record<string, unknown>;
    };
    expect(firstOptions.attributes['url.full']).toBe(
      'https://api.example.test/orders'
    );
    expect(JSON.stringify(firstOptions)).not.toContain('person');
    expect(JSON.stringify(firstOptions)).not.toContain('never-capture-this');
    expect(firstOptions.attributes['http.request.header.authorization']).toBe(
      'Bearer application-secret'
    );
    expect(fakes.spans[0]?.attributes[0]).toEqual(
      expect.objectContaining({
        'http.response.status_code': 201,
        'http.response.header.x-response-id': 'response-42',
      })
    );
    expect(fakes.spans[2]?.statuses).toContainEqual(
      expect.objectContaining({ code: SpanStatusCode.ERROR })
    );
    expect(fakes.spans[3]?.exceptions).toHaveLength(1);
    expect(fakes.logError).toHaveBeenCalledTimes(1);
    expect(fakes.metricCounter).toHaveBeenCalledTimes(4);
    expect(fakes.metricHistogram).toHaveBeenCalledTimes(4);

    instrumentation.shutdown();
    expect(globalThis.fetch).toBe(original);
  });
});

type XhrListener = () => void;

class FakeXmlHttpRequest {
  static instances: FakeXmlHttpRequest[] = [];
  readonly listeners = new Map<string, Set<XhrListener>>();
  readonly requestHeaders: Record<string, string> = {};
  method = 'GET';
  url = '';
  status = 200;

  constructor() {
    FakeXmlHttpRequest.instances.push(this);
  }

  open(method: string, url: string | URL): void {
    this.method = method;
    this.url = String(url);
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name.toLowerCase()] = value;
  }

  send(): void {
    if (this.url.includes('failure')) {
      this.status = 0;
      this.emit('error');
    }
    this.emit('loadend');
  }

  addEventListener(type: string, listener: XhrListener): void {
    const listeners = this.listeners.get(type) ?? new Set<XhrListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: XhrListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'x-response-id' ? 'xhr-response' : null;
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

describe('NetworkInstrumentation XHR', () => {
  const originalXhr = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest })
    .XMLHttpRequest;

  afterEach(() => {
    (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest =
      originalXhr;
    FakeXmlHttpRequest.instances = [];
  });

  it('creates one XHR span, propagates context, and finishes errors once', () => {
    (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest =
      FakeXmlHttpRequest as unknown as typeof XMLHttpRequest;
    const config = resolvedConfiguration({
      instrumentations: {
        console: false,
        errors: false,
        lifecycle: false,
        network: {
          enabled: true,
          fetch: false,
          xhr: true,
          propagateTraceHeadersTo: ['https://api.example.test'],
          captureResponseHeaders: ['x-response-id'],
        },
      },
    });
    const fakes = networkFakes();
    const instrumentation = new NetworkInstrumentation(
      config,
      fakes.tracer,
      fakes.logger,
      fakes.metrics,
      fakes.context,
      new Sanitizer(config.privacy),
      new Diagnostics({ enabled: false, verbose: false }),
      undefined
    );
    instrumentation.start();

    const success = new XMLHttpRequest();
    success.open('GET', 'https://api.example.test/success');
    success.send();
    const failure = new XMLHttpRequest();
    failure.open('POST', 'https://api.example.test/failure');
    failure.send('safe');

    const successInstance = success as unknown as FakeXmlHttpRequest;
    expect(successInstance.requestHeaders.traceparent).toBeDefined();
    expect(fakes.spans).toHaveLength(2);
    expect(fakes.spans[0]?.ended).toBe(1);
    expect(fakes.spans[1]?.ended).toBe(1);
    expect(fakes.spans[1]?.exceptions).toHaveLength(1);
    expect(fakes.logError).toHaveBeenCalledTimes(1);
    instrumentation.shutdown();
  });
});

describe('ConsoleInstrumentation', () => {
  it('prevents recursion, respects levels, and restores console methods', () => {
    const originalWarn = console.warn;
    const originalInfo = console.info;
    console.info = jest.fn();
    const emit = jest.fn(() => console.warn('[nested]'));
    const config = resolvedConfiguration({
      instrumentations: {
        network: false,
        errors: false,
        lifecycle: false,
        console: {
          enabled: true,
          levels: ['warn'],
          preserveOriginal: false,
        },
      },
    });
    const instrumentation = new ConsoleInstrumentation(config, {
      emit,
    } as unknown as StructuredLogger);
    instrumentation.start();

    console.warn('Application warning', { token: 'secret' });
    console.info('Not captured');
    console.warn('[elven-observability] internal');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'warn',
      'Application warning',
      { 'console.method': 'warn', 'console.argument.1': { token: 'secret' } },
      { eventName: 'console' }
    );

    instrumentation.shutdown();
    expect(console.warn).toBe(originalWarn);
    console.info = originalInfo;
  });
});

function headerValue(
  headers: RequestInit['headers'],
  name: string
): string | undefined {
  if (!headers) return undefined;
  const candidate = headers as { get?(key: string): string | null };
  if (candidate.get) return candidate.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  }
  return (headers as Record<string, string>)[name];
}
