import type {
  Attributes,
  Context,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';

export type AttributePrimitive = string | number | boolean;
export type AttributeInput =
  AttributePrimitive | ReadonlyArray<AttributePrimitive> | null | undefined;
export type AttributeInputs = Readonly<Record<string, unknown>>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type SignalType = 'logs' | 'metrics' | 'traces';
export type UrlMatcher = string | RegExp;

export interface CollectorConfig {
  /** OTLP/HTTP base URL. Signal paths are appended automatically. */
  endpoint: string;
  logsEndpoint?: string;
  metricsEndpoint?: string;
  tracesEndpoint?: string;
  /** Headers remain in memory and are never persisted or emitted. */
  headers?: Readonly<Record<string, string>>;
  timeoutMillis?: number;
}

export interface SignalConfig {
  logs?: boolean;
  metrics?: boolean;
  traces?: boolean;
}

export interface BatchConfig {
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduledDelayMillis?: number;
  exportTimeoutMillis?: number;
  metricExportIntervalMillis?: number;
}

export interface DurableQueueConfig {
  enabled?: boolean;
  maxItems?: number;
  maxBytes?: number;
  maxItemBytes?: number;
  maxAgeMillis?: number;
}

export interface RetryConfig {
  initialDelayMillis?: number;
  maxDelayMillis?: number;
  maxAttempts?: number;
  jitterRatio?: number;
  circuitBreakerFailureThreshold?: number;
  circuitBreakerResetMillis?: number;
}

export interface SamplingConfig {
  traceRatio?: number;
  logRatio?: Partial<Record<LogLevel, number>>;
}

export interface PrivacyConfig {
  redactKeys?: ReadonlyArray<string | RegExp>;
  hashUserId?: boolean;
  hashTenantId?: boolean;
  maxAttributeCount?: number;
  maxAttributeValueLength?: number;
  maxLogMessageLength?: number;
  maxStackTraceLength?: number;
  maxEventNameLength?: number;
  maxMetricCardinality?: number;
  urlQueryPolicy?: 'drop' | 'allow-listed';
  allowedUrlQueryKeys?: ReadonlyArray<string>;
  attributeFilter?: (key: string, value: AttributeInput) => AttributeInput;
}

export interface ConsoleInstrumentationConfig {
  enabled?: boolean;
  levels?: ReadonlyArray<LogLevel>;
  preserveOriginal?: boolean;
}

export interface NetworkInstrumentationConfig {
  enabled?: boolean;
  fetch?: boolean;
  xhr?: boolean;
  ignoreUrls?: ReadonlyArray<UrlMatcher>;
  propagateTraceHeadersTo?: ReadonlyArray<UrlMatcher>;
  captureRequestHeaders?: ReadonlyArray<string>;
  captureResponseHeaders?: ReadonlyArray<string>;
}

export interface ErrorInstrumentationConfig {
  enabled?: boolean;
  javascriptErrors?: boolean;
  unhandledRejections?: boolean;
  nativeCrashes?: boolean;
}

export interface LifecycleInstrumentationConfig {
  enabled?: boolean;
  flushOnBackground?: boolean;
  nativeEvents?: boolean;
  anr?: boolean;
  frozenFrames?: boolean;
  nativePollIntervalMillis?: number;
}

export interface InstrumentationsConfig {
  console?: boolean | ConsoleInstrumentationConfig;
  network?: boolean | NetworkInstrumentationConfig;
  errors?: boolean | ErrorInstrumentationConfig;
  lifecycle?: boolean | LifecycleInstrumentationConfig;
}

export interface DiagnosticsConfig {
  enabled?: boolean;
  verbose?: boolean;
  sink?: (message: string, context?: Readonly<Record<string, unknown>>) => void;
}

export interface UnifiedObservabilityConfig {
  serviceName: string;
  version?: string;
  environment?: string;
  serviceNamespace?: string;
  collector: CollectorConfig;
  signals?: SignalConfig;
  sampling?: SamplingConfig;
  batch?: BatchConfig;
  queue?: DurableQueueConfig;
  retry?: RetryConfig;
  privacy?: PrivacyConfig;
  instrumentations?: InstrumentationsConfig;
  diagnostics?: boolean | DiagnosticsConfig;
  resourceAttributes?: AttributeInputs;
  sessionId?: string;
  /** Reject initialization errors instead of returning a fail-open no-op SDK. */
  strictInitialization?: boolean;
}

export interface ResolvedCollectorConfig {
  endpoint: string;
  logsEndpoint: string;
  metricsEndpoint: string;
  tracesEndpoint: string;
  headers: Readonly<Record<string, string>>;
  timeoutMillis: number;
}

export interface ResolvedConfig {
  serviceName: string;
  version: string;
  environment: string;
  serviceNamespace?: string;
  collector: ResolvedCollectorConfig;
  signals: Required<SignalConfig>;
  sampling: {
    traceRatio: number;
    logRatio: Record<LogLevel, number>;
  };
  batch: Required<BatchConfig>;
  queue: Required<DurableQueueConfig>;
  retry: Required<RetryConfig>;
  privacy: Required<Omit<PrivacyConfig, 'attributeFilter'>> &
    Pick<PrivacyConfig, 'attributeFilter'>;
  instrumentations: {
    console: Required<ConsoleInstrumentationConfig>;
    network: Required<NetworkInstrumentationConfig>;
    errors: Required<ErrorInstrumentationConfig>;
    lifecycle: Required<LifecycleInstrumentationConfig>;
  };
  diagnostics: Required<Omit<DiagnosticsConfig, 'sink'>> &
    Pick<DiagnosticsConfig, 'sink'>;
  resourceAttributes: Attributes;
  sessionId: string;
  strictInitialization: boolean;
}

export interface NativePlatformContext {
  platform: 'android' | 'ios' | 'unknown';
  osVersion?: string;
  deviceModel?: string;
  appVersion?: string;
  appBuild?: string;
  appBundleId?: string;
  isEmulator?: boolean;
  processStartUnixMillis?: number;
}

export interface NativeTelemetryEvent {
  id: string;
  type: 'crash' | 'error' | 'lifecycle' | 'performance' | 'memory';
  name: string;
  timestampUnixMillis: number;
  durationMillis?: number;
  attributes?: AttributeInputs;
  traceId?: string;
  spanId?: string;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
}

export interface SpanOptions {
  attributes?: AttributeInputs;
  kind?: SpanKind;
  parent?: Context | TraceContext;
  startTimeUnixMillis?: number;
}

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export interface LogOptions {
  context?: Context | TraceContext;
  error?: unknown;
  eventName?: string;
}

export interface MetricOptions {
  description?: string;
  unit?: string;
  context?: Context | TraceContext;
}

export interface NavigationRouteLike {
  key?: string;
  name: string;
  params?: unknown;
}

export interface NavigationRefLike {
  getCurrentRoute(): NavigationRouteLike | undefined;
}

export interface NavigationInstrumentation {
  onReady(): void;
  onStateChange(): void;
  shutdown(): void;
}

export interface NavigationInstrumentationOptions {
  attributes?: (route: NavigationRouteLike) => AttributeInputs;
  spanName?: (route: NavigationRouteLike) => string;
}

export interface SpanHandle {
  readonly context: Context;
  traceContext(): TraceContext | undefined;
  setAttribute(key: string, value: unknown): this;
  setAttributes(values: AttributeInputs): this;
  addEvent(
    name: string,
    attributes?: AttributeInputs,
    timestampUnixMillis?: number
  ): this;
  recordException(error: unknown): this;
  setStatus(status: SpanStatus): this;
  run<T>(operation: () => T): T;
  bind<T>(value: T): T;
  end(endTimeUnixMillis?: number): void;
}

export interface TracingApi {
  startSpan(name: string, options?: SpanOptions): SpanHandle;
  withSpan<T>(
    name: string,
    operation: (span: SpanHandle) => T,
    options?: SpanOptions
  ): T;
  currentTraceContext(): TraceContext | undefined;
  restore<T>(traceContext: TraceContext, operation: () => T): T;
}

export interface LoggingApi {
  debug(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void;
  info(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void;
  warn(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void;
  error(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void;
  fatal(
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void;
  emit(
    level: LogLevel,
    message: unknown,
    attributes?: AttributeInputs,
    options?: LogOptions
  ): void;
}

export interface MetricsApi {
  counter(
    name: string,
    value?: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void;
  upDownCounter(
    name: string,
    value: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void;
  gauge(
    name: string,
    value: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void;
  histogram(
    name: string,
    value: number,
    attributes?: AttributeInputs,
    options?: MetricOptions
  ): void;
}

export interface UserContextInput {
  id: string;
  attributes?: AttributeInputs;
}

export interface TenantContextInput {
  id: string;
  attributes?: AttributeInputs;
}

export type TraceCarrier = Record<string, string>;

export interface TelemetryContextApi {
  capture(): TraceContext | undefined;
  run<T>(target: Context | TraceContext | undefined, operation: () => T): T;
  bind<T>(target: Context | TraceContext | undefined, value: T): T;
  inject(carrier?: TraceCarrier, source?: Context | TraceContext): TraceCarrier;
  extract(
    carrier: Readonly<Record<string, string | ReadonlyArray<string>>>
  ): Context;
  setUser(value: UserContextInput | null): void;
  setTenant(value: TenantContextInput | null): void;
  setSession(id: string | null, attributes?: AttributeInputs): void;
  setBusinessContext(attributes: AttributeInputs | null): void;
  clear(): void;
}

export interface CaptureExceptionOptions {
  context?: Context | TraceContext;
  handled?: boolean;
  fatal?: boolean;
  mechanism?: string;
}

export interface BusinessEventOptions {
  context?: Context | TraceContext;
  level?: LogLevel;
}

export interface FlushResult {
  delivered: number;
  dropped: number;
  pending: number;
  timedOut: boolean;
}

export interface SdkHealth {
  state: 'idle' | 'starting' | 'started' | 'stopping' | 'stopped';
  nativeBridgeAvailable: boolean;
  queueItems: number;
  queueBytes: number;
  droppedItems: number;
  transportFailures: number;
  circuitOpen: boolean;
  lastSuccessfulExportUnixMillis?: number;
}
