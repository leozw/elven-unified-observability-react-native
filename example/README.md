# Example application

This Expo 57 Development Build exercises the public API, JS automatic instrumentation, and Android/iOS native module.

## Collector

```sh
docker compose -f example/docker-compose.yml up
```

The app defaults to `http://10.0.2.2:4318` on the Android emulator and `http://localhost:4318` elsewhere. Override it at bundle time:

```sh
EXPO_PUBLIC_OTLP_ENDPOINT=http://192.168.1.20:4318 \
  yarn example start
```

The value is public application configuration. Never place a secret in an `EXPO_PUBLIC_*` variable.

The demo's config plugin denies Android cleartext globally and permits it only for `10.0.2.2` and `localhost`. Its iOS ATS configuration permits local networking only. These exceptions exist solely for the loopback Collector demo; use HTTPS and normal platform security policy in a customer build.

## Development Build

```sh
yarn example expo prebuild
yarn example android
# or
yarn example ios
```

Expo Go runs the JS-only fallback and reports `Native bridge: JS only`. Use a Development Build for native lifecycle, performance, crash diagnostics, and persistence.

## Scenarios

- **Structured log**: records a sanitized structured log.
- **Custom metrics**: records counter and gauge instruments.
- **Business event**: emits correlated span/log/counter telemetry.
- **Handled exception**: emits error span/log/metric without throwing into UI.
- **Run correlated checkout**: starts a manual parent span, invokes an automatically traced fetch, and records correlated logs/metrics.
- **Simulate network failure**: verifies a failed fetch span and safe application recovery.
- **Flush telemetry**: forces providers into the durable transport and reports delivery state.
- Screen tabs update navigation context and emit screen telemetry.

Watch Collector output for `elven-react-native-demo`. Raw `demo-user-42`, `demo-tenant`, authorization values, URL query strings, and bodies must not appear.
