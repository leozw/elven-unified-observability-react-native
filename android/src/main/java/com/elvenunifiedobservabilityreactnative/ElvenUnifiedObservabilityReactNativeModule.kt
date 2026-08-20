package com.elvenunifiedobservabilityreactnative

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

class ElvenUnifiedObservabilityReactNativeModule(
  private val reactContext: ReactApplicationContext
) : NativeElvenUnifiedObservabilityReactNativeSpec(reactContext) {

  override fun initialize(configurationJson: String, promise: Promise) {
    ElvenNativeRuntime.initialize(reactContext, configurationJson) { result ->
      promise.resolve(result)
    }
  }

  override fun drainEvents(promise: Promise) {
    promise.resolve(ElvenNativeRuntime.drainEvents())
  }

  override fun readPersistedQueue(promise: Promise) {
    ElvenNativeRuntime.readPersistedQueue { value -> promise.resolve(value) }
  }

  override fun writePersistedQueue(queueJson: String, promise: Promise) {
    ElvenNativeRuntime.writePersistedQueue(queueJson) { written -> promise.resolve(written) }
  }

  override fun clearPersistedQueue(promise: Promise) {
    ElvenNativeRuntime.clearPersistedQueue { cleared -> promise.resolve(cleared) }
  }

  override fun shutdown(promise: Promise) {
    promise.resolve(ElvenNativeRuntime.shutdown())
  }

  override fun setCurrentTraceContext(traceId: String, spanId: String) {
    ElvenNativeRuntime.setCurrentTraceContext(traceId, spanId)
  }

  override fun setDiagnosticsEnabled(enabled: Boolean) {
    ElvenNativeRuntime.setDiagnosticsEnabled(enabled)
  }

  companion object {
    const val NAME = NativeElvenUnifiedObservabilityReactNativeSpec.NAME
  }
}
