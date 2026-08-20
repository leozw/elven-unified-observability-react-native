# Architecture

This document records the architecture of `elven-unified-observability-react-native` as of 2026-08-20.

## Design priorities

Decisions are evaluated in this order:

1. Never block or crash the host application.
2. Preserve security and privacy.
3. Preserve telemetry correctness and correlation.
4. Keep CPU, memory, storage, network, and bundle impact bounded.
5. Minimize integration work.
6. Expand automatic collection only when the previous properties remain true.

## Runtime topology

```text
Application code
  |
  |  ElvenObservability public facade
  v
Sanitizer + bounded dynamic context + automatic instrumentations
  |
  |  one Resource, one tracer provider, one logger provider, one meter provider
  v
OpenTelemetry JS SDK 2.10 / OTLP transformer 0.221
  |
  |  OTLP/HTTP JSON batches, no direct Loki/Mimir/Tempo credentials
  v
Bounded durable transport
  |
  |  retry + jitter + timeout + circuit breaker + backpressure
  v
Customer-controlled OpenTelemetry Collector
  |
  +--> logs backend
  +--> metrics backend
  +--> traces backend

Android/iOS runtime
  |
  +--> lifecycle, first frame, slow/frozen frames, memory, ANR/hang
  +--> delayed native crash diagnostics
  +--> private bounded persistence
  +--> native event bridge into the same JS providers and transport
```

There is deliberately one export pipeline. Native code does not create a second exporter, store Collector authentication, or send telemetry independently. This prevents duplicate signals, conflicting sampling, and credentials crossing into the crash-safe persistence path.

## Layers

### Public TypeScript facade

`ElvenObservability` is a process singleton. `ElvenObservabilitySdk` is exported for isolation in tests or advanced multi-runtime hosts. Calls made before initialization or after shutdown are safe no-ops.

The public API is grouped into `logs`, `metrics`, `traces`, and `context`, with top-level operations for initialization, exceptions, business events, screen context, flush, shutdown, and health.

### Sanitization and privacy

All public attributes, messages, exception stacks, event names, metric names, URLs, and selected headers pass through bounded sanitization before reaching OpenTelemetry. Sensitive key matching, value truncation, count limits, URL query removal, non-finite number handling, and circular object handling happen at this boundary.

User and tenant identifiers are pseudonymized by default. The hash namespace includes service namespace, service name, environment, and identity kind to avoid cross-service linkage. This is pseudonymization, not anonymization; clients must still avoid email addresses and other PII as identifiers.

### OpenTelemetry providers

The SDK uses a shared OpenTelemetry Resource and independent in-process providers:

- `BasicTracerProvider` with parent-based ratio sampling and bounded span limits;
- `LoggerProvider` with a batch processor and correlated trace/span IDs;
- `MeterProvider` with periodic export and cardinality limits.

OpenTelemetry JavaScript documents Node.js and browser runtimes, not React Native as an officially supported runtime. The adapter therefore supplies the runtime compatibility layer, a Hermes-safe UTF-8 codec, a performance time origin fallback, a stack context manager, fetch/XHR integration, native metadata, and release-build validation.

### Metric exemplars

Stable OpenTelemetry JS metrics do not currently expose a complete public exemplar pipeline for this React Native use case. The SDK keeps a bounded registry of sampled metric observations and injects valid trace/span exemplar fields into the official OTLP JSON produced by `@opentelemetry/otlp-transformer`.

Trace IDs are never converted into metric labels. If transformer output changes incompatibly, exemplar enrichment fails open and metrics still export without exemplars. Exact package versions are pinned and the transformed payload is covered by tests.

### Durable transport

The transport accepts already-sanitized OTLP JSON batches and stores only:

- signal type;
- payload;
- byte length and priority;
- enqueue, retry, and attempt metadata.

Collector headers are held only in JS memory. They are never written to native persistence or emitted as telemetry.

Queue bounds are enforced by item count, total UTF-8 bytes, individual payload bytes, and age. When full, the oldest lowest-priority batch is evicted. Critical signals use higher priority. Permanent HTTP failures are dropped; transient failures use exponential backoff with jitter. Repeated transient failures open a time-bounded circuit breaker.

The queue is stored in the application's private no-backup area. iOS additionally uses atomic writes and file protection. Persistence failure degrades to an in-memory queue.

## Context propagation

### JavaScript synchronous boundaries

`StackContextManager` preserves context while a synchronous callback executes. `span.run(fn)`, `context.run(ctx, fn)`, and `context.bind(ctx, value)` activate context for code started inside that boundary.

Hermes does not provide Node.js `AsyncLocalStorage`, and patching every Promise is unsafe. Context is therefore not promised to remain implicitly active after every `await`. Use one of these patterns:

```ts
const span = ElvenObservability.traces.startSpan('checkout');
try {
  const response = await span.run(() => fetch(url));
  span.run(() => {
    ElvenObservability.logs.info('done', {}, { context: span.context });
  });
} finally {
  span.end();
}
```

or pass `{ context: span.context }` explicitly to logs and metrics after an asynchronous boundary.

`withSpan` correctly ends and marks asynchronous operations, but explicit context is still required for work started after an `await` if that work must be a child of the span.

### HTTP

Fetch and XHR create client spans automatically. W3C `traceparent`/`tracestate` headers are injected only when the destination matches `propagateTraceHeadersTo` by exact origin and path boundary. An empty allow-list captures spans without sending context. Collector URLs are always ignored to prevent recursion.

### Native boundary

While `span.run` invokes a native module, the current trace and span IDs are made available through:

- Android: `ElvenNativeObservability.captureTraceContext()`;
- iOS: `[ElvenNativeObservability captureTraceContext]`.

Synchronous native events can use the current context directly. Asynchronous native work must capture the immutable native context at start and pass it back when recording the later event. This avoids a process-global context leaking across concurrent operations.

## Automatic instrumentation ownership

- Fetch and XHR wrappers preserve original behavior and are restored at shutdown.
- Console interception is level-selective, can preserve the original console, and ignores its own diagnostics.
- JavaScript fatal interception is installed only when React Native exposes the previous fatal handler. The previous handler is always called.
- Unhandled rejections use the event listener API when present and chain the existing fallback handler otherwise.
- JS AppState and native lifecycle signals are deduplicated by semantic ownership rather than exported through separate pipelines.
- Android uncaught exceptions are atomically persisted and delivered on the next launch before the platform's previous crash handler runs.
- iOS uses MetricKit for system-supported crash, hang, launch, and performance diagnostics. Delivery can be delayed and must be validated on a real device.

## Failure model

Every telemetry boundary is fail-open:

- invalid configuration returns a no-op SDK unless `strictInitialization` is enabled;
- exporter and storage failures do not throw into application work;
- automatic wrappers preserve the original function and exception path;
- diagnostics are rate-limited and isolate a failing custom sink;
- force flush and shutdown are bounded by timeouts;
- background flush is best effort because mobile operating systems may suspend JavaScript immediately.

`health()` exposes bounded queue and transport state so the host can diagnose delivery without turning on verbose logs.

## Decisions and sources

- React Native 0.87.0 was the latest stable release on 2026-08-20; 0.86.2 remains the version targeted by Expo SDK 57. The root toolchain and Expo example intentionally cover both lines.
- React Native New Architecture has been enabled by default since 0.76, and Codegen is the supported typed bridge generation path.
- OpenTelemetry JS traces and metrics are stable; its logs SDK remains development status. Exact compatible stable/experimental versions are pinned together.
- Expo Go cannot add arbitrary native modules. It receives the safe JS-only path; Development Builds and bare apps receive the full native path.
- MetricKit is Apple's supported source of daily performance reports and crash/hang diagnostics. Unsafe process signal interception is intentionally not implemented.

Primary references:

- [React Native 0.87 release](https://github.com/react/react-native/releases/tag/v0.87.0)
- [React Native New Architecture](https://reactnative.dev/architecture/landing-page)
- [React Native Codegen](https://reactnative.dev/docs/the-new-architecture/what-is-codegen)
- [Expo SDK version matrix](https://docs.expo.dev/versions/latest/)
- [Expo Development Builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [OpenTelemetry JavaScript status](https://opentelemetry.io/docs/languages/js/)
- [OpenTelemetry JS 2.10 release](https://github.com/open-telemetry/opentelemetry-js/releases/tag/v2.10.0)
- [Apple MetricKit](https://developer.apple.com/documentation/metrickit)
- [OpenTelemetry security guidance](https://opentelemetry.io/docs/security/)

## Explicit non-goals

- No direct Loki, Mimir, Tempo, or vendor-specific exporter.
- No static long-lived secret embedded in the package or example.
- No HTTP body, cookie, authorization, credential, hardware identifier, or raw user identity collection by default.
- No Promise monkey patch or claim of universal implicit async context.
- No unsafe iOS signal handler that allocates memory or performs network I/O during a crash.
- No guarantee that mobile operating systems allow telemetry delivery after termination or immediate suspension.
