# API reference

All examples use the singleton:

```ts
import { ElvenObservability } from 'elven-unified-observability-react-native';
```

Calls made before a successful `initialize()` or after `shutdown()` are safe no-ops. Public methods that perform telemetry work isolate internal failures.

## Initialization

```ts
await ElvenObservability.initialize(config);
```

Repeated concurrent initialization returns the same in-flight operation. Calling it after the SDK is started returns the current instance. Invalid configuration fails open by default; set `strictInitialization: true` for integration tests and controlled startup environments that should reject.

Minimum configuration:

```ts
await ElvenObservability.initialize({
  serviceName: 'customer-mobile-app',
  environment: 'production',
  collector: { endpoint: 'https://otel.example.com' },
});
```

The base endpoint receives exact `/v1/logs`, `/v1/metrics`, and `/v1/traces` paths. A base ending in one known signal path is normalized before the three paths are created.

### Configuration defaults

| Field                              | Development default                                    | Production default |
| ---------------------------------- | ------------------------------------------------------ | ------------------ |
| `version`                          | `0.0.0`, replaced by native app version when available | same               |
| `environment`                      | `development`                                          | selected by caller |
| all `signals`                      | `true`                                                 | `true`             |
| `sampling.traceRatio`              | `1`                                                    | `0.1`              |
| debug/info log ratio               | `1` / `1`                                              | `0.05` / `0.25`    |
| warn/error/fatal log ratio         | `1`                                                    | `1`                |
| `batch.maxQueueSize`               | `512`                                                  | same               |
| `batch.maxExportBatchSize`         | `64`                                                   | same               |
| `batch.scheduledDelayMillis`       | `2000`                                                 | same               |
| `batch.exportTimeoutMillis`        | `5000`                                                 | same               |
| `batch.metricExportIntervalMillis` | `60000`                                                | same               |
| `queue.enabled`                    | `true`                                                 | `true`             |
| `queue.maxItems`                   | `128`                                                  | same               |
| `queue.maxBytes`                   | `524288`                                               | same               |
| `queue.maxItemBytes`               | `131072`                                               | same               |
| `queue.maxAgeMillis`               | 24 hours                                               | same               |
| retry initial/max delay            | `1000` / `30000` ms                                    | same               |
| retry max attempts                 | `8`                                                    | same               |
| retry jitter                       | `0.2`                                                  | same               |
| circuit threshold/reset            | `5` / `30000` ms                                       | same               |
| hash user/tenant ID                | `true` / `true`                                        | same               |
| max attributes/value               | `64` / `1024` characters                               | same               |
| max log/stack/event name           | `4096` / `8192` / `128` characters                     | same               |
| max metric cardinality             | `200`                                                  | same               |
| URL query policy                   | `drop`                                                 | `drop`             |
| console levels                     | all                                                    | warn/error/fatal   |
| fetch/XHR/errors/lifecycle/native  | enabled                                                | enabled            |
| HTTP propagation destinations      | none                                                   | none               |
| diagnostics                        | disabled                                               | disabled           |

Numeric configuration is validated and clamped to safe hard limits. Invalid ratios, non-positive bounds, header line breaks, inconsistent queue/batch limits, invalid URLs, and cleartext production endpoints are rejected.

### Signal endpoints and headers

```ts
collector: {
  endpoint: 'https://otel.example.com',
  logsEndpoint: 'https://logs-gateway.example.com/v1/logs',
  metricsEndpoint: 'https://metrics-gateway.example.com/v1/metrics',
  tracesEndpoint: 'https://traces-gateway.example.com/v1/traces',
  headers: getShortLivedHeaders(),
  timeoutMillis: 5_000,
}
```

Headers are never persisted, but a long-lived token inside a mobile binary is still extractable. Prefer a Collector/gateway design that does not embed a reusable secret.

## Logging

```ts
ElvenObservability.logs.debug('Cache lookup', { 'cache.hit': true });
ElvenObservability.logs.info('Order submitted', { 'order.item_count': 3 });
ElvenObservability.logs.warn('Retry scheduled', { 'retry.attempt': 2 });
ElvenObservability.logs.error('Payment failed', {}, { error });
ElvenObservability.logs.fatal('Fatal state', {}, { error });

ElvenObservability.logs.emit('info', 'Custom level dispatcher', attributes, {
  context,
  eventName: 'order.submitted',
});
```

An active or explicit context adds `trace_id` and `span_id`. Structured values are sanitized; objects become bounded JSON text rather than unlimited nested attributes.

## Metrics

```ts
ElvenObservability.metrics.counter('cart.item.added', 1, {
  'item.category': 'book',
});
ElvenObservability.metrics.upDownCounter('checkout.in_flight', 1);
ElvenObservability.metrics.gauge('cart.item.count', 3, undefined, {
  unit: '{item}',
});
ElvenObservability.metrics.histogram('checkout.duration', 0.82, undefined, {
  unit: 's',
  context: span.context,
});
```

Metric names are normalized. Do not use user IDs, order IDs, route instance keys, URLs, exception messages, or arbitrary event names as metric attributes. Screen name is the only dynamic context automatically attached to metrics. Correlation uses OTLP exemplars, never trace IDs as labels.

## Tracing

### Explicit span

```ts
const span = ElvenObservability.traces.startSpan('checkout.confirm', {
  attributes: { 'checkout.currency': 'BRL' },
});

try {
  const response = await span.run(() => fetch(url));
  span.run(() => {
    span.addEvent('response.received', {
      'http.response.status_code': response.status,
    });
    ElvenObservability.logs.info(
      'Checkout complete',
      {},
      {
        context: span.context,
      }
    );
  });
  span.setStatus({ code: SpanStatusCode.OK });
} catch (error) {
  span.recordException(error).setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  span.end();
}
```

### Managed span

```ts
const result = await ElvenObservability.traces.withSpan(
  'catalog.refresh',
  async (span) => {
    const response = await span.run(() => fetch(url));
    return response.json();
  }
);
```

`withSpan` records status, exception, and end time. It does not promise implicit context after every `await`; use `span.run` when starting child work and pass `context` explicitly afterward.

### `SpanHandle`

- `traceContext()` returns serializable W3C IDs when sampled/valid.
- `setAttribute()` and `setAttributes()` sanitize values.
- `addEvent()` supports an optional epoch-millisecond timestamp.
- `recordException()` records bounded type/message/stack fields.
- `setStatus()` accepts exported `SpanStatusCode`.
- `run()` activates JS and synchronous native context.
- `bind()` binds a callback or supported value to this SDK's context manager.
- `end()` is idempotent and accepts an optional epoch-millisecond end time.

## Business events and exceptions

```ts
ElvenObservability.event('checkout.coupon.applied', {
  'coupon.type': 'percentage',
  'coupon.value': 10,
});

ElvenObservability.captureException(
  error,
  { 'payment.provider': 'provider-name' },
  { handled: true, fatal: false, mechanism: 'validation' }
);
```

A business event creates a span event, correlated log, and bounded counter. Exception capture creates an error span, error/fatal log, and exception counter. Automatic handlers use `handled: false`.

## Dynamic context

```ts
ElvenObservability.context.setUser({
  id: opaqueUserId,
  attributes: { plan: 'business' },
});
ElvenObservability.context.setTenant({ id: opaqueTenantId });
ElvenObservability.context.setSession(randomSessionId);
ElvenObservability.context.setBusinessContext({ region: 'south' });
```

Clear individual values with `null`; `context.clear()` clears every dynamic value.

### Capture, restore, inject, and extract

```ts
const captured = ElvenObservability.context.capture();

queue.push(() => {
  if (captured) {
    ElvenObservability.context.run(captured, () => doWork());
  }
});

const outbound = ElvenObservability.context.inject({}, captured);
const remoteParent = ElvenObservability.context.extract(inboundHeaders);

ElvenObservability.traces.startSpan('remote.work', { parent: remoteParent });
```

`traces.restore(traceContext, operation)` is a shorthand for restoring a serialized trace context around one operation.

## Navigation

Manual screen context:

```ts
ElvenObservability.recordScreen('Checkout', {
  'navigation.source': 'deep-link',
});
```

React Navigation integration without a required package dependency:

```tsx
const navigationRef = createNavigationContainerRef();
const navigation = ElvenObservability.createNavigationInstrumentation(
  navigationRef,
  {
    attributes: (route) => ({
      'navigation.area': route.name.startsWith('Admin') ? 'admin' : 'customer',
    }),
  }
);

<NavigationContainer
  ref={navigationRef}
  onReady={navigation.onReady}
  onStateChange={navigation.onStateChange}
>
  {children}
</NavigationContainer>;
```

Call `navigation.shutdown()` if the container is permanently removed. Route params are not captured by default. Attribute callbacks must return bounded, non-sensitive, low-cardinality values.

## HTTP instrumentation

```ts
instrumentations: {
  network: {
    enabled: true,
    fetch: true,
    xhr: true,
    ignoreUrls: [/\/health$/, 'https://third-party.example.com'],
    propagateTraceHeadersTo: [
      'https://api.example.com',
      'https://uploads.example.com/v2/',
    ],
    captureRequestHeaders: ['content-type'],
    captureResponseHeaders: ['content-type', 'retry-after'],
  },
}
```

String allow-list matching compares exact origin and a path boundary. `https://api.example.com` does not match `https://api.example.com.evil.test`; `/v1` does not match `/v10`. RegExp values have `lastIndex` reset before each match.

## Diagnostics and health

```ts
diagnostics: {
  enabled: !isProduction,
  verbose: false,
  sink: (message, context) => integrationLogger(message, context),
}
```

Do not route the diagnostics sink back into a logger intercepted by this SDK. Diagnostic messages contain operational metadata, not payloads or headers, and are rate-limited.

```ts
const health = ElvenObservability.health();
```

`SdkHealth` reports lifecycle state, native bridge availability, queue items/bytes, dropped items, transport failures, circuit state, and optional last successful export time.

## Flush and shutdown

```ts
const flush = await ElvenObservability.flush(5_000);
const shutdown = await ElvenObservability.shutdown(5_000);
```

Both return `{ delivered, dropped, pending, timedOut }`. Background flush is automatically requested when enabled, but the operating system may suspend JavaScript before completion. Keep the durable queue enabled and do not block UI or termination waiting for telemetry.

## Multiple instances

```ts
import { ElvenObservabilitySdk } from 'elven-unified-observability-react-native';

const isolated = new ElvenObservabilitySdk();
```

Use multiple instances only for tests or isolated runtimes. Multiple live instances can instrument the same globals and create duplicate fetch, XHR, console, and error signals. Production apps should use the singleton.
