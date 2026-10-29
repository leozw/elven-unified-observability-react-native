package com.elvenunifiedobservabilityreactnative

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.network.NetworkingModule
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import org.json.JSONObject

/** Status-only requests. Never replace an app client, dispatcher, TLS policy or global hook. */
internal class ElvenHttpTransport(private val context: ReactApplicationContext) {
  private data class Pending(val session: String, val call: Call, val promise: Promise)
  private val pending = mutableMapOf<String, Pending>()
  private val closed = linkedSetOf<String>()

  @Synchronized
  fun send(session: String, id: String, endpoint: String, headersJson: String, body: String, timeout: Double, promise: Promise) {
    try {
      check(ElvenNativeRuntime.isSessionActive(session) && !closed.contains(session))
      require(pending.size < 4 && !pending.containsKey(id) && id.length <= 128)
      require(endpoint.length <= 16_384 && headersJson.length <= 65_536 && body.length <= 4_194_304)
      require(timeout.isFinite() && timeout >= 1 && timeout <= 30_000)
      val networking = checkNotNull(context.getNativeModule(NetworkingModule::class.java))
      // RN has no public getter for its effective client or per-request security hook.
      // These two version-qualified accesses fail closed; consumer rules retain their names.
      val clientField = NetworkingModule::class.java.declaredFields.firstOrNull {
        it.name == "mClient" || it.name == "client"
      } ?: error("Unsupported RN HTTP client")
      clientField.isAccessible = true
      val builder = (clientField.get(networking) as OkHttpClient).newBuilder()
      val customField = NetworkingModule::class.java.getDeclaredField("customClientBuilder")
      customField.isAccessible = true
      (customField.get(null) as? CustomClientBuilder)?.apply(builder)
      val client = builder.cookieJar(CookieJar.NO_COOKIES).cache(null)
        .callTimeout(timeout.toLong(), TimeUnit.MILLISECONDS).build()
      val request = Request.Builder().url(endpoint)
      require(request.build().url().scheme() == "http" || request.build().url().scheme() == "https")
      val headers = JSONObject(headersJson)
      require(headers.length() <= 128)
      for (key in headers.keys()) request.header(key, headers.getString(key))
      val call = client.newCall(request.post(RequestBody.create(MediaType.parse("application/json"), body)).build())
      pending[id] = Pending(session, call, promise)
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) { finish(id, null) }
        override fun onResponse(call: Call, response: Response) {
          try {
            val result = JSONObject().put("status", response.code())
            response.header("Retry-After")?.let { result.put("retryAfter", if (it.length > 256) "9".repeat(257) else it) }
            // Cancel before close: do not drain or decode an arbitrary collector response.
            call.cancel()
            response.close()
            finish(id, result.toString())
          } catch (_: Exception) { call.cancel(); response.close(); finish(id, null) }
        }
      })
    } catch (_: Exception) {
      pending.remove(id)?.call?.cancel()
      promise.reject("ELVEN_HTTP_UNAVAILABLE", "Bounded native HTTP could not preserve the RN networking configuration.")
    }
  }

  @Synchronized private fun finish(id: String, result: String?) {
    val value = pending.remove(id) ?: return
    if (result != null && !closed.contains(value.session) && ElvenNativeRuntime.isSessionActive(value.session)) value.promise.resolve(result)
    else value.promise.reject("ELVEN_HTTP_CLOSED", "Telemetry HTTP failed or its owner closed.")
  }

  @Synchronized fun abort(session: String, id: String) {
    val value = pending[id] ?: return
    if (value.session != session) return
    pending.remove(id)
    value.call.cancel()
    value.promise.reject("ELVEN_HTTP_ABORTED", "Telemetry HTTP aborted.")
  }

  @Synchronized fun close(session: String) {
    closed.add(session)
    while (closed.size > 64) closed.remove(closed.first())
    for (id in pending.filterValues { it.session == session }.keys.toList()) abort(session, id)
  }

  @Synchronized fun closeAll() {
    for (session in pending.values.map { it.session }.distinct()) close(session)
  }
}
