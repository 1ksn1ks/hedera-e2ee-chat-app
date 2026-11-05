package com.hederae2eechat

import android.net.Uri
import android.widget.VideoView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

// Plays a file:// clip from the app cache. It does not open the gallery.
class SealedVideoManager : SimpleViewManager<VideoView>() {
  override fun getName(): String = "SealedVideo"

  override fun createViewInstance(reactContext: ThemedReactContext): VideoView {
    return VideoView(reactContext)
  }

  override fun onDropViewInstance(view: VideoView) {
    view.stopPlayback()
    super.onDropViewInstance(view)
  }

  @ReactProp(name = "src")
  fun setSrc(view: VideoView, src: String?) {
    if (src.isNullOrEmpty() || !src.startsWith("file:")) {
      view.stopPlayback()
      return
    }
    view.setVideoURI(Uri.parse(src))
    view.setOnPreparedListener { player ->
      player.isLooping = false
      view.start()
    }
  }
}
