import { ROOT_CONTEXT, SpanStatusCode, type Context } from '@opentelemetry/api';
import { Diagnostics } from './core/diagnostics';
import { resolveConfig, validateConfiguration } from './core/config';
import type { TelemetryProviders } from './core/providers';
import { createTelemetryProviders } from './core/providers';
import { Sanitizer } from './core/sanitizer';
import { NativeBridge } from './native/bridge';
import { NativeQueueStore } from './transport/storage';
import { DurableTransport } from './transport/durableTransport';
import type {
  AttributeInputs,
  BusinessEventOptions,
  CaptureExceptionOptions,
  FlushResult,
  LoggingApi,
  LogLevel,
  LogOptions,
  MetricOptions,
  MetricsApi,
  NavigationInstrumentation,
  NavigationInstrumentationOptions,
  NavigationRefLike,
  SdkHealth,
  SpanHandle,
  SpanOptions,
  SpanStatus,
  TelemetryContextApi,
  TenantContextInput,
  TraceCarrier,
  TraceContext,
  TracingApi,
  UnifiedObservabilityConfig,
  UserContextInput,
} from './types';
import type { TransportFetch } from './transport/types';
import { AutomaticInstrumentationController } from './instrumentation/controller';
import type { CapturedErrorDetails } from './instrumentation/errors';
import { ReactNavigationInstrumentation } from './instrumentation/navigation';
import { ensurePerformanceTimeOrigin } from './core/runtimeCompatibility';
import { redactTextContent } from './core/redaction';

interface Runtime {
  config: ReturnType<typeof resolveConfig>;
  diagnostics: Diagnostics;
  sanitizer: Sanitizer;
  bridge: NativeBridge;
  providers: TelemetryProviders;
  transport: DurableTransport;
  automatic: AutomaticInstrumentationController;
  eventNames: Set<string>;
}

export class ElvenObservabilitySdk {
  readonly logs: LoggingApi;
  readonly metrics: MetricsApi;
  readonly traces: TracingApi;
  readonly context: TelemetryContextApi;

  private state: SdkHealth['state'] = 'idle';
  private runtime: Runtime | undefined;
  private initialization: Promise<ElvenObservabilitySdk> | undefined;
  private shutdownOperation: Promise<FlushResult> | undefined;

  constructor() {
    const getRuntime = () => this.runtime;
    this.logs = new LoggingDispatcher(getRuntime);
    this.metrics = new MetricsDispatcher(getRuntime);
    this.traces = new TracingDispatcher(getRuntime);
    this.context = new ContextDispatcher(getRuntime);
  }

  initialize(
    configuration: UnifiedObservabilityConfig
  ): Promise<ElvenObservabilitySdk> {
    if (this.state === 'started') return Promise.resolve(this);
    if (this.shutdownOperation) {
      return this.shutdownOperation.then(() => this.initialize(configuration));
    }
    if (this.initialization) return this.initialization;
    this.state = 'starting';
    this.initialization = this.start(configuration)
      .then(() => this)
      .catch(async (error: unknown) => {
        await this.cleanupFailedInitialization();
        this.state = 'stopped';
        reportInitializationFailure(error, configuration);
        if (configuration.strictInitialization) throw error;
        return this;
      })
      .finally(() => {
        this.initialization = undefined;
      });
    return this.initialization;
  }

  captureException(
    error: unknown,
    attributes?: AttributeInputs,
    options: CaptureExceptionOptions = {}
  ): void {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      const exception = runtime.sanitizer.exception(error);
      const mechanism = runtime.sanitizer.eventName(
        options.mechanism ?? 'manual'
      );
      const handled = options.handled ?? true;
      const span = runtime.providers.tracer.startSpan('exception', {
        ...(options.context ? { parent: options.context } : {}),
        attributes: {
          ...attributes,
          ...exception,
          'exception.handled': handled,
          'exception.mechanism': mechanism,
        },
      });
      span.recordException(error).setStatus({
        code: SpanStatusCode.ERROR,
        message: String(exception['exception.message'] ?? 'Unknown error'),
      });
      runtime.providers.logger.emit(
        options.fatal ? 'fatal' : 'error',
        exception['exception.message'] ?? 'An exception was captured.',
        {
          ...attributes,
          ...exception,
          'exception.handled': handled,
          'exception.mechanism': mechanism,
        },
        { context: span.context, eventName: 'exception' }
      );
      runtime.providers.metrics.counter(
        'app.exception.count',
        1,
        {
          'exception.type': String(exception['exception.type'] ?? 'unknown'),
          'exception.handled': handled,
          'exception.mechanism': mechanism,
        },
        { context: span.context }
      );
      span.end();
    } catch {
      // Capturing an application exception must never create another one.
    }
  }

  event(
    name: string,
    attributes?: AttributeInputs,
    options: BusinessEventOptions = {}
  ): void {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      const eventName = runtime.sanitizer.eventName(name);
      const metricEventName = boundedEventName(runtime, eventName);
      const span = runtime.providers.tracer.startSpan(`event ${eventName}`, {
        ...(options.context ? { parent: options.context } : {}),
        attributes: { 'event.name': eventName, ...attributes },
      });
      span
        .addEvent(eventName, attributes)
        .setStatus({ code: SpanStatusCode.OK });
      runtime.providers.logger.emit(
        options.level ?? 'info',
        eventName,
        { 'event.name': eventName, ...attributes },
        { context: span.context, eventName }
      );
      runtime.providers.metrics.counter(
        'app.business.event.count',
        1,
        { 'event.name': metricEventName },
        { context: span.context }
      );
      span.end();
    } catch {
      // Business events are supplemental and always fail open.
    }
  }

  recordScreen(name: string, attributes?: AttributeInputs): void {
    const runtime = this.runtime;
    if (!runtime) return;
    runtime.providers.context.setNavigationContext({
      'app.screen.name': name,
      ...attributes,
    });
    this.event('app.screen.view', {
      'app.screen.name': name,
      ...attributes,
    });
  }

  createNavigationInstrumentation(
    navigationRef: NavigationRefLike,
    options: NavigationInstrumentationOptions = {}
  ): NavigationInstrumentation {
    let delegate: ReactNavigationInstrumentation | undefined;
    const ensure = (): ReactNavigationInstrumentation | undefined => {
      if (delegate) return delegate;
      const runtime = this.runtime;
      if (!runtime) return undefined;
      delegate = new ReactNavigationInstrumentation(
        navigationRef,
        options,
        runtime.providers.tracer,
        runtime.providers.logger,
        runtime.providers.metrics,
        runtime.providers.context
      );
      return delegate;
    };
    return {
      onReady: () => ensure()?.onReady(),
      onStateChange: () => ensure()?.onStateChange(),
      shutdown: () => delegate?.shutdown(),
    };
  }

  async flush(timeoutMillis?: number): Promise<FlushResult> {
    const runtime = this.runtime;
    if (!runtime) return emptyFlushResult();
    try {
      await runtime.providers.forceFlush();
      return await runtime.transport.flush(
        true,
        timeoutMillis ?? runtime.config.batch.exportTimeoutMillis
      );
    } catch (error) {
      runtime.diagnostics.debug('Manual telemetry flush failed.', {
        error: error instanceof Error ? error.message : String(error),
      });
      const health = runtime.transport.health();
      return {
        delivered: 0,
        dropped: 0,
        pending: health.queueItems,
        timedOut: true,
      };
    }
  }

  shutdown(timeoutMillis?: number): Promise<FlushResult> {
    if (this.shutdownOperation) return this.shutdownOperation;
    this.shutdownOperation = this.stop(timeoutMillis).finally(() => {
      this.shutdownOperation = undefined;
    });
    return this.shutdownOperation;
  }

  private async stop(timeoutMillis?: number): Promise<FlushResult> {
    if (this.initialization) {
      this.state = 'stopping';
      await this.initialization.catch(() => undefined);
    }
    const runtime = this.runtime;
    if (!runtime) {
      this.state = 'stopped';
      return emptyFlushResult();
    }
    this.state = 'stopping';
    const timeout = timeoutMillis ?? runtime.config.batch.exportTimeoutMillis;
    let result = emptyFlushResult();
    try {
      runtime.providers.logger.info(
        'Elven observability SDK is shutting down.',
        {
          'sdk.state': 'stopping',
        }
      );
      await runtime.automatic.shutdown();
      await runtime.providers.forceFlush();
      await runtime.providers.shutdown();
      result = await runtime.transport.shutdown(timeout);
      await runtime.bridge.shutdown();
    } catch (error) {
      runtime.diagnostics.debug('Telemetry shutdown completed with errors.', {
        error: error instanceof Error ? error.message : String(error),
      });
      const health = runtime.transport.health();
      result = {
        delivered: 0,
        dropped: 0,
        pending: health.queueItems,
        timedOut: true,
      };
    } finally {
      this.runtime = undefined;
      this.state = 'stopped';
    }
    return result;
  }

  health(): SdkHealth {
    const runtime = this.runtime;
    if (!runtime) {
      return {
        state: this.state,
        nativeBridgeAvailable: false,
        queueItems: 0,
        queueBytes: 0,
        droppedItems: 0,
        transportFailures: 0,
        circuitOpen: false,
      };
    }
    return {
      state: this.state,
      nativeBridgeAvailable: runtime.bridge.available,
      ...runtime.transport.health(),
    };
  }

  private async start(
    configuration: UnifiedObservabilityConfig
  ): Promise<void> {
    const startedAt = Date.now();
    const config = resolveConfig(configuration);
    const diagnostics = new Diagnostics(config.diagnostics);
    if (!ensurePerformanceTimeOrigin()) {
      diagnostics.warn(
        'A valid performance clock is unavailable; span timestamps may use reduced precision.'
      );
    }
    for (const issue of validateConfiguration(configuration)) {
      if (issue.level === 'warning') {
        diagnostics.warn(`${issue.path}: ${issue.message}`);
      }
    }
    const sanitizer = new Sanitizer(config.privacy);
    const bridge = new NativeBridge(diagnostics);
    bridge.setDiagnosticsEnabled(config.diagnostics.enabled);
    const platform = await bridge.initialize(config);
    const store = new NativeQueueStore(
      bridge,
      config.queue.enabled,
      diagnostics
    );
    const originalFetch = (globalThis as unknown as { fetch?: typeof fetch })
      .fetch;
    const transport = new DurableTransport(
      config,
      store,
      diagnostics,
      adaptFetch(originalFetch)
    );
    const providers = createTelemetryProviders(
      config,
      platform,
      transport,
      bridge,
      sanitizer,
      diagnostics
    );
    const automatic = new AutomaticInstrumentationController(
      config,
      platform,
      providers,
      bridge,
      sanitizer,
      diagnostics,
      originalFetch,
      (error, details) => this.captureAutomaticError(error, details),
      () => this.flush()
    );
    this.runtime = {
      config,
      diagnostics,
      sanitizer,
      bridge,
      providers,
      transport,
      automatic,
      eventNames: new Set(),
    };
    automatic.start();
    this.state = 'started';
    providers.logger.info('Elven observability SDK initialized.', {
      'sdk.state': 'started',
      'sdk.native_bridge.available': bridge.available,
    });
    providers.metrics.histogram(
      'otel.sdk.initialization.duration',
      (Date.now() - startedAt) / 1_000,
      undefined,
      { unit: 's' }
    );
  }

  private captureAutomaticError(
    error: unknown,
    details: CapturedErrorDetails
  ): void {
    this.captureException(
      error,
      {
        'error.source': details.source,
        'error.unhandled': details.unhandled,
      },
      {
        handled: false,
        fatal: details.fatal,
        mechanism: details.source,
      }
    );
    if (details.fatal) this.flush().catch(() => undefined);
  }

  private async cleanupFailedInitialization(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      await runtime.automatic.shutdown();
      await runtime.providers.shutdown();
      await runtime.transport.shutdown(
        runtime.config.batch.exportTimeoutMillis
      );
      await runtime.bridge.shutdown();
    } catch {
      // Initialization cleanup is best effort.
    } finally {
      this.runtime = undefined;
    }
  }
}

class LoggingDispatcher implements LoggingApi {
  constructor(private readonly runtime: () => Runtime | undefined) {}

  debug(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.runtime()?.providers.logger.debug(message, attributes, options);
  }
  info(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.runtime()?.providers.logger.info(message, attributes, options);
  }
  warn(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.runtime()?.providers.logger.warn(message, attributes, options);
  }
  error(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.runtime()?.providers.logger.error(message, attributes, options);
  }
  fatal(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.runtime()?.providers.logger.fatal(message, attributes, options);
  }
  emit(
    level: LogLevel,
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void {
    this.runtime()?.providers.logger.emit(level, message, attributes, options);
  }
}

class MetricsDispatcher implements MetricsApi {
  constructor(private readonly runtime: () => Runtime | undefined) {}

  counter(
    name: string,
    value = 1,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void {
    this.runtime()?.providers.metrics.counter(name, value, attributes, options);
  }
  upDownCounter(
    name: string,
    value: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void {
    this.runtime()?.providers.metrics.upDownCounter(
      name,
      value,
      attributes,
      options
    );
  }
  gauge(
    name: string,
    value: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void {
    this.runtime()?.providers.metrics.gauge(name, value, attributes, options);
  }
  histogram(
    name: string,
    value: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void {
    this.runtime()?.providers.metrics.histogram(
      name,
      value,
      attributes,
      options
    );
  }
}

class TracingDispatcher implements TracingApi {
  constructor(private readonly runtime: () => Runtime | undefined) {}

  startSpan(name: string, options?: SpanOptions): SpanHandle {
    return (
      this.runtime()?.providers.tracer.startSpan(name, options) ??
      new NoopSpan()
    );
  }
  withSpan<T>(
    name: string,
    operation: (span: SpanHandle) => T,
    options?: SpanOptions
  ): T {
    const tracer = this.runtime()?.providers.tracer;
    return tracer
      ? tracer.withSpan(name, operation, options)
      : operation(new NoopSpan());
  }
  currentTraceContext(): TraceContext | undefined {
    return this.runtime()?.providers.tracer.currentTraceContext();
  }
  restore<T>(traceContext: TraceContext, operation: () => T): T {
    return (
      this.runtime()?.providers.tracer.restore(traceContext, operation) ??
      operation()
    );
  }
}

class ContextDispatcher implements TelemetryContextApi {
  constructor(private readonly runtime: () => Runtime | undefined) {}

  capture(): TraceContext | undefined {
    return this.runtime()?.providers.context.capture();
  }
  run<T>(target: Context | TraceContext | undefined, operation: () => T): T {
    return (
      this.runtime()?.providers.context.run(target, operation) ?? operation()
    );
  }
  bind<T>(target: Context | TraceContext | undefined, value: T): T {
    return this.runtime()?.providers.context.bind(target, value) ?? value;
  }
  inject(
    carrier: TraceCarrier = {},
    source?: Context | TraceContext
  ): TraceCarrier {
    return (
      this.runtime()?.providers.context.inject(carrier, source) ?? {
        ...carrier,
      }
    );
  }
  extract(
    carrier: Readonly<Record<string, string | ReadonlyArray<string>>>
  ): Context {
    return this.runtime()?.providers.context.extract(carrier) ?? ROOT_CONTEXT;
  }
  setUser(value: UserContextInput | null): void {
    this.runtime()?.providers.context.setUser(value);
  }
  setTenant(value: TenantContextInput | null): void {
    this.runtime()?.providers.context.setTenant(value);
  }
  setSession(id: string | null, attributes?: AttributeInputs): void {
    this.runtime()?.providers.context.setSession(id, attributes);
  }
  setBusinessContext(attributes: AttributeInputs | null): void {
    this.runtime()?.providers.context.setBusinessContext(attributes);
  }
  clear(): void {
    this.runtime()?.providers.context.clear();
  }
}

class NoopSpan implements SpanHandle {
  readonly context = ROOT_CONTEXT;

  traceContext(): undefined {
    return undefined;
  }
  setAttribute(_key: string, _value: unknown): this {
    return this;
  }
  setAttributes(_values: AttributeInputs): this {
    return this;
  }
  addEvent(
    _name: string,
    _attributes?: AttributeInputs,
    _timestampUnixMillis?: number
  ): this {
    return this;
  }
  recordException(_error: unknown): this {
    return this;
  }
  setStatus(_status: SpanStatus): this {
    return this;
  }
  run<T>(operation: () => T): T {
    return operation();
  }
  bind<T>(value: T): T {
    return value;
  }
  end(_endTimeUnixMillis?: number): void {}
}

function adaptFetch(
  value: typeof fetch | undefined
): TransportFetch | undefined {
  if (!value) return undefined;
  return async (endpoint, init) => {
    const requestInit: RequestInit = {
      method: init.method,
      headers: { ...init.headers },
      body: init.body,
      ...(init.signal ? { signal: init.signal as AbortSignal } : {}),
    };
    return Reflect.apply(value, globalThis, [
      endpoint,
      requestInit,
    ]) as Promise<Response>;
  };
}

function boundedEventName(runtime: Runtime, value: string): string {
  if (runtime.eventNames.has(value)) return value;
  if (runtime.eventNames.size >= runtime.config.privacy.maxMetricCardinality) {
    return 'other';
  }
  runtime.eventNames.add(value);
  return value;
}

function emptyFlushResult(): FlushResult {
  return { delivered: 0, dropped: 0, pending: 0, timedOut: false };
}

function reportInitializationFailure(
  error: unknown,
  configuration: UnifiedObservabilityConfig
): void {
  const diagnostics =
    typeof configuration.diagnostics === 'object'
      ? configuration.diagnostics
      : { enabled: configuration.diagnostics === true };
  if (!diagnostics.enabled) return;
  try {
    const message = redactTextContent(
      error instanceof Error ? error.message : String(error)
    );
    if (diagnostics.sink) {
      diagnostics.sink(`[error] SDK initialization failed: ${message}`);
    } else {
      console.error(
        `[elven-observability] SDK initialization failed: ${message}`
      );
    }
  } catch {
    // Bootstrap diagnostics are fail-open.
  }
}

export const ElvenObservability = new ElvenObservabilitySdk();
