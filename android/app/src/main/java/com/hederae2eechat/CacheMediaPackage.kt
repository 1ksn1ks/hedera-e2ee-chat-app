package com.hederae2eechat

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.ModuleSpec
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import javax.inject.Provider

class CacheMediaPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == CacheMediaModule.NAME) CacheMediaModule(reactContext) else null
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        CacheMediaModule.NAME to
          ReactModuleInfo(
            CacheMediaModule.NAME,
            CacheMediaModule::class.java.name,
            false,
            false,
            false,
            false,
          ),
      )
    }
  }

  override fun getViewManagers(reactContext: ReactApplicationContext): List<ModuleSpec> {
    return listOf(ModuleSpec.viewManagerSpec(Provider<NativeModule> { SealedVideoManager() }))
  }
}
