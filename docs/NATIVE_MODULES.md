# Custom native module correlation

The SDK exposes a small native helper for customer-owned Kotlin/Java and Objective-C/Swift modules. It does not export directly; events return through the shared JS OpenTelemetry pipeline.

## Required JS boundary

Start native work inside an active span:

```ts
const span = ElvenObservability.traces.startSpan('biometric.verify');
try {
  const result = await span.run(() => NativeBiometric.verify());
  span.setStatus({ code: SpanStatusCode.OK });
  return result;
} finally {
  span.end();
}
```

`span.run` publishes the IDs only for the synchronous native invocation. A native module that schedules asynchronous work must capture the immutable context before returning.

## Android / Kotlin

```kotlin
import com.elvenunifiedobservabilityreactnative.ElvenNativeObservability

fun verify(promise: Promise) {
  val parent = ElvenNativeObservability.captureTraceContext()
  val startedAt = SystemClock.elapsedRealtime()

  executor.execute {
    try {
      performVerification()
      val duration = SystemClock.elapsedRealtime() - startedAt
      if (parent != null) {
        ElvenNativeObservability.recordEvent(
          type = "performance",
          name = "biometric.verify",
          traceContext = parent,
          durationMillis = duration,
          attributes = mapOf("biometric.result" to "success")
        )
      }
      promise.resolve(true)
    } catch (error: Throwable) {
      if (parent != null) {
        ElvenNativeObservability.recordEvent(
          type = "error",
          name = "biometric.verify.failed",
          traceContext = parent,
          attributes = mapOf("exception.type" to error.javaClass.name)
        )
      }
      promise.reject("VERIFY_FAILED", error)
    }
  }
}
```

Java can use `ElvenNativeTraceContext`, `captureTraceContext()`, and the generated `recordEvent` overloads.

## iOS / Swift

The public Objective-C header is available to Swift through the generated module/import path:

```swift
import ElvenUnifiedObservabilityReactNative

func verify(resolve: @escaping RCTPromiseResolveBlock,
            reject: @escaping RCTPromiseRejectBlock) {
  let parent = ElvenNativeObservability.captureTraceContext()
  let startedAt = CACurrentMediaTime()

  queue.async {
    let success = self.performVerification()
    let duration = (CACurrentMediaTime() - startedAt) * 1000
    if let parent {
      ElvenNativeObservability.recordEvent(
        withType: success ? "performance" : "error",
        name: success ? "biometric.verify" : "biometric.verify.failed",
        durationMillis: NSNumber(value: duration),
        attributes: ["biometric.result": success ? "success" : "failure"],
        traceContext: parent
      )
    }
    resolve(success)
  }
}
```

For Objective-C, import `<ElvenUnifiedObservabilityReactNative/ElvenNativeObservability.h>`.

## Event contract

Allowed event types are `crash`, `error`, `lifecycle`, `performance`, and `memory`; unknown values become `error`. Event names, durations, values, stacks, nested objects, arrays, and total attributes are bounded and sanitized natively. Sensitive keys and common credential/PII text patterns are redacted before an event enters the JS runtime or durable storage.

Do not send request/response bodies, credentials, biometric material, hardware identifiers, raw user identity, or free-form customer data. Use stable low-cardinality names and attributes.

If no context exists, record an uncorrelated event through the overload without a trace context. Never retain or mutate the process-global context yourself.
