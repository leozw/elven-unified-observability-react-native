import type { Attributes } from '@opentelemetry/api';
import { DEFAULT_REDACT_KEYS, LOG_LEVELS } from './constants';
import { createSessionId } from './ids';
import type {
  ConsoleInstrumentationConfig,
  DiagnosticsConfig,
  ErrorInstrumentationConfig,
  InstrumentationsConfig,
  LifecycleInstrumentationConfig,
  NetworkInstrumentationConfig,
  ResolvedConfig,
  UnifiedObservabilityConfig,
} from '../types';

export interface ConfigurationIssue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

const KNOWN_SIGNAL_PATH = /\/v1\/(logs|metrics|traces)\/?$/i;

export function validateConfiguration(
  config: UnifiedObservabilityConfig
): ReadonlyArray<ConfigurationIssue> {
  const issues: ConfigurationIssue[] = [];
  if (!config || typeof config !== 'object') {
    return [
      {
        level: 'error',
        path: 'config',
        message: 'Configuration must be an object.',
      },
    ];
  }
  if (!config.serviceName?.trim()) {
    issues.push({
      level: 'error',
      path: 'serviceName',
      message: 'serviceName is required and cannot be blank.',
    });
  }
  if (!isHttpUrl(config.collector?.endpoint)) {
    issues.push({
      level: 'error',
      path: 'collector.endpoint',
      message:
        'collector.endpoint must be an absolute http:// or https:// URL.',
    });
  }
  for (const signal of ['logs', 'metrics', 'traces'] as const) {
    const endpoint = config.collector?.[`${signal}Endpoint`];
    if (endpoint !== undefined && !isHttpUrl(endpoint)) {
      issues.push({
        level: 'error',
        path: `collector.${signal}Endpoint`,
        message: 'Signal endpoint must be an absolute http:// or https:// URL.',
      });
    }
  }
  for (const [name, value] of Object.entries(config.collector?.headers ?? {})) {
    if (!name.trim() || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      issues.push({
        level: 'error',
        path: `collector.headers.${name || '<empty>'}`,
        message:
          'Header names and values cannot be blank or contain line breaks.',
      });
    }
  }
  if (config.environment?.trim() === 'production') {
    for (const [path, endpoint] of [
      ['collector.endpoint', config.collector?.endpoint],
      ['collector.logsEndpoint', config.collector?.logsEndpoint],
      ['collector.metricsEndpoint', config.collector?.metricsEndpoint],
      ['collector.tracesEndpoint', config.collector?.tracesEndpoint],
    ] as const) {
      if (endpoint !== undefined && !/^https:\/\//i.test(endpoint)) {
        issues.push({
          level: 'error',
          path,
          message: 'Production telemetry requires HTTPS.',
        });
      }
    }
  }
  validateRatio(issues, 'sampling.traceRatio', config.sampling?.traceRatio);
  validateRatio(issues, 'retry.jitterRatio', config.retry?.jitterRatio);
  for (const level of LOG_LEVELS) {
    validateRatio(
      issues,
      `sampling.logRatio.${level}`,
      config.sampling?.logRatio?.[level]
    );
  }
  validatePositive(issues, 'batch.maxQueueSize', config.batch?.maxQueueSize);
  validatePositive(
    issues,
    'batch.maxExportBatchSize',
    config.batch?.maxExportBatchSize
  );
  if (
    config.batch?.maxQueueSize !== undefined &&
    config.batch?.maxExportBatchSize !== undefined &&
    config.batch.maxExportBatchSize > config.batch.maxQueueSize
  ) {
    issues.push({
      level: 'error',
      path: 'batch.maxExportBatchSize',
      message: 'maxExportBatchSize cannot exceed maxQueueSize.',
    });
  }
  validatePositive(issues, 'queue.maxItems', config.queue?.maxItems);
  validatePositive(issues, 'queue.maxBytes', config.queue?.maxBytes);
  validatePositive(issues, 'queue.maxItemBytes', config.queue?.maxItemBytes);
  for (const [path, value] of [
    ['collector.timeoutMillis', config.collector?.timeoutMillis],
    ['batch.scheduledDelayMillis', config.batch?.scheduledDelayMillis],
    ['batch.exportTimeoutMillis', config.batch?.exportTimeoutMillis],
    [
      'batch.metricExportIntervalMillis',
      config.batch?.metricExportIntervalMillis,
    ],
    ['queue.maxAgeMillis', config.queue?.maxAgeMillis],
    ['retry.initialDelayMillis', config.retry?.initialDelayMillis],
    ['retry.maxDelayMillis', config.retry?.maxDelayMillis],
    ['retry.maxAttempts', config.retry?.maxAttempts],
    [
      'retry.circuitBreakerFailureThreshold',
      config.retry?.circuitBreakerFailureThreshold,
    ],
    [
      'retry.circuitBreakerResetMillis',
      config.retry?.circuitBreakerResetMillis,
    ],
    ['privacy.maxAttributeCount', config.privacy?.maxAttributeCount],
    [
      'privacy.maxAttributeValueLength',
      config.privacy?.maxAttributeValueLength,
    ],
    ['privacy.maxLogMessageLength', config.privacy?.maxLogMessageLength],
    ['privacy.maxStackTraceLength', config.privacy?.maxStackTraceLength],
    ['privacy.maxEventNameLength', config.privacy?.maxEventNameLength],
    ['privacy.maxMetricCardinality', config.privacy?.maxMetricCardinality],
  ] as const) {
    validatePositive(issues, path, value);
  }
  if (
    config.retry?.initialDelayMillis !== undefined &&
    config.retry?.maxDelayMillis !== undefined &&
    config.retry.initialDelayMillis > config.retry.maxDelayMillis
  ) {
    issues.push({
      level: 'error',
      path: 'retry.initialDelayMillis',
      message: 'initialDelayMillis cannot exceed maxDelayMillis.',
    });
  }
  if (
    config.queue?.maxBytes !== undefined &&
    config.queue?.maxItemBytes !== undefined &&
    config.queue.maxItemBytes > config.queue.maxBytes
  ) {
    issues.push({
      level: 'error',
      path: 'queue.maxItemBytes',
      message: 'maxItemBytes cannot exceed maxBytes.',
    });
  }
  if (
    enabledObject(config.instrumentations?.network).enabled !== false &&
    normalizeNetwork(config.instrumentations?.network).propagateTraceHeadersTo
      .length === 0
  ) {
    issues.push({
      level: 'warning',
      path: 'instrumentations.network.propagateTraceHeadersTo',
      message:
        'No trace propagation allow-list was configured; outbound spans will be captured without sending trace headers.',
    });
  }
  return issues;
}

export function resolveConfig(
  config: UnifiedObservabilityConfig
): ResolvedConfig {
  const issues = validateConfiguration(config);
  const errors = issues.filter((issue) => issue.level === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Invalid Elven observability configuration: ${errors
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join(' ')}`
    );
  }

  const environment = config.environment?.trim() || 'development';
  const production = environment === 'production';
  const collectorBase = stripTrailingSlash(
    config.collector.endpoint.replace(KNOWN_SIGNAL_PATH, '')
  );
  const queueMaxBytes = clampInteger(
    config.queue?.maxBytes,
    524_288,
    16_384,
    4_194_304
  );
  const queueMaxItemBytes = Math.min(
    queueMaxBytes,
    clampInteger(config.queue?.maxItemBytes, 131_072, 4_096, 1_048_576)
  );
  const maxQueueSize = clampInteger(config.batch?.maxQueueSize, 512, 16, 8_192);
  const maxExportBatchSize = Math.min(
    maxQueueSize,
    clampInteger(config.batch?.maxExportBatchSize, 64, 1, 512)
  );
  const diagnostics = normalizeDiagnostics(config.diagnostics);

  return {
    serviceName: config.serviceName.trim(),
    version: config.version?.trim() || '0.0.0',
    environment,
    ...(config.serviceNamespace?.trim()
      ? { serviceNamespace: config.serviceNamespace.trim() }
      : {}),
    collector: {
      endpoint: collectorBase,
      logsEndpoint: exactSignalEndpoint(
        config.collector.logsEndpoint,
        collectorBase,
        'logs'
      ),
      metricsEndpoint: exactSignalEndpoint(
        config.collector.metricsEndpoint,
        collectorBase,
        'metrics'
      ),
      tracesEndpoint: exactSignalEndpoint(
        config.collector.tracesEndpoint,
        collectorBase,
        'traces'
      ),
      headers: Object.freeze({ ...(config.collector.headers ?? {}) }),
      timeoutMillis: clampInteger(
        config.collector.timeoutMillis,
        5_000,
        500,
        30_000
      ),
    },
    signals: {
      logs: config.signals?.logs ?? true,
      metrics: config.signals?.metrics ?? true,
      traces: config.signals?.traces ?? true,
    },
    sampling: {
      traceRatio: clampRatio(config.sampling?.traceRatio, production ? 0.1 : 1),
      logRatio: {
        debug: clampRatio(
          config.sampling?.logRatio?.debug,
          production ? 0.05 : 1
        ),
        info: clampRatio(
          config.sampling?.logRatio?.info,
          production ? 0.25 : 1
        ),
        warn: clampRatio(config.sampling?.logRatio?.warn, 1),
        error: clampRatio(config.sampling?.logRatio?.error, 1),
        fatal: clampRatio(config.sampling?.logRatio?.fatal, 1),
      },
    },
    batch: {
      maxQueueSize,
      maxExportBatchSize,
      scheduledDelayMillis: clampInteger(
        config.batch?.scheduledDelayMillis,
        2_000,
        100,
        60_000
      ),
      exportTimeoutMillis: clampInteger(
        config.batch?.exportTimeoutMillis,
        5_000,
        500,
        30_000
      ),
      metricExportIntervalMillis: clampInteger(
        config.batch?.metricExportIntervalMillis,
        60_000,
        10_000,
        900_000
      ),
    },
    queue: {
      enabled: config.queue?.enabled ?? true,
      maxItems: clampInteger(config.queue?.maxItems, 128, 8, 2_048),
      maxBytes: queueMaxBytes,
      maxItemBytes: queueMaxItemBytes,
      maxAgeMillis: clampInteger(
        config.queue?.maxAgeMillis,
        86_400_000,
        60_000,
        604_800_000
      ),
    },
    retry: {
      initialDelayMillis: clampInteger(
        config.retry?.initialDelayMillis,
        1_000,
        100,
        30_000
      ),
      maxDelayMillis: clampInteger(
        config.retry?.maxDelayMillis,
        30_000,
        1_000,
        300_000
      ),
      maxAttempts: clampInteger(config.retry?.maxAttempts, 8, 1, 100),
      jitterRatio: clampRatio(config.retry?.jitterRatio, 0.2),
      circuitBreakerFailureThreshold: clampInteger(
        config.retry?.circuitBreakerFailureThreshold,
        5,
        2,
        100
      ),
      circuitBreakerResetMillis: clampInteger(
        config.retry?.circuitBreakerResetMillis,
        30_000,
        1_000,
        600_000
      ),
    },
    privacy: {
      redactKeys: config.privacy?.redactKeys ?? DEFAULT_REDACT_KEYS,
      hashUserId: config.privacy?.hashUserId ?? true,
      hashTenantId: config.privacy?.hashTenantId ?? true,
      maxAttributeCount: clampInteger(
        config.privacy?.maxAttributeCount,
        64,
        8,
        256
      ),
      maxAttributeValueLength: clampInteger(
        config.privacy?.maxAttributeValueLength,
        1_024,
        64,
        16_384
      ),
      maxLogMessageLength: clampInteger(
        config.privacy?.maxLogMessageLength,
        4_096,
        128,
        32_768
      ),
      maxStackTraceLength: clampInteger(
        config.privacy?.maxStackTraceLength,
        8_192,
        512,
        65_536
      ),
      maxEventNameLength: clampInteger(
        config.privacy?.maxEventNameLength,
        128,
        32,
        512
      ),
      maxMetricCardinality: clampInteger(
        config.privacy?.maxMetricCardinality,
        200,
        10,
        2_000
      ),
      urlQueryPolicy: config.privacy?.urlQueryPolicy ?? 'drop',
      allowedUrlQueryKeys: config.privacy?.allowedUrlQueryKeys ?? [],
      ...(config.privacy?.attributeFilter
        ? { attributeFilter: config.privacy.attributeFilter }
        : {}),
    },
    instrumentations: normalizeInstrumentations(
      config.instrumentations,
      production,
      [
        collectorBase,
        config.collector.logsEndpoint,
        config.collector.metricsEndpoint,
        config.collector.tracesEndpoint,
      ].filter((value): value is string => Boolean(value))
    ),
    diagnostics,
    resourceAttributes: normalizeResourceAttributes(config.resourceAttributes),
    sessionId: config.sessionId?.trim() || createSessionId(),
    strictInitialization: config.strictInitialization ?? false,
  };
}

function normalizeInstrumentations(
  config: InstrumentationsConfig | undefined,
  production: boolean,
  collectorUrls: ReadonlyArray<string>
): ResolvedConfig['instrumentations'] {
  const consoleConfig = normalizeConsole(config?.console, production);
  const networkConfig = normalizeNetwork(config?.network);
  const errorConfig = normalizeErrors(config?.errors);
  const lifecycleConfig = normalizeLifecycle(config?.lifecycle);
  return {
    console: consoleConfig,
    network: {
      ...networkConfig,
      ignoreUrls: [...networkConfig.ignoreUrls, ...collectorUrls],
    },
    errors: errorConfig,
    lifecycle: lifecycleConfig,
  };
}

function normalizeConsole(
  input: boolean | ConsoleInstrumentationConfig | undefined,
  production: boolean
): Required<ConsoleInstrumentationConfig> {
  const value = enabledObject(input);
  return {
    enabled: value.enabled ?? true,
    levels:
      input && typeof input === 'object' && input.levels
        ? input.levels
        : production
          ? ['warn', 'error', 'fatal']
          : LOG_LEVELS,
    preserveOriginal:
      input && typeof input === 'object'
        ? (input.preserveOriginal ?? true)
        : true,
  };
}

function normalizeNetwork(
  input: boolean | NetworkInstrumentationConfig | undefined
): Required<NetworkInstrumentationConfig> {
  const value = enabledObject(input);
  const object = input && typeof input === 'object' ? input : undefined;
  return {
    enabled: value.enabled ?? true,
    fetch: object?.fetch ?? true,
    xhr: object?.xhr ?? true,
    ignoreUrls: object?.ignoreUrls ?? [],
    propagateTraceHeadersTo: object?.propagateTraceHeadersTo ?? [],
    captureRequestHeaders: normalizeHeaderNames(object?.captureRequestHeaders),
    captureResponseHeaders: normalizeHeaderNames(
      object?.captureResponseHeaders
    ),
  };
}

function normalizeErrors(
  input: boolean | ErrorInstrumentationConfig | undefined
): Required<ErrorInstrumentationConfig> {
  const value = enabledObject(input);
  const object = input && typeof input === 'object' ? input : undefined;
  return {
    enabled: value.enabled ?? true,
    javascriptErrors: object?.javascriptErrors ?? true,
    unhandledRejections: object?.unhandledRejections ?? true,
    nativeCrashes: object?.nativeCrashes ?? true,
  };
}

function normalizeLifecycle(
  input: boolean | LifecycleInstrumentationConfig | undefined
): Required<LifecycleInstrumentationConfig> {
  const value = enabledObject(input);
  const object = input && typeof input === 'object' ? input : undefined;
  return {
    enabled: value.enabled ?? true,
    flushOnBackground: object?.flushOnBackground ?? true,
    nativeEvents: object?.nativeEvents ?? true,
    anr: object?.anr ?? true,
    frozenFrames: object?.frozenFrames ?? true,
    nativePollIntervalMillis: clampInteger(
      object?.nativePollIntervalMillis,
      15_000,
      5_000,
      300_000
    ),
  };
}

function enabledObject(input: boolean | { enabled?: boolean } | undefined): {
  enabled?: boolean;
} {
  return typeof input === 'boolean' ? { enabled: input } : (input ?? {});
}

function normalizeDiagnostics(
  input: boolean | DiagnosticsConfig | undefined
): ResolvedConfig['diagnostics'] {
  if (typeof input === 'boolean') {
    return { enabled: input, verbose: false };
  }
  return {
    enabled: input?.enabled ?? false,
    verbose: input?.verbose ?? false,
    ...(input?.sink ? { sink: input.sink } : {}),
  };
}

function normalizeResourceAttributes(input: unknown): Attributes {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      output[key] = value;
    }
  }
  return output;
}

function exactSignalEndpoint(
  configured: string | undefined,
  base: string,
  signal: 'logs' | 'metrics' | 'traces'
): string {
  return configured ? stripTrailingSlash(configured) : `${base}/v1/${signal}`;
}

function normalizeHeaderNames(
  input: ReadonlyArray<string> | undefined
): ReadonlyArray<string> {
  return Array.from(
    new Set(
      (input ?? []).map((header) => header.trim().toLowerCase()).filter(Boolean)
    )
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isHttpUrl(value: string | undefined): boolean {
  return (
    typeof value === 'string' && /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(value)
  );
}

function validateRatio(
  issues: ConfigurationIssue[],
  path: string,
  value: number | undefined
): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value < 0 || value > 1)
  ) {
    issues.push({
      level: 'error',
      path,
      message: 'Value must be between 0 and 1.',
    });
  }
}

function validatePositive(
  issues: ConfigurationIssue[],
  path: string,
  value: number | undefined
): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    issues.push({
      level: 'error',
      path,
      message: 'Value must be a positive finite number.',
    });
  }
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value as number));
}
