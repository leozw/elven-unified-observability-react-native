# Compatibility

## Supported application targets

| Target                                        | SDK behavior        | Native capabilities                                                               | Evidence gate                                                |
| --------------------------------------------- | ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| React Native 0.86.x, New Architecture, Hermes | Supported           | Android and iOS                                                                   | Expo 57 Android runtime plus Android/iOS Release CI          |
| React Native 0.87.x, New Architecture, Hermes | Supported           | Android and iOS                                                                   | External-tarball bare Android/iOS Release CI                 |
| Expo SDK 57 Development Build / EAS Build     | Supported           | Android and iOS after rebuild                                                     | Executable Expo Android runtime plus Android/iOS Release CI  |
| Expo SDK 57 prebuild/CNG                      | Full                | Autolinked by prebuild                                                            | Android and iOS `expo prebuild` validation                   |
| Expo Go                                       | JS-only fallback    | Native crash, ANR/hang, frame, device, and durable native storage are unavailable | JS fallback tests; native support is not claimed             |
| Bare React Native                             | Supported           | Autolinking and Codegen                                                           | RN 0.87 external-tarball Android/iOS Release CI              |
| React Native Web                              | Best-effort JS path | None                                                                              | Demo web build only; not part of the mobile support contract |

The npm peer range is deliberately limited to `react-native >=0.86.0 <0.88.0` and `react >=19.1.0 <20`. Older React Native lines, the Legacy Architecture, JavaScriptCore, Windows, macOS, visionOS, and tvOS are not declared supported.

`Supported` means the package, autolinking, Codegen, and native Release build contract passed in the declared matrix. Android runtime and correlated OTLP delivery were also exercised. iOS simulator interaction, physical-device behavior, and MetricKit delivery remain separate acceptance gates and are not implied by compilation.

## Platform prerequisites

| Component                           | Minimum / tested line                                  |
| ----------------------------------- | ------------------------------------------------------ |
| Node.js for installation and builds | `^22.13.0` or `>=24.3.0`                               |
| Android                             | API 24+, host compile SDK 36/37, Java 17               |
| iOS in bare React Native            | iOS 15.1+ as inherited from React Native 0.87          |
| iOS with Expo SDK 57                | iOS 16.4+ per Expo SDK 57                              |
| Xcode in bare React Native          | 16.1+ as inherited from React Native 0.87              |
| Xcode with Expo SDK 57              | 26.4+ per Expo SDK 57                                  |
| Kotlin                              | Host line (2.1.20/2.2.0 tested); fallback is 2.0.21    |
| OpenTelemetry JS                    | API 1.9.1, stable SDK 2.10.0, logs/transformer 0.221.0 |

## Capability matrix

| Capability                                 | Android            | iOS                      | Expo Go                |
| ------------------------------------------ | ------------------ | ------------------------ | ---------------------- |
| Structured logs, metrics, traces, events   | Yes                | Yes                      | Yes                    |
| Fetch and XHR spans                        | Yes                | Yes                      | Yes                    |
| W3C HTTP propagation with allow-list       | Yes                | Yes                      | Yes                    |
| JavaScript errors and unhandled rejections | Yes                | Yes                      | Yes, runtime dependent |
| AppState lifecycle                         | Yes                | Yes                      | Yes                    |
| Native lifecycle and app metadata          | Yes                | Yes                      | No                     |
| Process start and first frame              | Yes                | Yes                      | No                     |
| Slow/frozen frame summary                  | Yes                | Yes                      | No                     |
| Main-thread ANR/hang watchdog              | Yes                | Yes                      | No                     |
| Native crash diagnostics                   | JVM, next launch   | MetricKit delivery       | No                     |
| Native memory pressure                     | Yes                | Yes                      | No                     |
| Durable private queue                      | Yes                | Yes                      | Memory only            |
| Custom native module correlation           | Kotlin/Java helper | Objective-C/Swift helper | No                     |

## Expo operational rules

Installing this package changes native code. Expo applications must create a new Development Build or store build after installation or any SDK update that changes native code. An EAS Update cannot add or replace the native module in an already-installed binary. Use an appropriate Expo `runtimeVersion` policy to prevent incompatible updates.

Expo Go does not contain this package's native module. Initialization remains safe and useful, but `health().nativeBridgeAvailable` is `false`, persistence is in memory only, and native-only capabilities are absent.

## Compatibility policy

- Patch releases fix defects without intentionally changing public API behavior.
- Minor releases can add optional fields, integrations, and native signals while preserving defaults unless a security correction requires a safer default.
- Major releases can change public contracts or supported React Native ranges.
- Every new React Native or Expo line is added to the declared range only after its relevant static, Codegen, native build, and example gates pass.
- Runtime support is distinct from compilation. See [VALIDATION.md](VALIDATION.md) for the exact evidence available for the current checkout.
