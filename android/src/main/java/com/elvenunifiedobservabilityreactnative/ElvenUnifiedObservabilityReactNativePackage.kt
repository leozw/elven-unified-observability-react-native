package com.elvenunifiedobservabilityreactnative

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import java.util.HashMap

class ElvenUnifiedObservabilityReactNativePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == ElvenUnifiedObservabilityReactNativeModule.NAME) {
      ElvenUnifiedObservabilityReactNativeModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      ElvenUnifiedObservabilityReactNativeModule.NAME to ReactModuleInfo(
        name = ElvenUnifiedObservabilityReactNativeModule.NAME,
        className = ElvenUnifiedObservabilityReactNativeModule.NAME,
        canOverrideExistingModule = false,
        needsEagerInit = false,
        isCxxModule = false,
        isTurboModule = true
      )
    )
  }
}
