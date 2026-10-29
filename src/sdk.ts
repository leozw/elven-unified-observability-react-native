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
import {
  acquireOwner,
  releaseOwner,
  LifecycleDeadline,
  activeOwner,
  globalConsentGranted,
  setGlobalConsent,
} from './core/lifecycle';

interface Runtime {
  config: ReturnType<typeof resolveConfig>;
  diagnostics: Diagnostics;
  sanitizer: Sanitizer;
  bridge: NativeBridge;
  providers: TelemetryProviders;
  transport: DurableTransport;
  automatic: AutomaticInstrumentationController;
  eventNames: Set<string>;
  navigation: Set<ReactNavigationInstrumentation>;
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
  private generation = 0;
  private lease: object | undefined;
  private startingBridge: NativeBridge | undefined;
  private lastConfiguration: UnifiedObservabilityConfig | undefined;
  private consentGranted = true;
  private disabledReason: string | undefined;
  private configurationEpoch = 0;
  private startWork: Promise<void> | undefined;
  private stoppingRuntime: Runtime | undefined;
  private closingResources:
    | { bridge?: NativeBridge; purge: boolean; work: Promise<boolean> }
    | undefined;

  constructor() {
    const getRuntime = () => this.runtime;
    this.logs = new LoggingDispatcher(getRuntime);
    this.metrics = new MetricsDispatcher(getRuntime);
    this.traces = new TracingDispatcher(getRuntime);
    this.context = new ContextDispatcher(getRuntime, (identity) => {
      this.setIdentity({
        ...this.lastConfiguration?.identity,
        ...identity,
      }).catch(() => undefined);
    });
  }

  initialize(
    configuration: UnifiedObservabilityConfig
  ): Promise<ElvenObservabilitySdk> {
    return this.initializeWithin(
      configuration,
      this.lifecycleBudget(configuration.lifecycleTimeoutMillis)
    );
  }

  private lifecycleBudget(timeoutMillis = 5_000): LifecycleDeadline {
    return new LifecycleDeadline(timeoutMillis, () =>
      this.fence(true, this.runtime ?? this.stoppingRuntime)
    );
  }

  private initializeWithin(
    configuration: UnifiedObservabilityConfig,
    deadline: LifecycleDeadline
  ): Promise<ElvenObservabilitySdk> {
    if (configuration.consent === 'denied') {
      this.lastConfiguration = configuration;
      return this.setConsent(false, deadline.remaining()).then(() => this);
    }
    if (this.state === 'started') return Promise.resolve(this);
    if (this.shutdownOperation) {
      return deadline
        .wait(this.shutdownOperation)
        .then(() => this.initializeWithin(configuration, deadline))
        .catch((error: unknown) => {
          reportInitializationFailure(error, configuration);
          if (configuration.strictInitialization) throw error;
          return this;
        });
    }
    if (this.initialization) return this.initialization;
    this.lastConfiguration = configuration;
    if (configuration.consent === 'granted') setGlobalConsent(true);
    this.consentGranted = globalConsentGranted();
    if (!this.consentGranted) {
      this.state = 'stopped';
      this.disabledReason = 'consent-denied';
      return Promise.resolve(this);
    }
    const lease = {
      revoke: (timeout?: number) => {
        this.consentGranted = false;
        ++this.configurationEpoch;
        if (this.lastConfiguration)
          this.lastConfiguration = {
            ...this.lastConfiguration,
            consent: 'denied',
          };
        return this.shutdown(timeout, { flush: false, purge: true });
      },
    };
    if (!acquireOwner(lease)) {
      this.state = 'stopped';
      this.disabledReason = 'another-owner-or-native-cleanup-pending';
      new Diagnostics({
        enabled: true,
        verbose: false,
        ...(typeof configuration.diagnostics === 'object' &&
        configuration.diagnostics.sink
          ? { sink: configuration.diagnostics.sink }
          : {}),
      }).warn(
        'Another mobile telemetry owner is active or cleaning up; this instance is disabled.'
      );
      if (configuration.strictInitialization)
        return Promise.reject(new Error(this.disabledReason));
      return Promise.resolve(this);
    }
    this.lease = lease;
    this.closingResources = undefined;
    this.disabledReason = undefined;
    const generation = ++this.generation;
    this.state = 'starting';
    const starting = this.start(configuration, generation);
    this.startWork = starting;
    this.initialization = deadline
      .wait(starting)
      .then(() => this)
      .catch((error: unknown) => {
        // fence retains the lease unless actual native/provider cleanup succeeds.
        this.fence(true);
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
          ...runtime.sanitizer.attributes(attributes),
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
          ...runtime.sanitizer.attributes(attributes),
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
        attributes: {
          'event.name': eventName,
          ...runtime.sanitizer.attributes(attributes),
        },
      });
      span
        .addEvent(eventName, attributes)
        .setStatus({ code: SpanStatusCode.OK });
      runtime.providers.logger.emit(
        options.level ?? 'info',
        eventName,
        {
          'event.name': eventName,
          ...runtime.sanitizer.attributes(attributes),
        },
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
      ...runtime.sanitizer.attributes(attributes),
    });
    this.event('app.screen.view', {
      'app.screen.name': name,
      ...runtime.sanitizer.attributes(attributes),
    });
  }

  createNavigationInstrumentation(
    navigationRef: NavigationRefLike,
    options: NavigationInstrumentationOptions = {}
  ): NavigationInstrumentation {
    let delegate: ReactNavigationInstrumentation | undefined;
    let delegateRuntime: Runtime | undefined;
    let stopped = false;
    const ensure = (): ReactNavigationInstrumentation | undefined => {
      const runtime = this.runtime;
      if (!runtime || stopped) return undefined;
      if (delegateRuntime === runtime) return delegate;
      delegate?.shutdown();
      if (runtime.navigation.size >= 16) return undefined;
      delegate = new ReactNavigationInstrumentation(
        navigationRef,
        options,
        runtime.providers.tracer,
        runtime.providers.logger,
        runtime.providers.metrics,
        runtime.providers.context
      );
      runtime.navigation.add(delegate);
      delegateRuntime = runtime;
      return delegate;
    };
    return {
      onReady: () => {
        try {
          ensure()?.onReady();
        } catch {
          /* Navigation telemetry fails open. */
        }
      },
      onStateChange: () => {
        try {
          ensure()?.onStateChange();
        } catch {
          /* Navigation telemetry fails open. */
        }
      },
      shutdown: () => {
        stopped = true;
        if (delegate) delegateRuntime?.navigation.delete(delegate);
        delegate?.shutdown();
        delegate = undefined;
        delegateRuntime = undefined;
      },
    };
  }

  async flush(timeoutMillis?: number): Promise<FlushResult> {
    const runtime = this.runtime;
    if (!runtime) return emptyFlushResult();
    const generation = this.generation;
    const budget = new LifecycleDeadline(
      timeoutMillis ?? runtime.config.lifecycleTimeoutMillis,
      () => this.fence(false)
    );
    try {
      await budget.wait(runtime.providers.forceFlush());
      if (generation !== this.generation) return emptyFlushResult();
      return await budget.wait(
        runtime.transport.flush(true, budget.remaining())
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

  shutdown(
    timeoutMillis?: number,
    options: { flush?: boolean; purge?: boolean } = {}
  ): Promise<FlushResult> {
    if (this.shutdownOperation) {
      if (options.purge || options.flush === false) {
        const budget = new LifecycleDeadline(timeoutMillis ?? 5_000, () =>
          this.fence(options.purge ?? false, this.stoppingRuntime)
        );
        return budget
          .wait(this.fence(options.purge ?? false, this.stoppingRuntime))
          .then((closed) => ({
            ...emptyFlushResult(),
            ...(options.purge ? { purged: closed } : {}),
          }))
          .catch(() => ({
            ...emptyFlushResult(),
            timedOut: true,
            ...(options.purge ? { purged: false } : {}),
          }));
      }
      return this.shutdownOperation;
    }
    this.shutdownOperation = this.stop(timeoutMillis, options).finally(() => {
      this.shutdownOperation = undefined;
    });
    return this.shutdownOperation;
  }

  private async stop(
    timeoutMillis?: number,
    options: { flush?: boolean; purge?: boolean } = {}
  ): Promise<FlushResult> {
    const runtime = this.runtime;
    this.stoppingRuntime = runtime;
    this.state = 'stopping';
    // Public dispatch and automatic collection stop synchronously, before any wait.
    this.runtime = undefined;
    ++this.generation;
    runtime?.automatic.shutdown();
    const timeout =
      timeoutMillis ??
      runtime?.config.lifecycleTimeoutMillis ??
      this.lastConfiguration?.lifecycleTimeoutMillis ??
      5_000;
    const budget = new LifecycleDeadline(timeout, () =>
      this.fence(options.purge ?? false, runtime)
    );
    let result = emptyFlushResult();
    try {
      if (
        runtime &&
        options.flush !== false &&
        !options.purge &&
        this.consentGranted
      ) {
        await budget.wait(runtime.providers.forceFlush());
        result = await budget.wait(
          runtime.transport.flush(true, budget.remaining())
        );
      }
      const closed = await budget.wait(
        this.fence(options.purge ?? false, runtime)
      );
      if (options.purge) result.purged = closed;
    } catch (error) {
      runtime?.diagnostics.debug('Telemetry shutdown completed with errors.', {
        error: error instanceof Error ? error.message : String(error),
      });
      const health = runtime?.transport.health();
      result = {
        delivered: 0,
        dropped: 0,
        pending: health?.queueItems ?? 0,
        timedOut: true,
        ...(options.purge ? { purged: false } : {}),
      };
    } finally {
      this.runtime = undefined;
      this.state = 'stopped';
    }
    return result;
  }

  setConsent(granted: boolean, timeoutMillis?: number): Promise<FlushResult> {
    this.consentGranted = granted;
    setGlobalConsent(granted);
    if (!granted) {
      ++this.configurationEpoch;
      if (this.lastConfiguration)
        this.lastConfiguration = {
          ...this.lastConfiguration,
          consent: 'denied',
        };
      this.disabledReason = 'consent-denied';
      const owner = activeOwner() as
        { revoke?: (timeout?: number) => Promise<FlushResult> } | undefined;
      if (owner && owner !== this.lease && owner.revoke)
        return owner.revoke(timeoutMillis);
      if (!owner) {
        const lease = {
          revoke: (timeout?: number) =>
            this.shutdown(timeout, { flush: false, purge: true }),
        };
        if (acquireOwner(lease)) {
          this.lease = lease;
          this.closingResources = undefined;
          this.startingBridge = new NativeBridge(
            new Diagnostics({ enabled: false, verbose: false })
          );
        }
      }
      if (!this.startingBridge)
        this.startingBridge = new NativeBridge(
          new Diagnostics({ enabled: false, verbose: false })
        );
      return this.shutdown(timeoutMillis, { flush: false, purge: true });
    }
    return this.lastConfiguration
      ? this.initializeWithin(
          { ...this.lastConfiguration, consent: 'granted' },
          this.lifecycleBudget(
            timeoutMillis ?? this.lastConfiguration.lifecycleTimeoutMillis
          )
        ).then(() => emptyFlushResult())
      : Promise.resolve(emptyFlushResult());
  }

  async setIdentity(
    identity: NonNullable<UnifiedObservabilityConfig['identity']>,
    timeoutMillis?: number
  ): Promise<void> {
    if (!this.lastConfiguration) return;
    await this.reconfigure(
      { ...this.lastConfiguration, identity },
      timeoutMillis
    );
  }

  async reconfigure(
    configuration: UnifiedObservabilityConfig,
    timeoutMillis?: number
  ): Promise<void> {
    const epoch = ++this.configurationEpoch;
    this.lastConfiguration = configuration;
    const budget = this.lifecycleBudget(
      timeoutMillis ?? configuration.lifecycleTimeoutMillis
    );
    try {
      const closed = await budget.wait(
        this.shutdown(budget.remaining(), { flush: false, purge: true })
      );
      if (
        closed.purged === true &&
        epoch === this.configurationEpoch &&
        this.consentGranted
      )
        await this.initializeWithin(configuration, budget);
    } catch (error) {
      reportInitializationFailure(error, configuration);
      if (configuration.strictInitialization) throw error;
    }
  }

  private fence(purge: boolean, runtime = this.runtime): Promise<boolean> {
    if (this.runtime === runtime) this.runtime = undefined;
    const bridge = runtime?.bridge ?? this.startingBridge;
    const lease = this.lease;
    ++this.generation;
    this.state = 'stopped';
    runtime?.transport.stop(purge);
    runtime?.automatic.shutdown();
    runtime?.providers.close();
    if (runtime) {
      for (const navigation of runtime.navigation) {
        try {
          navigation.shutdown();
        } catch {
          /* Continue closing. */
        }
      }
      runtime.navigation.clear();
    }
    if (this.closingResources && this.closingResources.bridge === bridge) {
      this.closingResources.purge ||= purge;
      if (purge) bridge?.close(true);
      return this.closingResources.work;
    }
    const closing = { bridge, purge, work: Promise.resolve(false) };
    this.closingResources = closing;
    const nativeClose = bridge?.close(purge) ?? Promise.resolve(true);
    closing.work = (async () => {
      const providerClose = runtime?.providers.shutdown();
      // Wait for real initialization too: a timeout must not release a late initializer.
      await Promise.allSettled([this.startWork]);
      const closed = await nativeClose;
      if (providerClose) await providerClose;
      const purged = !closing.purge || (await bridge?.close(true)) !== false;
      if (closed && purged && lease) releaseOwner(lease);
      return closed && purged;
    })().catch(() => false);
    return closing.work;
  }

  health(): SdkHealth {
    const runtime = this.runtime;
    if (!runtime) {
      return {
        state: this.state,
        ...(this.disabledReason ? { disabledReason: this.disabledReason } : {}),
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
    configuration: UnifiedObservabilityConfig,
    generation: number
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
    this.startingBridge = bridge;
    bridge.setDiagnosticsEnabled(config.diagnostics.enabled);
    const platform = await bridge.initialize(config);
    if (generation !== this.generation || !this.consentGranted) {
      await bridge.close(true);
      return;
    }
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
      adaptFetch(originalFetch),
      Date.now,
      Math.random,
      bridge.sessionId
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
      navigation: new Set(),
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
    const runtime = this.runtime();
    return runtime
      ? runtime.providers.tracer.restore(traceContext, operation)
      : operation();
  }
}

class ContextDispatcher implements TelemetryContextApi {
  constructor(
    private readonly runtime: () => Runtime | undefined,
    private readonly identityChange: (
      identity: NonNullable<UnifiedObservabilityConfig['identity']>
    ) => void
  ) {}

  capture(): TraceContext | undefined {
    return this.runtime()?.providers.context.capture();
  }
  run<T>(target: Context | TraceContext | undefined, operation: () => T): T {
    const runtime = this.runtime();
    return runtime
      ? runtime.providers.context.run(target, operation)
      : operation();
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
    this.identityChange({ user: value });
  }
  setTenant(value: TenantContextInput | null): void {
    this.identityChange({ tenant: value });
  }
  setSession(id: string | null, attributes?: AttributeInputs): void {
    this.runtime()?.providers.context.setSession(id, attributes);
  }
  setBusinessContext(attributes: AttributeInputs | null): void {
    this.runtime()?.providers.context.setBusinessContext(attributes);
  }
  clear(): void {
    this.identityChange({ user: null, tenant: null });
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
