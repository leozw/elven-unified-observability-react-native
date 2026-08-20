# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [0.1.0] - 2026-08-20

### Added

- Unified OTLP/HTTP JSON pipeline for logs, metrics, traces, errors, native events, and business events.
- Correlated structured logging, trace-aware metric exemplars, manual spans, W3C context inject/extract, and dynamic user/tenant/session/business/navigation context.
- Automatic fetch, XHR, console, global JavaScript error, unhandled rejection, AppState, native lifecycle, first-frame, frame-jank, ANR/hang, memory-pressure, and native crash diagnostics.
- Typed Turbo Native Module for React Native New Architecture with Android Kotlin and iOS Objective-C++ implementations.
- Expo Go JS-only fail-open behavior and full Expo Development Build/bare React Native support.
- Bounded durable private queue, priority backpressure, retry with jitter, timeout, circuit breaker, offline recovery, flush, shutdown, and health API.
- Default redaction, URL/header privacy controls, scoped user/tenant pseudonymization, size/cardinality limits, and production HTTPS enforcement.
- Native context snapshots for asynchronous Kotlin/Java and Objective-C/Swift module correlation.
- Executable Expo 57 demo and pinned OpenTelemetry Collector 0.158.0 local stack.
- Unit/integration/public API tests, coverage gates, CPU/memory/network benchmarks, bundle budgets, Android/iOS release CI, package checks, and npm provenance release workflow.
- Explicit ESM package contract with Publint and Are The Types Wrong publication gates.
- Scoped Android/iOS local-network policy for the Collector demo and bare React Native 0.87 Android/iOS release consumers in CI.

### Known limitations

- Implicit trace context is synchronous on Hermes; work started after `await` needs `span.run` or explicit context.
- Expo Go cannot provide native signals or durable native persistence.
- iOS native crash/performance diagnostics depend on MetricKit delivery and real-device behavior.
- Background flush is best effort because Android/iOS may suspend JavaScript immediately.
