package com.hederae2eechat

import android.media.MediaPlayer
import android.net.Uri
import android.widget.VideoView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import java.util.WeakHashMap

// Plays a file:// clip from the app cache. It does not open the gallery.
// A gif:1 clip is muted and looping. Other clips stay unmuted and play once.
class SealedVideoManager : SimpleViewManager<VideoView>() {
  private class ClipFlags {
    var loop: Boolean = false
    var muted: Boolean = false
    var player: MediaPlayer? = null
  }

  private val flags = WeakHashMap<VideoView, ClipFlags>()

  override fun getName(): String = "SealedVideo"

  override fun createViewInstance(reactContext: ThemedReactContext): VideoView {
    return VideoView(reactContext)
  }

  override fun onDropViewInstance(view: VideoView) {
    view.stopPlayback()
    flags.remove(view)
    super.onDropViewInstance(view)
  }

  private fun box(view: VideoView): ClipFlags {
    val current = flags[view]
    if (current != null) return current
    val created = ClipFlags()
    flags[view] = created
    return created
  }

  private fun apply(view: VideoView) {
    val current = flags[view] ?: return
    val player = current.player ?: return
    player.isLooping = current.loop
    val volume = if (current.muted) 0f else 1f
    player.setVolume(volume, volume)
  }

  @ReactProp(name = "src")
  fun setSrc(view: VideoView, src: String?) {
    if (src.isNullOrEmpty() || !src.startsWith("file:")) {
      view.stopPlayback()
      box(view).player = null
      return
    }
    view.setVideoURI(Uri.parse(src))
    view.setOnPreparedListener { player ->
      box(view).player = player
      apply(view)
      view.start()
    }
  }

  @ReactProp(name = "loop", defaultBoolean = false)
  fun setLoop(view: VideoView, loop: Boolean) {
    box(view).loop = loop
    apply(view)
  }

  @ReactProp(name = "muted", defaultBoolean = false)
  fun setMuted(view: VideoView, muted: Boolean) {
    box(view).muted = muted
    apply(view)
  }
}
