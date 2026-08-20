# Migration and upgrades

## First adoption

This package is ESM-only. Use static `import` in React Native application code; do not load it with synchronous CommonJS `require()`.

1. Install the package.
2. Rebuild the native app; an OTA/JavaScript-only update cannot add the module.
3. Configure one OTLP/HTTP Collector base endpoint without a static long-lived secret.
4. Initialize before application work that should be automatically instrumented.
5. Add exact HTTP propagation destinations.
6. Integrate navigation callbacks or call `recordScreen` manually.
7. Add explicit spans/events only around business operations not visible to fetch/navigation/error instrumentation.
8. Validate privacy and all three signals in a non-production Collector before rollout.

## From Expo Go

The SDK intentionally initializes in Expo Go with JS-only capabilities. Moving to full collection requires an Expo Development Build or store build:

```sh
npx expo install expo-dev-client
npx expo prebuild
npx expo run:android
# or
npx expo run:ios
```

Configure Expo `runtimeVersion` so OTA updates that depend on a new native SDK version are not delivered to an older binary.

## From separate logging and tracing libraries

Remove direct mobile exporters and backend-specific credentials before enabling this package. Running two fetch/console/error instrumentations at the same time creates duplicate spans and logs.

Typical mapping:

| Previous operation               | Unified API                             |
| -------------------------------- | --------------------------------------- |
| logger debug/info/warn/error     | `ElvenObservability.logs.*`             |
| start/end trace                  | `traces.startSpan` or `traces.withSpan` |
| custom counter/gauge/histogram   | `metrics.*`                             |
| capture error                    | `captureException`                      |
| analytics-like operational event | `event`                                 |
| set user/tenant/session          | `context.setUser/setTenant/setSession`  |
| force export                     | `flush`                                 |

Keep product analytics consent and semantic ownership separate. This SDK's business events are operational telemetry and are subject to observability retention/security policy.

## Version upgrade procedure

1. Read `CHANGELOG.md` and the supported matrix in `COMPATIBILITY.md`.
2. Update the npm package with an exact version in regulated/reproducible applications.
3. Reinstall CocoaPods or run Expo prebuild as appropriate.
4. Produce Android and iOS release builds, not only debug builds.
5. Run the app with the target Collector unavailable, slow, rejecting, and healthy.
6. Confirm queue recovery, no duplicate global instrumentation, privacy policy, and signal correlation.
7. Ship through a staged rollout while monitoring app crash-free rate, ANR/hang, launch, memory, network bytes, SDK drops, and Collector rejects.

## Rollback

Configuration-level rollback can disable individual signals or instrumentations without removing the package:

```ts
signals: { logs: false, metrics: false, traces: false },
instrumentations: {
  console: false,
  network: false,
  errors: false,
  lifecycle: false,
},
```

Call `shutdown()` before switching configuration in a running process. A binary rollback is required to remove or downgrade native code. Keep the previous compatible store build available during staged adoption.

## Breaking-change policy

- Patch: compatible defect/security correction; a safer default may change when preserving the old default would expose data or break the host app.
- Minor: additive optional API/integration and supported runtime expansion.
- Major: incompatible public API, telemetry semantic, persistence schema, or platform range change.

Persisted queue schema changes must either migrate atomically or discard incompatible telemetry safely. They must never prevent application startup.
