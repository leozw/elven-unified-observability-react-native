# Elven Unified Observability for React Native

Production-oriented logs, metrics, traces, errors, network telemetry, app lifecycle, and mobile performance through one correlated OpenTelemetry pipeline.

The SDK targets modern React Native with Hermes and the New Architecture. It exports standard OTLP/HTTP JSON to a Collector, keeps backend credentials out of the mobile app, bounds every queue and payload, and fails open when observability is unavailable.

## What it captures

| Signal      | Automatic                                                                                    | Manual API                                                   |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Logs        | Selected `console` levels, JS/native errors, lifecycle and native events                     | Structured debug/info/warn/error/fatal                       |
| Traces      | Fetch, XHR, screens, errors, lifecycle/native performance                                    | Spans, events, parent/restore/inject/extract                 |
| Metrics     | HTTP duration/count, screens, exceptions, native events/duration, initialization             | Counter, up/down counter, gauge, histogram                   |
| Errors      | JS global errors, unhandled rejections, Android crashes, iOS MetricKit diagnostics, ANR/hang | `captureException`                                           |
| Performance | Process/app start, first frame, slow/frozen frames, HTTP, lifecycle, MetricKit               | Custom timed spans and histograms                            |
| Context     | App/build/platform/device model, environment, session, screen                                | Pseudonymized user/tenant, business context, W3C propagation |

Logs and spans share trace/span IDs. Metrics use bounded OTLP exemplars for trace correlation without creating high-cardinality trace-ID labels.

## Compatibility

- React Native `0.86.x` and `0.87.x`;
- React `19.x`;
- New Architecture and Hermes;
- Android API 24+;
- iOS 15.1+ for bare React Native;
- Expo SDK 57 Development Builds, prebuild/CNG, EAS Build, and bare projects;
- Expo Go with a safe JS-only fallback.

Expo SDK 57 itself requires iOS 16.4+ and its documented toolchain. Older React Native versions, Legacy Architecture, JavaScriptCore, Windows, macOS, visionOS, and tvOS are not in the declared support contract. See [COMPATIBILITY.md](COMPATIBILITY.md) for the evidence matrix and exact prerequisites.

## Install

```sh
npm install elven-unified-observability-react-native
```

or:

```sh
yarn add elven-unified-observability-react-native
```

Rebuild the native application after installation. No direct Loki/Mimir/Tempo package and no separate logs package are required.

The package is ESM-only. Use `import` syntax; CommonJS callers must use dynamic `import()` and are not part of the React Native support contract.

## Quickstart

Initialize as early as practical, without blocking the application's first render:

```ts
import { ElvenObservability } from 'elven-unified-observability-react-native';

ElvenObservability.initialize({
  serviceName: 'customer-mobile-app',
  version: '2.4.0',
  environment: 'production',
  collector: {
    endpoint: 'https://otel.example.com',
  },
  instrumentations: {
    network: {
      enabled: true,
      propagateTraceHeadersTo: ['https://api.example.com'],
    },
  },
}).catch(() => undefined);
```

That is enough to receive useful console, HTTP, JS error, app lifecycle, and supported native telemetry. Production endpoints must use HTTPS. The propagation allow-list is intentionally empty by default, so outbound spans are captured but trace headers are not sent to an unapproved host.

Do not embed a reusable Collector token in the bundle. Route mobile OTLP to a controlled Collector/gateway that handles tenancy, rate limiting, backend authentication, and further redaction. See [Collector integration](docs/COLLECTOR.md).

## Android

Autolinking and React Native Codegen install the Kotlin Turbo Native Module. The package declares Android API 24, compile SDK 36, and Java 17-compatible bytecode.

For bare React Native:

```sh
npx react-native run-android
```

No crash service, manifest receiver, background service, or additional dangerous permission is installed. Standard app Internet access is required for OTLP.

For local HTTP Collector testing, Android emulators can use `10.0.2.2` or `adb reverse tcp:4318 tcp:4318`. The included demo uses a scoped network-security config for local hosts only. Production configuration rejects cleartext Collector endpoints.

## iOS

Autolinking and CocoaPods install the Objective-C++ Turbo Native Module:

```sh
npx pod-install
npx react-native run-ios
```

The pod inherits the minimum iOS version from the host React Native line. Native diagnostics use MetricKit and app-private protected persistence; no unsafe crash signal handler or swizzling dependency is added.

iOS crash and performance reports can arrive after the originating event. MetricKit behavior must be validated on a real device for production acceptance.

## Expo

### Development Build, EAS Build, or prebuild

These provide full Android/iOS behavior:

```sh
npx expo install expo-dev-client
npx expo prebuild
npx expo run:android
# or
npx expo run:ios
```

Installing or upgrading this SDK changes native code. Create a new binary and use an Expo `runtimeVersion` policy that prevents incompatible OTA updates.

### Expo Go

Expo Go cannot contain arbitrary third-party native modules. The SDK does not crash: JS logs, metrics, traces, fetch/XHR, JS errors, and AppState continue to work, while native crashes, ANR/hang, frames, device metadata, and durable native storage are unavailable. `health().nativeBridgeAvailable` reports `false`.

## Automatic instrumentation

Every integration can be enabled, disabled, or tuned independently:

```ts
instrumentations: {
  console: {
    enabled: true,
    levels: ['warn', 'error', 'fatal'],
    preserveOriginal: true,
  },
  network: {
    enabled: true,
    fetch: true,
    xhr: true,
    ignoreUrls: [/\/health$/],
    propagateTraceHeadersTo: [
      'https://api.example.com',
      'https://uploads.example.com/v2/',
    ],
    captureRequestHeaders: ['content-type'],
    captureResponseHeaders: ['content-type', 'retry-after'],
  },
  errors: {
    enabled: true,
    javascriptErrors: true,
    unhandledRejections: true,
    nativeCrashes: true,
  },
  lifecycle: {
    enabled: true,
    flushOnBackground: true,
    nativeEvents: true,
    anr: true,
    frozenFrames: true,
    nativePollIntervalMillis: 15_000,
  },
}
```

`lifecycle.nativeEvents` is the master switch for native lifecycle, ANR/hang, frame, memory, and app-start events. Native crash collection remains controlled independently by `errors.nativeCrashes`, including its polling and next-launch delivery path.

Collector requests are always ignored by network instrumentation to prevent recursion. The SDK preserves and restores original global functions at shutdown and deduplicates repeated error/native event capture.

### Navigation

For any router, record a stable screen name:

```ts
ElvenObservability.recordScreen('Checkout');
```

For React Navigation, no mandatory navigation dependency is added:

```tsx
const instrumentation =
  ElvenObservability.createNavigationInstrumentation(navigationRef);

<NavigationContainer
  ref={navigationRef}
  onReady={instrumentation.onReady}
  onStateChange={instrumentation.onStateChange}
>
  {children}
</NavigationContainer>;
```

Route params are not captured. Only add stable, non-sensitive custom route attributes.

## Manual instrumentation

### Structured logs

```ts
ElvenObservability.logs.info('Order submitted', {
  'order.item_count': 3,
  'payment.method': 'pix',
});

ElvenObservability.logs.error('Payment rejected', {}, { error });
```

### Metrics

```ts
ElvenObservability.metrics.counter('cart.item.added', 1, {
  'item.category': 'book',
});
ElvenObservability.metrics.gauge('cart.item.count', 3, undefined, {
  unit: '{item}',
});
ElvenObservability.metrics.histogram('checkout.duration', 0.82, undefined, {
  unit: 's',
});
```

Metric attributes must be low cardinality. Do not use user, tenant, order, route-instance, exception-message, or URL values as labels.

### Correlated async operation

```ts
import {
  ElvenObservability,
  SpanStatusCode,
} from 'elven-unified-observability-react-native';

const span = ElvenObservability.traces.startSpan('checkout.confirm', {
  attributes: { 'checkout.currency': 'BRL' },
});

try {
  const response = await span.run(() => fetch(checkoutUrl));

  span.run(() => {
    ElvenObservability.logs.info(
      'Checkout completed',
      {},
      {
        context: span.context,
      }
    );
    ElvenObservability.metrics.histogram(
      'checkout.order.value',
      149.9,
      { 'checkout.currency': 'BRL' },
      { context: span.context, unit: 'BRL' }
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

Hermes does not provide Node.js `AsyncLocalStorage`. The SDK will not monkey-patch every Promise. Use `span.run` when starting child work, or pass `{ context: span.context }` explicitly after an `await`. See [Architecture: context propagation](ARCHITECTURE.md#context-propagation).

### Business events and exceptions

```ts
ElvenObservability.event('checkout.coupon.applied', {
  'coupon.type': 'percentage',
  'coupon.value': 10,
});

ElvenObservability.captureException(
  error,
  { 'payment.provider': 'provider-name' },
  { handled: true, mechanism: 'validation' }
);
```

Business events produce a correlated span, log, and bounded metric. They are operational telemetry, not a replacement for a consent-aware product analytics system.

### User, tenant, session, and business context

```ts
ElvenObservability.context.setUser({ id: opaqueUserId });
ElvenObservability.context.setTenant({ id: opaqueTenantId });
ElvenObservability.context.setSession(randomSessionId);
ElvenObservability.context.setBusinessContext({ region: 'south' });
```

User and tenant IDs are pseudonymized by default within a service/environment namespace. Hashing is not anonymization; use opaque IDs and obtain required consent. Clear values with `null` or call `context.clear()`.

### Capture and restore context

```ts
const context = ElvenObservability.context.capture();

workQueue.enqueue(() => {
  if (context) {
    ElvenObservability.context.run(context, () => performWork());
  }
});
```

`context.inject()` and `context.extract()` support W3C carriers. Custom native modules can capture an immutable native context for asynchronous work; see [custom native module correlation](docs/NATIVE_MODULES.md).

## Sampling and volume control

Production defaults sample 10% of root traces, 5% of debug logs, 25% of info logs, and 100% of warn/error/fatal logs. Development defaults keep all. Parent sampling decisions are respected.

```ts
sampling: {
  traceRatio: 0.05,
  logRatio: {
    debug: 0,
    info: 0.1,
    warn: 1,
    error: 1,
    fatal: 1,
  },
},
privacy: {
  maxMetricCardinality: 100,
},
```

Queue, payload, retry, and batch bounds are independently configurable. See [PERFORMANCE.md](PERFORMANCE.md) for measured budgets and a conservative high-volume profile.

## Security and privacy

By default the SDK:

- requires HTTPS in production;
- captures no HTTP bodies;
- drops URL query strings and fragments;
- captures no headers unless explicitly allow-listed;
- never propagates trace headers without an exact destination allow-list;
- redacts credential, auth, payment, body, email, phone, CPF, and CNPJ-like keys;
- redacts common credentials, JWTs, URL user-info, and email addresses in free-form text;
- pseudonymizes user and tenant IDs;
- never persists Collector headers;
- applies hard size and cardinality bounds;
- stores queued telemetry in private no-backup application storage.

```ts
privacy: {
  redactKeys: [/authorization/i, /customer\.document/i],
  urlQueryPolicy: 'drop',
  attributeFilter: (key, value) =>
    key.startsWith('internal.') ? undefined : value,
},
```

Supplying `redactKeys` replaces the default list. Review [SECURITY.md](SECURITY.md) before changing privacy settings.

## Delivery reliability

The transport uses OTLP/HTTP JSON batching, an app-private durable queue, exponential retry with jitter, response-aware permanent/transient failure handling, deadlines, a circuit breaker, and priority backpressure.

Defaults:

- 128 durable batches;
- 512 KiB total JS queue;
- 128 KiB maximum batch;
- 24-hour maximum age;
- 8 attempts;
- 5 consecutive failures before a 30-second circuit break.

When capacity is exhausted, older lower-priority telemetry is evicted. The SDK never allows the queue to grow without bound and never blocks application work waiting for the Collector.

## Flush, shutdown, and health

```ts
const result = await ElvenObservability.flush(5_000);
const health = ElvenObservability.health();

await ElvenObservability.shutdown(5_000);
```

Flush/shutdown return `delivered`, `dropped`, `pending`, and `timedOut`. Background flush is best effort because Android and iOS may suspend JavaScript immediately. Keep persistence enabled instead of delaying UI or termination.

`health()` exposes SDK state, native availability, queue count/bytes, drops, transport failures, circuit state, and last successful export time.

## Diagnostics

Diagnostics are off by default and should normally stay off in production:

```ts
diagnostics: {
  enabled: !isProduction,
  verbose: false,
  sink: (message, context) => integrationLogger(message, context),
},
```

Messages are actionable, rate-limited, text-redacted, context-bounded, contain no OTLP payload or Collector header, and isolate a throwing sink. Do not route the sink into a console/logger that the SDK intercepts.

## Configuration by environment

Use explicit application configuration, not a secret-bearing public bundle variable:

```ts
const production = releaseChannel === 'production';

ElvenObservability.initialize({
  serviceName: 'customer-mobile-app',
  version: appVersion,
  environment: production ? 'production' : 'staging',
  collector: {
    endpoint: production
      ? 'https://otel.example.com'
      : 'https://otel-staging.example.com',
  },
  sampling: {
    traceRatio: production ? 0.05 : 1,
  },
  diagnostics: production ? false : { enabled: true },
});
```

The native app version/build, platform, OS, device model, and app bundle ID are added when the native module is available. No hardware advertising identifier is collected.

## Validate telemetry

The repository includes an executable Expo app and pinned Collector:

```sh
docker compose -f example/docker-compose.yml up
yarn example expo prebuild
yarn example android
```

Use `http://10.0.2.2:4318` from an Android emulator and `http://localhost:4318` from an iOS simulator. Trigger **Run correlated checkout**, **Handled exception**, **Custom metrics**, and **Flush telemetry**.

Acceptance requires:

1. logs, metrics, and traces reach the Collector;
2. checkout log and spans share trace/span correlation;
3. metric exemplars contain trace context without trace-ID labels;
4. service, environment, app/build, platform, and screen metadata are present;
5. raw user/tenant IDs, query strings, bodies, authorization, and tokens are absent;
6. Collector calls do not recursively create HTTP spans;
7. offline telemetry stays bounded and drains after recovery;
8. application behavior remains normal when the Collector rejects or times out.

See [VALIDATION.md](VALIDATION.md) for the exact evidence versus pending device/end-to-end gates.

## Troubleshooting

### `nativeBridgeAvailable` is false

You are probably running Expo Go, have not rebuilt after installation, or autolinking/Codegen did not run. Use a Development Build or bare build, reinstall pods, clean the native build if needed, and rebuild the binary.

### No telemetry arrives

Check the exact `/v1/logs`, `/v1/metrics`, and `/v1/traces` paths; TLS trust; device-to-host routing; Collector listen address; gateway body limit; and `health()` queue/failure state. Enable bounded diagnostics outside production.

### HTTP spans exist but backend traces are disconnected

Add only the trusted API origin/path to `propagateTraceHeadersTo` and ensure the server accepts W3C `traceparent`. Context propagation is intentionally off by default.

### Logs after `await` lack correlation

Pass `{ context: span.context }` or wrap the logging call in `span.run`. Universal implicit Promise context is not claimed on Hermes.

### Duplicate telemetry

Initialize only once, use the singleton, and remove competing console/fetch/error instrumentation or direct OTel providers. Do not run the previous separate Elven mobile exporters alongside this SDK.

### Queue grows while Collector is healthy

Inspect TLS/auth, 429/5xx responses, endpoint paths, request-size limits, and Collector throttling. `health().circuitOpen` and `transportFailures` distinguish delivery failure from provider batching.

### iOS crash is not immediately visible

MetricKit controls diagnostic delivery. Validate on a real device or use Xcode's MetricKit payload simulation where supported. A successful simulator build does not prove real crash delivery.

### Local Android HTTP is blocked

Use a debug/Development Build, `10.0.2.2`, or `adb reverse`. Do not weaken production network security for local Collector convenience.

## Known limitations

- OpenTelemetry JS does not list React Native as an officially supported runtime; this package owns the adapter and pins tested versions.
- OpenTelemetry JS logs remain development status upstream.
- Implicit async context is synchronous-boundary based; explicit context is necessary after some `await` boundaries.
- Expo Go has no native module or durable native queue.
- Android native crashes are delivered on the next launch.
- iOS crash/performance telemetry depends on MetricKit timing and real-device availability.
- Background flush cannot be guaranteed after immediate suspension or termination.
- No HTTP request/response body capture exists by design.
- No automatic instrumentation of every third-party native networking stack is claimed. Fetch/XHR and customer native helper paths are supported.
- React Native Web is best effort and not part of the Android/iOS support contract.

## Documentation

- [Architecture and decisions](ARCHITECTURE.md)
- [API reference](docs/API.md)
- [Compatibility matrix](COMPATIBILITY.md)
- [Security and privacy](SECURITY.md)
- [Performance budgets](PERFORMANCE.md)
- [Collector integration](docs/COLLECTOR.md)
- [Custom native modules](docs/NATIVE_MODULES.md)
- [Migration and rollback](MIGRATION.md)
- [Validation evidence](VALIDATION.md)
- [Release process](RELEASING.md)
- [Example application](example/README.md)
- [Changelog](CHANGELOG.md)

## Development

```sh
yarn install --immutable
yarn lint
yarn typecheck
yarn test:coverage
yarn build
yarn benchmark
yarn size
yarn pack:check
```

`yarn validate` runs the publish-facing JavaScript, benchmark, bundle, and package gates. Native release and end-to-end gates remain separate because successful compilation is not runtime proof.

## License

Apache License 2.0. See [LICENSE](LICENSE).
