package com.elvenunifiedobservabilityreactnative

import com.facebook.react.bridge.ReactApplicationContext

class ElvenUnifiedObservabilityReactNativeModule(reactContext: ReactApplicationContext) :
  NativeElvenUnifiedObservabilityReactNativeSpec(reactContext) {

  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }

  companion object {
    const val NAME = NativeElvenUnifiedObservabilityReactNativeSpec.NAME
  }
}
