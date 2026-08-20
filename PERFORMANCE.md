# Performance budgets

The SDK does not promise zero overhead. It enforces bounded defaults and measurable regression gates.

## Budgets

| Surface                                             |            CI budget | Default runtime control                                        |
| --------------------------------------------------- | -------------------: | -------------------------------------------------------------- |
| JS SDK initialization, Node harness p95             |                25 ms | Non-blocking native initialization; no startup network request |
| Correlated business event CPU, Node harness average |              0.25 ms | Batch processors and trace/log sampling                        |
| Retained JS heap after benchmark and shutdown       |                4 MiB | Bounded provider and transport queues                          |
| Serialized OTLP bytes per correlated event          |                2 KiB | Batching, sampling, no bodies/query by default                 |
| Largest benchmark OTLP request                      |              128 KiB | `queue.maxItemBytes`                                           |
| Minified SDK bundle                                 |          320 KiB raw | ESM and `sideEffects: false`                                   |
| Minified SDK bundle, gzip                           |               85 KiB | Exact bundle gate                                              |
| Minified SDK bundle, Brotli                         |               75 KiB | Exact bundle gate                                              |
| Durable JS queue                                    |              512 KiB | `queue.maxBytes`                                               |
| Persisted native safety ceiling                     |                5 MiB | Native corruption/abuse guard; JS default remains 512 KiB      |
| In-process provider queue                           | 512 records/provider | `batch.maxQueueSize`                                           |
| Export batch                                        |           64 records | `batch.maxExportBatchSize`                                     |
| Metrics interval                                    |           60 seconds | `batch.metricExportIntervalMillis`                             |
| Native event queue                                  |           128 events | Derived from queue item bound, capped at 256                   |

The Node harness stubs React Native native APIs and is a deterministic regression gate, not a substitute for device profiling. Device CPU, energy, launch, native memory, radio usage, and binary-size measurements must be collected on representative release builds before a broad rollout.

## Current local baseline

On 2026-08-20, Node 24.14.0 on darwin-arm64 measured:

| Measurement              |         Result |
| ------------------------ | -------------: |
| Startup median           |       0.248 ms |
| Startup p95              |       5.143 ms |
| Correlated event average |      0.0493 ms |
| Retained heap            |  396,176 bytes |
| OTLP bytes/event         | 1,635.18 bytes |
| Largest OTLP request     |   55,192 bytes |
| Production bundle raw    |  263,784 bytes |
| Production bundle gzip   |   71,403 bytes |
| Production bundle Brotli |   61,005 bytes |

These numbers are machine-specific. Run `npm run benchmark` and `npm run size` in the target checkout; CI uploads the generated JSON reports from `artifacts/`.

The Android Release emulator run additionally proved that the runtime queue stayed at `0 B` with a healthy Collector and drained from `10.1 KiB` to `0 B` after an offline interval. Those observations validate bounds and recovery, not CPU or memory overhead; a physical-device control build is still required for rollout performance acceptance.

## Production tuning

Recommended baseline for a high-volume production app:

```ts
sampling: {
  traceRatio: 0.05,
  logRatio: { debug: 0, info: 0.1, warn: 1, error: 1, fatal: 1 },
},
batch: {
  maxQueueSize: 256,
  maxExportBatchSize: 32,
  scheduledDelayMillis: 3_000,
  metricExportIntervalMillis: 60_000,
},
queue: {
  maxItems: 64,
  maxBytes: 256 * 1024,
  maxItemBytes: 64 * 1024,
},
privacy: {
  maxMetricCardinality: 100,
},
```

Errors, fatal logs, and native crash events are not ratio-dropped by the default log policy. Parent sampling preserves distributed trace decisions. A queue under sustained backpressure evicts older lower-priority batches rather than allowing memory to grow without bound.

## Device validation protocol

Use production minification, Hermes, release native builds, a real Collector, and diagnostics disabled. Compare a control build and an instrumented build on the same device and workload:

1. Measure cold/warm launch and first frame over at least 30 runs.
2. Record median and p95 CPU time for a scripted navigation/network scenario.
3. Record native and JS heap at idle, after load, after background/foreground, and after shutdown.
4. Measure app binary and JS bundle size deltas.
5. Measure uploaded bytes and request count under good, slow, offline, and recovered connectivity.
6. Measure energy/radio impact over a representative session.
7. Verify queue bounds and that app interactions remain responsive while the Collector is unavailable.

No device result is inferred from the Node benchmark. Current execution evidence is maintained in [VALIDATION.md](VALIDATION.md).
