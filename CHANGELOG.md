# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [0.3.0] - 2026-08-31

### Added

- Extended React Native 0.79 compatibility across published patches 0.79.0-0.79.7 with Hermes on Android and iOS.
- Declared Legacy Architecture support for the React Native 0.79.x compatibility lane while preserving the New Architecture path.
- External-package Android and iOS Release matrices for 0.79.0, customer version 0.79.2, and 0.79.7, including Legacy/New Architecture boundaries.
- Android Release emulator gate that proves the native bridge is available on React Native 0.79.2 Legacy Architecture.

### Changed

- Widened the React Native peer range from `>=0.79.7 <0.80.0` to `>=0.79.0 <0.80.0` without opening unvalidated React Native 0.80-0.85 lines.
- Reused the existing typed Codegen module and fail-open JS pipeline for Legacy interop instead of introducing a second native implementation.

## [0.2.0] - 2026-08-20

### Added

- Extended compatibility lane for React Native 0.79.7 with React 19.0, Hermes, and the New Architecture.
- External-package Android and iOS Release gates for the React Native 0.79.7 consumer template.
- Backward-compatible iOS module registration without changing the New Architecture path.

### Changed

- Narrowed the peer declaration into explicitly tested React Native ranges instead of implying support for unvalidated intermediate minors.

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
- Generation-guarded native initialization and shutdown so stale Android/iOS lifecycle, frame, ANR/hang, and MetricKit callbacks cannot survive a newer SDK lifecycle.
- Bundled Apple privacy manifest with conservative data-use declarations, no tracking, and elapsed-time required-reason coverage, verified inside Expo and bare Release apps.

### Known limitations

- Implicit trace context is synchronous on Hermes; work started after `await` needs `span.run` or explicit context.
- Expo Go cannot provide native signals or durable native persistence.
- iOS native crash/performance diagnostics depend on MetricKit delivery and real-device behavior.
- Android built-in crash persistence covers uncaught Java/Kotlin/JVM exceptions, not NDK/POSIX signal crashes.
- Background flush is best effort because Android/iOS may suspend JavaScript immediately.
