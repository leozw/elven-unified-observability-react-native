package com.elvenunifiedobservabilityreactnative

data class ElvenNativeTraceContext(
  val traceId: String,
  val spanId: String
)

/** Native entry point for custom Kotlin or Java modules that need trace correlation. */
object ElvenNativeObservability {
  @JvmStatic
  fun currentTraceId(): String? = ElvenNativeRuntime.currentTraceContext()?.first

  @JvmStatic
  fun currentSpanId(): String? = ElvenNativeRuntime.currentTraceContext()?.second

  @JvmStatic
  fun captureTraceContext(): ElvenNativeTraceContext? =
    ElvenNativeRuntime.currentTraceContext()?.let { (traceId, spanId) ->
      ElvenNativeTraceContext(traceId, spanId)
    }

  @JvmStatic
  @JvmOverloads
  fun recordEvent(
    type: String,
    name: String,
    durationMillis: Long? = null,
    attributes: Map<String, Any?> = emptyMap()
  ) {
    ElvenNativeRuntime.recordExternalEvent(type, name, durationMillis, attributes)
  }

  @JvmStatic
  @JvmOverloads
  fun recordEvent(
    type: String,
    name: String,
    traceContext: ElvenNativeTraceContext,
    durationMillis: Long? = null,
    attributes: Map<String, Any?> = emptyMap()
  ) {
    ElvenNativeRuntime.recordExternalEvent(
      type,
      name,
      durationMillis,
      attributes,
      Pair(traceContext.traceId, traceContext.spanId)
    )
  }
}
