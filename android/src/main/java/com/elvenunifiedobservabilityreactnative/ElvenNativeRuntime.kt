package com.elvenunifiedobservabilityreactnative

import android.app.Activity
import android.app.Application
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.AtomicFile
import android.util.Log
import android.view.Choreographer
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableNativeArray
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max
import kotlin.system.exitProcess

internal object ElvenNativeRuntime {
  private const val TAG = "ElvenObservability"
  private const val QUEUE_FILE = "elven-observability-queue-v1.json"
  private const val CRASH_FILE = "elven-observability-native-crash-v1.json"
  private const val MAX_PERSISTED_QUEUE_BYTES = 5 * 1024 * 1024
  private const val MAX_EVENT_ATTRIBUTE_COUNT = 32
  private const val MAX_ATTRIBUTE_LENGTH = 1024
  private const val MAX_STACK_LENGTH = 8192
  private const val HEARTBEAT_MILLIS = 500L
  private const val ANR_THRESHOLD_MILLIS = 5000L
  private const val FRAME_REPORT_INTERVAL_MILLIS = 15_000L
  private const val SLOW_FRAME_MILLIS = 32.0
  private const val FROZEN_FRAME_MILLIS = 700.0

  private val authorizationValue =
    Regex("""\b(bearer|basic)\s+[a-z0-9._~+/=-]+""", RegexOption.IGNORE_CASE)
  private val credentialAssignment = Regex(
    """\b(password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)""",
    RegexOption.IGNORE_CASE
  )
  private val emailAddress = Regex(
    """\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b""",
    RegexOption.IGNORE_CASE
  )
  private val jwtValue = Regex(
    """\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b""",
    RegexOption.IGNORE_CASE
  )
  private val urlUserInfo = Regex(
    """\b([a-z][a-z0-9+.-]*://)[^@\s/:]+:[^@\s]+@""",
    RegexOption.IGNORE_CASE
  )

  private val eventLock = Any()
  private val fileLock = Any()
  private val events = ArrayDeque<String>()
  private val ioExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "elven-observability-io").apply { isDaemon = true }
  }
  private val traceContext = AtomicReference<Pair<String, String>?>(null)
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile private var application: Application? = null
  @Volatile private var initialized = false
  @Volatile private var generation = 0L
  @Volatile private var diagnosticsEnabled = false
  @Volatile private var maxEventQueueSize = 128
  @Volatile private var foreground = true
  @Volatile private var lastMainHeartbeat = SystemClock.elapsedRealtime()
  @Volatile private var anrReported = false

  private var lifecycleCallbacks: Application.ActivityLifecycleCallbacks? = null
  private var componentCallbacks: ComponentCallbacks2? = null
  private var crashHandler: CrashHandler? = null
  private var watchdogThread: HandlerThread? = null
  private var heartbeatRunnable: Runnable? = null
  @Volatile private var frameCallback: Choreographer.FrameCallback? = null
  private var startedActivities = 0
  private var processStartUnixMillis = System.currentTimeMillis()
  private var lastFrameNanos = 0L
  private var framePeriodStartedAt = 0L
  private var framePeriodStartedUnixMillis = 0L
  private var frameCount = 0L
  private var slowFrameCount = 0L
  private var frozenFrameCount = 0L
  private var maximumFrameMillis = 0.0
  private var firstFrameRecorded = false

  @Synchronized
  fun initialize(
    reactContext: ReactApplicationContext,
    configurationJson: String,
    callback: (String) -> Unit
  ) {
    val app = reactContext.applicationContext as? Application
    if (app == null) {
      callback(platformContext(reactContext).toString())
      return
    }
    stopInstrumentation()
    application = app
    val config = NativeConfig.parse(configurationJson)
    diagnosticsEnabled = config.diagnosticsEnabled
    maxEventQueueSize = config.maxEventQueueSize
    processStartUnixMillis = calculateProcessStartUnixMillis()
    initialized = true
    val activeGeneration = generation
    if (config.captureNativeCrashes) {
      restorePreviousCrash(app)
    } else {
      File(app.noBackupFilesDir, CRASH_FILE).delete()
    }
    if (config.captureLifecycle) startLifecycle(app, activeGeneration)
    if (config.captureNativeCrashes) startCrashHandler(app)
    if (config.captureAnr) startAnrWatchdog(activeGeneration)
    if (config.captureFrozenFrames) startFrameMonitor(activeGeneration)
    callback(platformContext(app).toString())
  }

  @Synchronized
  fun shutdown(): Boolean {
    stopInstrumentation()
    initialized = false
    traceContext.set(null)
    return true
  }

  fun setDiagnosticsEnabled(enabled: Boolean) {
    diagnosticsEnabled = enabled
  }

  fun setCurrentTraceContext(traceId: String, spanId: String) {
    traceContext.set(
      if (isTraceId(traceId) && isSpanId(spanId)) Pair(traceId, spanId) else null
    )
  }

  fun currentTraceContext(): Pair<String, String>? = traceContext.get()

  fun drainEvents(): WritableNativeArray {
    val output = WritableNativeArray()
    synchronized(eventLock) {
      while (events.isNotEmpty()) output.pushString(events.removeFirst())
    }
    return output
  }

  fun readPersistedQueue(callback: (String) -> Unit) {
    val app = application
    if (app == null) {
      callback("")
      return
    }
    ioExecutor.execute {
      callback(runCatching { readQueueFile(app) }.getOrDefault(""))
    }
  }

  fun writePersistedQueue(value: String, callback: (Boolean) -> Unit) {
    val app = application
    if (
      app == null ||
      value.toByteArray(StandardCharsets.UTF_8).size > MAX_PERSISTED_QUEUE_BYTES
    ) {
      callback(false)
      return
    }
    ioExecutor.execute {
      callback(runCatching { writeQueueFile(app, value) }.getOrDefault(false))
    }
  }

  fun clearPersistedQueue(callback: (Boolean) -> Unit) {
    val app = application
    if (app == null) {
      callback(false)
      return
    }
    ioExecutor.execute {
      callback(
        synchronized(fileLock) {
          val file = queueFile(app)
          !file.exists() || file.delete()
        }
      )
    }
  }

  fun recordExternalEvent(
    rawType: String,
    name: String,
    durationMillis: Long?,
    attributes: Map<String, Any?>,
    explicitTraceContext: Pair<String, String>? = null
  ) {
    val type = when (rawType.lowercase(Locale.ROOT)) {
      "crash", "error", "lifecycle", "performance", "memory" ->
        rawType.lowercase(Locale.ROOT)
      else -> "error"
    }
    val eventTraceContext = if (explicitTraceContext == null) {
      traceContext.get()
    } else {
      explicitTraceContext.takeIf { (traceId, spanId) ->
        isTraceId(traceId) && isSpanId(spanId)
      }
    }
    enqueueEvent(
      type,
      name,
      durationMillis,
      attributes,
      eventTraceContext = eventTraceContext
    )
  }

  private fun startLifecycle(app: Application, activeGeneration: Long) {
    val callbacks = object : Application.ActivityLifecycleCallbacks {
      override fun onActivityCreated(activity: Activity, state: Bundle?) {
        if (!isGenerationActive(activeGeneration)) return
        enqueueEvent(
          "lifecycle",
          "app.activity.created",
          attributes = mapOf("activity.name" to activity.javaClass.simpleName)
        )
      }

      override fun onActivityStarted(activity: Activity) {
        if (!isGenerationActive(activeGeneration)) return
        val wasBackground = !foreground
        startedActivities += 1
        if (startedActivities == 1) {
          foreground = true
          if (wasBackground) {
            lastFrameNanos = 0L
            framePeriodStartedAt = SystemClock.elapsedRealtime()
            framePeriodStartedUnixMillis = System.currentTimeMillis()
          }
          enqueueEvent("lifecycle", "app.foreground")
        }
      }

      override fun onActivityStopped(activity: Activity) {
        if (!isGenerationActive(activeGeneration)) return
        startedActivities = max(0, startedActivities - 1)
        if (startedActivities == 0 && !activity.isChangingConfigurations) {
          foreground = false
          flushFrameMetrics()
          enqueueEvent("lifecycle", "app.background")
        }
      }

      override fun onActivityResumed(activity: Activity) = Unit
      override fun onActivityPaused(activity: Activity) = Unit
      override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    }
    lifecycleCallbacks = callbacks
    app.registerActivityLifecycleCallbacks(callbacks)

    val memoryCallbacks = object : ComponentCallbacks2 {
      override fun onTrimMemory(level: Int) {
        if (!isGenerationActive(activeGeneration)) return
        enqueueEvent(
          "memory",
          "app.memory.trim",
          attributes = mapOf("memory.trim.level" to level)
        )
      }

      override fun onLowMemory() {
        if (!isGenerationActive(activeGeneration)) return
        enqueueEvent("memory", "app.memory.low")
      }

      override fun onConfigurationChanged(configuration: Configuration) = Unit
    }
    componentCallbacks = memoryCallbacks
    app.registerComponentCallbacks(memoryCallbacks)
  }

  private fun startCrashHandler(app: Application) {
    val handler = CrashHandler(app, Thread.getDefaultUncaughtExceptionHandler())
    crashHandler = handler
    Thread.setDefaultUncaughtExceptionHandler(handler)
  }

  private fun startAnrWatchdog(activeGeneration: Long) {
    lastMainHeartbeat = SystemClock.elapsedRealtime()
    anrReported = false
    val heartbeat = object : Runnable {
      override fun run() {
        if (!isGenerationActive(activeGeneration)) return
        lastMainHeartbeat = SystemClock.elapsedRealtime()
        if (anrReported) anrReported = false
        if (isGenerationActive(activeGeneration)) {
          mainHandler.postDelayed(this, HEARTBEAT_MILLIS)
        }
      }
    }
    heartbeatRunnable = heartbeat
    mainHandler.post(heartbeat)

    val thread = HandlerThread("elven-observability-anr").apply { start() }
    watchdogThread = thread
    val handler = Handler(thread.looper)
    val check = object : Runnable {
      override fun run() {
        if (!isGenerationActive(activeGeneration)) return
        val blockedMillis = SystemClock.elapsedRealtime() - lastMainHeartbeat
        if (foreground && blockedMillis >= ANR_THRESHOLD_MILLIS && !anrReported) {
          anrReported = true
          val stack = Looper.getMainLooper().thread.stackTrace
            .joinToString("\n")
            .take(MAX_STACK_LENGTH)
          enqueueEvent(
            "error",
            "app.anr",
            blockedMillis,
            mapOf("exception.stacktrace" to stack)
          )
        }
        if (thread.isAlive && isGenerationActive(activeGeneration)) {
          handler.postDelayed(this, 1000L)
        }
      }
    }
    handler.postDelayed(check, 1000L)
  }

  private fun startFrameMonitor(activeGeneration: Long) {
    mainHandler.post {
      if (!isGenerationActive(activeGeneration)) return@post
      framePeriodStartedAt = SystemClock.elapsedRealtime()
      framePeriodStartedUnixMillis = System.currentTimeMillis()
      val callback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
          if (
            !isGenerationActive(activeGeneration) ||
            frameCallback !== this
          ) return
          if (lastFrameNanos == 0L) {
            if (!firstFrameRecorded) {
              firstFrameRecorded = true
              val duration = max(
                0L,
                System.currentTimeMillis() - processStartUnixMillis
              )
              enqueueEvent(
                "performance",
                "app.first_frame",
                duration,
                timestampUnixMillis = processStartUnixMillis
              )
            }
          } else {
            val frameMillis = (frameTimeNanos - lastFrameNanos) / 1_000_000.0
            frameCount += 1
            if (frameMillis >= SLOW_FRAME_MILLIS) slowFrameCount += 1
            if (frameMillis >= FROZEN_FRAME_MILLIS) frozenFrameCount += 1
            maximumFrameMillis = max(maximumFrameMillis, frameMillis)
          }
          lastFrameNanos = frameTimeNanos
          if (
            SystemClock.elapsedRealtime() - framePeriodStartedAt >=
            FRAME_REPORT_INTERVAL_MILLIS
          ) {
            flushFrameMetrics()
          }
          if (
            frameCallback === this &&
            isGenerationActive(activeGeneration)
          ) {
            Choreographer.getInstance().postFrameCallback(this)
          }
        }
      }
      frameCallback = callback
      Choreographer.getInstance().postFrameCallback(callback)
    }
  }

  private fun flushFrameMetrics() {
    val callback = frameCallback ?: return
    mainHandler.post {
      if (frameCallback !== callback) return@post
      val elapsed = max(0L, SystemClock.elapsedRealtime() - framePeriodStartedAt)
      if (frameCount > 0L && (slowFrameCount > 0L || frozenFrameCount > 0L)) {
        enqueueEvent(
          "performance",
          "app.frames",
          elapsed,
          mapOf(
            "frame.count" to frameCount,
            "frame.slow.count" to slowFrameCount,
            "frame.frozen.count" to frozenFrameCount,
            "frame.duration.max_ms" to maximumFrameMillis
          ),
          framePeriodStartedUnixMillis
        )
      }
      framePeriodStartedAt = SystemClock.elapsedRealtime()
      framePeriodStartedUnixMillis = System.currentTimeMillis()
      frameCount = 0L
      slowFrameCount = 0L
      frozenFrameCount = 0L
      maximumFrameMillis = 0.0
    }
  }

  private fun enqueueEvent(
    type: String,
    name: String,
    durationMillis: Long? = null,
    attributes: Map<String, Any?> = emptyMap(),
    timestampUnixMillis: Long = System.currentTimeMillis(),
    eventTraceContext: Pair<String, String>? = traceContext.get()
  ) {
    if (!initialized) return
    val event = org.json.JSONObject()
      .put("id", UUID.randomUUID().toString())
      .put("type", type)
      .put("name", redactText(name).take(128))
      .put("timestampUnixMillis", timestampUnixMillis)
    durationMillis?.let { event.put("durationMillis", max(0L, it)) }
    val sanitized = sanitizeAttributes(attributes)
    if (sanitized.length() > 0) event.put("attributes", sanitized)
    eventTraceContext?.let { (traceId, spanId) ->
      event.put("traceId", traceId)
      event.put("spanId", spanId)
    }
    synchronized(eventLock) {
      while (events.size >= maxEventQueueSize) events.removeFirst()
      events.addLast(event.toString())
    }
  }

  private fun sanitizeAttributes(attributes: Map<String, Any?>): org.json.JSONObject {
    val output = org.json.JSONObject()
    attributes.entries.take(MAX_EVENT_ATTRIBUTE_COUNT).forEach { (rawKey, rawValue) ->
      val key = rawKey.take(128)
      val value = if (isSensitiveKey(key)) "[REDACTED]" else sanitizeValue(rawValue)
      if (value != null) output.put(key, value)
    }
    return output
  }

  private fun sanitizeValue(value: Any?): Any? = when (value) {
    null -> null
    is Boolean, is Int, is Long, is Float, is Double -> value
    else -> redactText(value.toString()).take(MAX_ATTRIBUTE_LENGTH)
  }

  private fun redactText(value: String): String {
    var redacted = urlUserInfo.replace(value, "\$1[REDACTED]@")
    redacted = authorizationValue.replace(redacted, "\$1 [REDACTED]")
    redacted = jwtValue.replace(redacted, "[REDACTED]")
    redacted = credentialAssignment.replace(redacted, "\$1=[REDACTED]")
    return emailAddress.replace(redacted, "[REDACTED]")
  }

  private fun isSensitiveKey(key: String): Boolean {
    val normalized = key.lowercase(Locale.ROOT)
    return listOf(
      "authorization", "cookie", "password", "secret", "token", "api_key",
      "apikey", "client_secret", "credit_card", "card.number", "request.body",
      "response.body", "email", "phone", "cpf", "cnpj"
    ).any(normalized::contains)
  }

  private fun restorePreviousCrash(app: Application) {
    val file = File(app.noBackupFilesDir, CRASH_FILE)
    if (!file.exists()) return
    runCatching {
      val value = AtomicFile(file).openRead().bufferedReader().use { it.readText() }
      if (value.length <= MAX_PERSISTED_QUEUE_BYTES) {
        synchronized(eventLock) {
          while (events.size >= maxEventQueueSize) events.removeFirst()
          events.addLast(value)
        }
      }
    }
    file.delete()
  }

  private fun platformContext(context: Context): org.json.JSONObject {
    val packageInfo = runCatching {
      context.packageManager.getPackageInfo(context.packageName, 0)
    }.getOrNull()
    val versionCode = packageInfo?.let {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        it.longVersionCode
      } else {
        @Suppress("DEPRECATION")
        it.versionCode.toLong()
      }
    }
    return org.json.JSONObject()
      .put("platform", "android")
      .put("osVersion", Build.VERSION.RELEASE ?: "unknown")
      .put("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(128))
      .put("appVersion", packageInfo?.versionName ?: "0.0.0")
      .put("appBuild", versionCode?.toString() ?: "0")
      .put("appBundleId", context.packageName)
      .put("isEmulator", isEmulator())
      .put("processStartUnixMillis", processStartUnixMillis)
  }

  @Synchronized
  private fun stopInstrumentation() {
    initialized = false
    generation += 1
    val app = application
    lifecycleCallbacks?.let { app?.unregisterActivityLifecycleCallbacks(it) }
    componentCallbacks?.let { app?.unregisterComponentCallbacks(it) }
    lifecycleCallbacks = null
    componentCallbacks = null
    crashHandler?.let { handler ->
      if (Thread.getDefaultUncaughtExceptionHandler() === handler) {
        Thread.setDefaultUncaughtExceptionHandler(handler.previous)
      }
    }
    crashHandler = null
    heartbeatRunnable?.let(mainHandler::removeCallbacks)
    heartbeatRunnable = null
    watchdogThread?.quitSafely()
    watchdogThread = null
    frameCallback?.let { callback ->
      mainHandler.post { Choreographer.getInstance().removeFrameCallback(callback) }
    }
    frameCallback = null
    lastFrameNanos = 0L
    firstFrameRecorded = false
    startedActivities = 0
    foreground = true
  }

  private fun isGenerationActive(value: Long): Boolean =
    initialized && generation == value

  private fun readQueueFile(app: Application): String = synchronized(fileLock) {
    val file = queueFile(app)
    if (!file.exists()) return@synchronized ""
    if (file.length() > MAX_PERSISTED_QUEUE_BYTES) {
      file.delete()
      return@synchronized ""
    }
    AtomicFile(file).openRead().bufferedReader(StandardCharsets.UTF_8).use {
      it.readText()
    }
  }

  private fun writeQueueFile(app: Application, value: String): Boolean =
    synchronized(fileLock) {
      val atomicFile = AtomicFile(queueFile(app))
      var stream: java.io.FileOutputStream? = null
      try {
        stream = atomicFile.startWrite()
        stream.write(value.toByteArray(StandardCharsets.UTF_8))
        stream.fd.sync()
        atomicFile.finishWrite(stream)
        true
      } catch (error: Exception) {
        stream?.let(atomicFile::failWrite)
        diagnostic("Queue write failed: ${error.javaClass.simpleName}")
        false
      }
    }

  private fun queueFile(app: Application): File = File(app.noBackupFilesDir, QUEUE_FILE)

  private fun calculateProcessStartUnixMillis(): Long {
    val elapsed = max(
      0L,
      SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()
    )
    return System.currentTimeMillis() - elapsed
  }

  private fun isEmulator(): Boolean {
    val fingerprint = Build.FINGERPRINT.lowercase(Locale.ROOT)
    val model = Build.MODEL.lowercase(Locale.ROOT)
    return fingerprint.startsWith("generic") ||
      fingerprint.contains("emulator") ||
      model.contains("sdk_gphone") ||
      model.contains("emulator") ||
      Build.HARDWARE.lowercase(Locale.ROOT).contains("ranchu")
  }

  private fun isTraceId(value: String): Boolean =
    value.matches(Regex("^[0-9a-f]{32}$")) && value.any { it != '0' }

  private fun isSpanId(value: String): Boolean =
    value.matches(Regex("^[0-9a-f]{16}$")) && value.any { it != '0' }

  private fun diagnostic(message: String) {
    if (diagnosticsEnabled) Log.d(TAG, message)
  }

  private class CrashHandler(
    private val app: Application,
    val previous: Thread.UncaughtExceptionHandler?
  ) : Thread.UncaughtExceptionHandler {
    override fun uncaughtException(thread: Thread, throwable: Throwable) {
      try {
        val event = org.json.JSONObject()
          .put("id", UUID.randomUUID().toString())
          .put("type", "crash")
          .put("name", "app.native.crash")
          .put("timestampUnixMillis", System.currentTimeMillis())
          .put(
            "attributes",
            sanitizeAttributes(
              mapOf(
                "exception.type" to throwable.javaClass.name,
                "exception.message" to (throwable.message ?: "Native crash"),
                "exception.stacktrace" to
                  Log.getStackTraceString(throwable).take(MAX_STACK_LENGTH),
                "thread.name" to thread.name
              )
            )
          )
        traceContext.get()?.let { (traceId, spanId) ->
          event.put("traceId", traceId).put("spanId", spanId)
        }
        val atomicFile = AtomicFile(File(app.noBackupFilesDir, CRASH_FILE))
        var stream: java.io.FileOutputStream? = null
        try {
          stream = atomicFile.startWrite()
          stream.write(event.toString().toByteArray(StandardCharsets.UTF_8))
          stream.fd.sync()
          atomicFile.finishWrite(stream)
        } catch (_: Exception) {
          stream?.let(atomicFile::failWrite)
        }
      } catch (_: Throwable) {
        // Crash capture must preserve the platform crash path.
      } finally {
        if (previous != null) {
          previous.uncaughtException(thread, throwable)
        } else {
          Process.killProcess(Process.myPid())
          exitProcess(10)
        }
      }
    }
  }

  private data class NativeConfig(
    val diagnosticsEnabled: Boolean,
    val maxEventQueueSize: Int,
    val captureLifecycle: Boolean,
    val captureNativeCrashes: Boolean,
    val captureAnr: Boolean,
    val captureFrozenFrames: Boolean
  ) {
    companion object {
      fun parse(value: String): NativeConfig {
        val json = runCatching { org.json.JSONObject(value) }
          .getOrDefault(org.json.JSONObject())
        return NativeConfig(
          diagnosticsEnabled = json.optBoolean("diagnosticsEnabled", false),
          maxEventQueueSize = json.optInt("maxEventQueueSize", 128).coerceIn(8, 256),
          captureLifecycle = json.optBoolean("captureLifecycle", true),
          captureNativeCrashes = json.optBoolean("captureNativeCrashes", true),
          captureAnr = json.optBoolean("captureAnr", true),
          captureFrozenFrames = json.optBoolean("captureFrozenFrames", true)
        )
      }
    }
  }
}
