# Validation evidence

This file records the evidence for release candidate `0.2.0` on 2026-08-20. Static, emulator, real-device, and backend proof are intentionally reported separately.

## Static and local JavaScript

| Gate                              | Command                              | Result                                                                                                     |
| --------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Immutable install                 | `yarn install --immutable`           | Passed with only upstream Expo-internal peer notices                                                       |
| Full release validation           | `yarn validate`                      | Passed locally: formatting, lint, types, tests, build, Codegen, audit, budgets, package lint, and dry pack |
| Unit/integration/public API tests | `yarn test:coverage`                 | 57 tests passed in 10 suites                                                                               |
| Coverage                          | same                                 | 86.84% statements, 75.27% branches, 91.60% functions, 89.46% lines                                         |
| Dependency audit                  | `yarn security:audit`                | Passed; no high-or-higher audit suggestions                                                                |
| Package contracts                 | `yarn package:lint`                  | Publint 0.3.24 passed; ATTW 0.18.5 passed under the declared ESM-only profile                              |
| CPU/memory/network budgets        | `yarn benchmark`                     | Passed; see `PERFORMANCE.md`                                                                               |
| Bundle budgets                    | `yarn size`                          | Passed; see `PERFORMANCE.md`                                                                               |
| Workflow syntax                   | `actionlint .github/workflows/*.yml` | Passed                                                                                                     |

An actual npm tarball was created with scripts disabled and installed into a clean external consumer. Its manifest/exports resolved, its public import bundled successfully with esbuild, and `npm ls` resolved version `0.2.0`. The inspected tarball contained 196 files, was 184.0 kB compressed and 744.6 kB unpacked, included the Apple privacy manifest and customer documentation, and excluded tests, fixtures, examples, local artifacts, environment files, and credentials.

A source and publish-surface scan found no JWT, npm/GitHub token, AWS access key, private key, `.env`, certificate, provisioning profile, or signing key. The vendored Yarn binary was excluded from entropy-style text matching and is covered by immutable repository review.

## Generated and native builds

| Gate                                          | Result                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| React Native 0.87 Android+iOS library Codegen | Passed for both platforms                                                                                                        |
| Expo SDK 57 / RN 0.86.2 Android prebuild      | Passed; local Collector network policy generated as declared                                                                     |
| Expo SDK 57 / RN 0.86.2 iOS prebuild          | Passed without pod installation; Hermes project and local-network ATS key generated                                              |
| Expo Android Release                          | Passed with New Architecture, Hermes, Codegen, Kotlin/Java, CMake, lint vital, and APK packaging                                 |
| Bare RN 0.87 Android Release from tarball     | Passed: external install, TypeScript, autolinking, Codegen, Metro 0.87, Hermes, four Android ABIs, lint vital, and APK packaging |
| Expo web production export                    | Passed; JS-only fallback bundled                                                                                                 |
| Expo iOS Release simulator                    | Passed on GitHub-hosted macOS with Xcode 26.4.1: prebuild, CocoaPods, Hermes, Codegen, native SDK, and Release simulator build   |
| Bare RN 0.87 iOS Release simulator            | Passed from the packed external SDK: install, TypeScript, CocoaPods, Codegen, native SDK, and Release simulator build            |
| Apple privacy manifest                        | `plutil` passed locally; CI verifies the pod resource bundle inside both Expo and bare Release apps                              |

The latest complete green release matrix is [GitHub Actions run 32403735838](https://github.com/leozw/elven-unified-observability-react-native/actions/runs/32403735838). All seven jobs passed: quality/package, Collector OTLP smoke, web fallback, Expo Android/iOS Release, and bare RN 0.87 Android/iOS Release. Both iOS jobs also located and linted the bundled SDK privacy manifest in their Release products. The tag workflow reruns this reusable matrix before publication.

## React Native 0.79.7 extended compatibility

This evidence applies to release candidate `0.2.0`. The previous `0.1.0` peer range rejects React 19.0 used by React Native 0.79.7.

| Gate                                              | Result                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Standard tarball install                          | Passed without `--force` or `--legacy-peer-deps`; npm resolved React 19.0.0 and React Native 0.79.7                   |
| TypeScript and public API                         | Passed in an external RN 0.79.7 application                                                                           |
| Autolinking                                       | Passed; Android package and iOS podspec were discovered                                                               |
| Android New Architecture Release                  | Passed with Hermes, Metro 0.82.5, Codegen, four Android ABIs, lint vital, and APK packaging                           |
| Android New Architecture runtime                  | Passed on an Android 16 emulator; cold Release launch completed and `nativeBridgeAvailable` reported `true`           |
| Android Legacy Architecture exploratory runtime   | Build and Release runtime passed with `nativeBridgeAvailable` equal to `true`; this mode remains outside the contract |
| iOS New Architecture Release                      | Covered by the dedicated macOS 15 / Xcode 16.4 external-tarball CI gate                                               |
| Physical Android/iOS and customer Collector proof | Not executed                                                                                                          |

React Native 0.79 is unsupported upstream. The extended range is therefore pinned to final patch 0.79.7 and excludes 0.80-0.85 rather than implying untested compatibility.

## Runtime proof

| Gate                                 | Result                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Android emulator, Expo Release APK   | Passed on Android 16 / API 36 arm64 emulator                                                                                          |
| Cold launch and process stability    | Passed; observed cold launches from 0.929 s to 1.725 s during connected runs and the process remained alive                           |
| Native bridge/runtime events         | Passed; native bridge available, first-frame and frame summaries received                                                             |
| Correlated manual operation          | Passed; parent span, automatic fetch child, logs, and metric exemplars correlated                                                     |
| Collector unavailable then recovered | Passed in the same process; queue moved from 3 items / 10.1 KiB and open circuit to 0 items / 0 B and closed circuit, with zero drops |
| Android runtime error scan           | Passed; no `AndroidRuntime`, `ReactNativeJS`, or Elven error entries after the correlated run                                         |
| iOS simulator interaction            | Not executed; full Xcode is unavailable locally                                                                                       |
| Android real device                  | Not executed                                                                                                                          |
| iOS real device                      | Not executed                                                                                                                          |
| Android crash next-launch delivery   | Unit/build proof only; destructive runtime crash proof remains pending                                                                |
| iOS MetricKit diagnostics            | Implementation/Codegen proof only; real-device or Xcode simulated payload proof remains pending                                       |

Headless emulator timing is not a control-versus-instrumented performance benchmark. It proves release behavior and signal delivery only.

## End-to-end telemetry proof

The Expo Release APK exported to the pinned OpenTelemetry Collector `0.158.0` over OTLP/HTTP JSON. The detailed acceptance run observed:

- service `elven-react-native-demo`, SDK `0.1.0`, Hermes, Android/app/build/emulator resource metadata;
- checkout trace `b7906d51565bcbe60d73618b6dcd80b9`;
- both checkout logs with parent span `d8454f770211317e`;
- automatic `HTTP GET` child span `366c6913e9243557`, sanitized URL, and status 200;
- `checkout.attempt.count` exemplar with the parent trace/span;
- HTTP metric exemplars with the same trace and automatic child span;
- no trace IDs converted into metric attributes;
- pseudonymized user/tenant values and no body, authorization value, token, or URL query string;
- queue `0`, drops `0`, transport failures `0`, and closed circuit after the connected run.

The separate offline run proved durable delivery after recovery. Collector logs contained the queued event IDs once; cumulative metric exports are expected OpenTelemetry temporality, not duplicated events.

Local screenshots, Collector output, benchmark JSON, and bundle reports are generated under ignored `artifacts/`. CI uploads reproducible package, coverage, benchmark, bundle, Android, iOS, and web artifacts for each run.

## Remaining acceptance gates

Before a broad customer rollout, run release builds on representative physical Android and iOS devices, exercise native crash/MetricKit delivery, compare control versus instrumented CPU/memory/energy/radio/binary size, and validate the customer's TLS, authentication, tenancy, quotas, sampling, and final observability backends. Publication or CI compilation cannot substitute for those rollout gates.

## CI interpretation

CI proves repeatable source, package, Codegen, Collector, and native release compilation in its declared environments. It does not prove OEM behavior, physical iOS behavior, production networks, customer Collector authentication, or backend retention/query behavior. Those remain deployment acceptance evidence.
