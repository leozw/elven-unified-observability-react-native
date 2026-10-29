package com.elvenunifiedobservabilityreactnative;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

// OkHttp 3 Java methods remain binary-compatible in 4, but Kotlin marks them ERROR.
// Keep this tiny version bridge in Java rather than suppressing Kotlin diagnostics.
final class ElvenOkHttpCompat {
  static String scheme(Request request) { return request.url().scheme(); }
  static RequestBody body(String value) { return RequestBody.create(MediaType.parse("application/json"), value); }
  static int status(Response response) { return response.code(); }
  private ElvenOkHttpCompat() {}
}
