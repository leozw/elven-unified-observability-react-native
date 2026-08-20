import { ElvenObservabilitySdk } from '../sdk';
import { SpanStatusCode } from '@opentelemetry/api';
import type { UnifiedObservabilityConfig } from '../types';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function integrationConfig(): UnifiedObservabilityConfig {
  return {
    serviceName: 'checkout-mobile',
    version: '4.2.0',
    environment: 'test',
    collector: {
      endpoint: 'https://collector.example.test',
      headers: { authorization: 'Bearer collector-secret' },
      timeoutMillis: 1_000,
    },
    sampling: {
      traceRatio: 1,
      logRatio: { debug: 1, info: 1, warn: 1, error: 1, fatal: 1 },
    },
    batch: {
      scheduledDelayMillis: 100,
      metricExportIntervalMillis: 10_000,
      exportTimeoutMillis: 1_000,
    },
    instrumentations: {
      console: false,
      network: false,
      errors: false,
      lifecycle: false,
    },
    strictInitialization: true,
  };
}

describe('ElvenObservabilitySdk OTLP integration', () => {
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;

  afterEach(() => {
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  it('exports correlated logs, traces, and metric exemplars with redaction', async () => {
    const requests: CapturedRequest[] = [];
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return {
        status: 202,
        headers: { get: () => null },
      } as unknown as Response;
    });
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock;
    const sdk = new ElvenObservabilitySdk();
    const diagnosticMessages: string[] = [];
    const configuration = integrationConfig();
    configuration.diagnostics = {
      enabled: true,
      verbose: true,
      sink: (message, context) =>
        diagnosticMessages.push(`${message} ${JSON.stringify(context ?? {})}`),
    };

    await sdk.initialize(configuration);
    const span = sdk.traces.startSpan('checkout.confirm', {
      attributes: { 'order.channel': 'mobile' },
    });
    const traceContext = span.traceContext();
    expect(traceContext).toBeDefined();
    expect(traceContext?.traceFlags).toBe(1);
    span.run(() => {
      sdk.logs.info('Checkout completed.', {
        'order.id': 'order-123',
        'authorization': 'Bearer application-secret',
      });
      sdk.metrics.histogram(
        'checkout.duration',
        0.42,
        { 'checkout.result': 'success' },
        { unit: 's' }
      );
    });
    span.end();

    const result = await sdk.flush(2_000);
    expect(result.pending).toBe(0);
    if (!requests.some((request) => request.url.endsWith('/v1/traces'))) {
      throw new Error(
        `Trace export missing: ${diagnosticMessages.join(' | ')}`
      );
    }
    expect(requests.map((request) => request.url)).toEqual(
      expect.arrayContaining([
        'https://collector.example.test/v1/logs',
        'https://collector.example.test/v1/metrics',
        'https://collector.example.test/v1/traces',
      ])
    );
    for (const request of requests) {
      expect(request.init.headers).toEqual(
        expect.objectContaining({
          'authorization': 'Bearer collector-secret',
          'content-type': 'application/json',
        })
      );
      expect(String(request.init.body)).not.toContain('collector-secret');
      expect(String(request.init.body)).not.toContain('application-secret');
    }

    const logs = requests
      .filter((request) => request.url.endsWith('/v1/logs'))
      .flatMap((request) => otlpLogs(parseBody(request)));
    const traces = requests
      .filter((request) => request.url.endsWith('/v1/traces'))
      .flatMap((request) => otlpSpans(parseBody(request)));
    const metrics = requests
      .filter((request) => request.url.endsWith('/v1/metrics'))
      .flatMap((request) => otlpMetrics(parseBody(request)));

    const checkoutLog = logs.find(
      (log) => nestedString(log.body) === 'Checkout completed.'
    );
    const checkoutSpan = traces.find((candidate) => {
      return candidate.name === 'checkout.confirm';
    });
    const checkoutMetric = metrics.find((candidate) => {
      return candidate.name === 'checkout.duration';
    });
    expect(checkoutLog).toEqual(
      expect.objectContaining({
        traceId: traceContext?.traceId,
        spanId: traceContext?.spanId,
      })
    );
    expect(checkoutSpan).toEqual(
      expect.objectContaining({
        traceId: traceContext?.traceId,
        spanId: traceContext?.spanId,
      })
    );
    expect(firstExemplar(checkoutMetric)).toEqual(
      expect.objectContaining({
        traceId: traceContext?.traceId,
        spanId: traceContext?.spanId,
      })
    );
    expect(JSON.stringify(checkoutLog)).toContain('[REDACTED]');
    await sdk.shutdown(2_000);
  });

  it('keeps the application running and queues telemetry when the backend fails', async () => {
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(async () => {
      throw new Error('collector unavailable');
    });
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock;
    const sdk = new ElvenObservabilitySdk();
    const configuration = integrationConfig();
    configuration.signals = { logs: true, metrics: false, traces: false };

    await expect(sdk.initialize(configuration)).resolves.toBe(sdk);
    expect(() =>
      sdk.logs.error('The user flow must continue.', { safe: true })
    ).not.toThrow();
    const result = await sdk.flush(1_000);

    expect(result.pending).toBeGreaterThan(0);
    expect(sdk.health()).toEqual(
      expect.objectContaining({
        state: 'started',
        transportFailures: expect.any(Number),
      })
    );
    await expect(sdk.shutdown(1_000)).resolves.toEqual(
      expect.objectContaining({ pending: expect.any(Number) })
    );
  });

  it('keeps every public API as a no-op before initialization', async () => {
    const sdk = new ElvenObservabilitySdk();
    expect(() => {
      sdk.logs.info('ignored');
      sdk.metrics.counter('ignored');
      sdk.captureException(new Error('ignored'));
      sdk.event('ignored');
      sdk.context.setUser({ id: 'ignored' });
    }).not.toThrow();
    expect(
      sdk.traces.withSpan('noop', (span) => span.run(() => 'result'))
    ).toBe('result');
    await expect(sdk.flush()).resolves.toEqual({
      delivered: 0,
      dropped: 0,
      pending: 0,
      timedOut: false,
    });
  });

  it('serializes shutdown with an initialization already in flight', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(async () => {
      return {
        status: 202,
        headers: { get: () => null },
      } as unknown as Response;
    }) as typeof fetch;
    const sdk = new ElvenObservabilitySdk();
    const internals = sdk as unknown as {
      start(config: UnifiedObservabilityConfig): Promise<void>;
    };
    const originalStart = internals.start.bind(sdk);
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    jest.spyOn(internals, 'start').mockImplementation(async (config) => {
      await startGate;
      await originalStart(config);
    });

    const initialization = sdk.initialize(integrationConfig());
    const firstShutdown = sdk.shutdown(1_000);
    const secondShutdown = sdk.shutdown(1_000);
    expect(firstShutdown).toBe(secondShutdown);
    releaseStart();

    await expect(initialization).resolves.toBe(sdk);
    await expect(firstShutdown).resolves.toEqual(
      expect.objectContaining({ pending: 0 })
    );
    expect(sdk.health().state).toBe('stopped');
  });

  it('supports the complete manual API and explicit async context patterns', async () => {
    const requests: CapturedRequest[] = [];
    const fetchMock = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return {
        status: 200,
        headers: { get: () => null },
      } as unknown as Response;
    });
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock;
    const sdk = new ElvenObservabilitySdk();
    const configuration = integrationConfig();
    await sdk.initialize(configuration);
    await expect(sdk.initialize(configuration)).resolves.toBe(sdk);

    sdk.context.setUser({ id: 'user-42', attributes: { role: 'buyer' } });
    sdk.context.setTenant({ id: 'tenant-42', attributes: { plan: 'pro' } });
    sdk.context.setSession('session-42', { source: 'test' });
    sdk.context.setBusinessContext({ 'cart.type': 'express' });
    sdk.logs.debug('debug');
    sdk.logs.info('info');
    sdk.logs.warn('warn');
    sdk.logs.error('error', undefined, { error: new Error('handled') });
    sdk.logs.fatal('fatal');
    sdk.logs.emit('info', 'generic emit');
    sdk.metrics.counter('cart.item.count', 1);
    sdk.metrics.upDownCounter('cart.active', -1);
    sdk.metrics.gauge('cart.value', 42.5);
    sdk.metrics.histogram('cart.latency', 0.25, undefined, { unit: 's' });

    const span = sdk.traces.startSpan('cart.checkout');
    const traceContext = span.traceContext();
    expect(traceContext).toBeDefined();
    span
      .setAttribute('cart.id', 'cart-42')
      .setAttributes({ 'payment.method': 'pix' })
      .addEvent('payment.authorized', { attempt: 1 })
      .recordException(new Error('recorded-only'))
      .setStatus({ code: SpanStatusCode.OK });
    const bound = span.bind(() => sdk.traces.currentTraceContext());
    expect(bound()).toEqual(traceContext);
    span.run(() => {
      expect(sdk.context.capture()).toEqual(traceContext);
      expect(sdk.context.inject()).toEqual(
        expect.objectContaining({ traceparent: expect.any(String) })
      );
    });
    span.end();

    expect(sdk.traces.withSpan('sync.operation', () => 'sync-result')).toBe(
      'sync-result'
    );
    await expect(
      sdk.traces.withSpan('async.operation', async () => 'async-result')
    ).resolves.toBe('async-result');
    await expect(
      sdk.traces.withSpan('async.failure', async () => {
        throw new Error('operation failed');
      })
    ).rejects.toThrow('operation failed');

    if (traceContext) {
      expect(
        sdk.traces.restore(traceContext, () => sdk.traces.currentTraceContext())
      ).toEqual(traceContext);
      const extracted = sdk.context.extract({
        traceparent: `00-${traceContext.traceId}-${traceContext.spanId}-01`,
      });
      expect(sdk.context.run(extracted, () => sdk.context.capture())).toEqual(
        traceContext
      );
      const boundContext = sdk.context.bind(extracted, () =>
        sdk.context.capture()
      );
      expect(boundContext()).toEqual(traceContext);
    }

    sdk.captureException(
      new Error('manual exception'),
      { safe: true },
      {
        handled: true,
        mechanism: 'test.manual',
      }
    );
    sdk.event('order.created', { 'order.kind': 'express' }, { level: 'info' });
    sdk.recordScreen('Checkout', { 'screen.variant': 'compact' });
    let currentRoute = { key: 'home-1', name: 'Home' };
    const navigation = sdk.createNavigationInstrumentation({
      getCurrentRoute: () => currentRoute,
    });
    navigation.onReady();
    currentRoute = { key: 'receipt-1', name: 'Receipt' };
    navigation.onStateChange();
    navigation.shutdown();
    sdk.context.setUser(null);
    sdk.context.setTenant(null);
    sdk.context.setSession(null);
    sdk.context.setBusinessContext(null);
    sdk.context.clear();

    expect(sdk.health().state).toBe('started');
    await expect(sdk.flush(2_000)).resolves.toEqual(
      expect.objectContaining({ pending: 0 })
    );
    expect(requests.length).toBeGreaterThan(0);
    await expect(sdk.shutdown(2_000)).resolves.toEqual(
      expect.objectContaining({ pending: 0 })
    );
    expect(sdk.health().state).toBe('stopped');
    await expect(sdk.shutdown()).resolves.toEqual({
      delivered: 0,
      dropped: 0,
      pending: 0,
      timedOut: false,
    });
  });

  it('reports invalid configuration without leaving a partial runtime', async () => {
    const strict = new ElvenObservabilitySdk();
    await expect(
      strict.initialize({
        ...integrationConfig(),
        serviceName: '',
        strictInitialization: true,
      })
    ).rejects.toThrow(/serviceName/);
    expect(strict.health().state).toBe('stopped');

    const diagnostics: string[] = [];
    const failOpen = new ElvenObservabilitySdk();
    await expect(
      failOpen.initialize({
        ...integrationConfig(),
        serviceName: '',
        strictInitialization: false,
        diagnostics: {
          enabled: true,
          sink: (message) => diagnostics.push(message),
        },
      })
    ).resolves.toBe(failOpen);
    expect(failOpen.health().state).toBe('stopped');
    expect(diagnostics.join(' ')).toContain('SDK initialization failed');
  });
});

function parseBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

function otlpLogs(
  root: Record<string, unknown>
): Array<Record<string, unknown>> {
  return nestedRecords(root, 'resourceLogs', 'scopeLogs', 'logRecords');
}

function otlpSpans(
  root: Record<string, unknown>
): Array<Record<string, unknown>> {
  return nestedRecords(root, 'resourceSpans', 'scopeSpans', 'spans');
}

function otlpMetrics(
  root: Record<string, unknown>
): Array<Record<string, unknown>> {
  return nestedRecords(root, 'resourceMetrics', 'scopeMetrics', 'metrics');
}

function nestedRecords(
  root: Record<string, unknown>,
  first: string,
  second: string,
  third: string
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const levelOne of array(root[first])) {
    if (!record(levelOne)) continue;
    for (const levelTwo of array(levelOne[second])) {
      if (!record(levelTwo)) continue;
      for (const value of array(levelTwo[third])) {
        if (record(value)) output.push(value);
      }
    }
  }
  return output;
}

function firstExemplar(
  metric: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metric) return undefined;
  for (const field of ['sum', 'gauge', 'histogram', 'exponentialHistogram']) {
    const data = metric[field];
    if (!record(data)) continue;
    const point = array(data.dataPoints)[0];
    if (!record(point)) continue;
    const exemplar = array(point.exemplars)[0];
    if (record(exemplar)) return exemplar;
  }
  return undefined;
}

function nestedString(value: unknown): string | undefined {
  return record(value) && typeof value.stringValue === 'string'
    ? value.stringValue
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
