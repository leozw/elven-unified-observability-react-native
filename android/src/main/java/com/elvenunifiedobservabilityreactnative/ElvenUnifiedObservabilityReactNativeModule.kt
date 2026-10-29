package com.elvenunifiedobservabilityreactnative

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

class ElvenUnifiedObservabilityReactNativeModule(
  private val reactContext: ReactApplicationContext
) : NativeElvenUnifiedObservabilityReactNativeSpec(reactContext) {
  private val http = ElvenHttpTransport(reactContext)

  override fun sendHttp(sessionId: String, requestId: String, endpoint: String, headersJson: String, body: String, timeoutMillis: Double, promise: Promise) {
    http.send(sessionId, requestId, endpoint, headersJson, body, timeoutMillis, promise)
  }

  override fun abortHttp(sessionId: String, requestId: String) { http.abort(sessionId, requestId) }

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
    http.closeAll()
    promise.resolve(ElvenNativeRuntime.shutdown())
  }

  override fun invalidate() { http.closeAll(); super.invalidate() }

  override fun closeSession(sessionId: String, purge: Boolean, promise: Promise) {
    http.close(sessionId)
    ElvenNativeRuntime.closeSession(reactContext, sessionId, purge) { closed -> promise.resolve(closed) }
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
