package com.hederae2eechat

import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream

// Decrypted chat media. Files stay in the app cache and are never scanned
// into the gallery. Names cannot contain a slash or "..".
class CacheMediaModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  private fun sealedDir(): File {
    val dir = File(reactApplicationContext.cacheDir, "sealed-media")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  private fun fileInDir(name: String): File? {
    if (name.isEmpty() || name.length > 80) return null
    if (!name.matches(Regex("[A-Za-z0-9._-]+"))) return null
    if (name.contains("..")) return null
    val dir = sealedDir()
    val file = File(dir, name)
    val dirPath = dir.canonicalPath
    val filePath = file.canonicalPath
    if (filePath != dirPath && !filePath.startsWith(dirPath + File.separator)) return null
    return file
  }

  @ReactMethod
  fun append(name: String, base64: String, append: Boolean, promise: Promise) {
    try {
      val file = fileInDir(name)
      if (file == null) {
        promise.reject("decrypt", "decrypt")
        return
      }
      val bytes = if (base64.isEmpty()) ByteArray(0) else Base64.decode(base64, Base64.DEFAULT)
      FileOutputStream(file, append).use { it.write(bytes) }
      promise.resolve(Uri.fromFile(file).toString())
    } catch (_: Exception) {
      promise.reject("decrypt", "decrypt")
    }
  }

  @ReactMethod
  fun remove(uri: String, promise: Promise) {
    try {
      val name = Uri.parse(uri).lastPathSegment
      val file = if (name == null) null else fileInDir(name)
      if (file != null && file.exists()) file.delete()
      promise.resolve(null)
    } catch (_: Exception) {
      promise.reject("decrypt", "decrypt")
    }
  }

  @ReactMethod
  fun clear(promise: Promise) {
    try {
      val dir = File(reactApplicationContext.cacheDir, "sealed-media")
      dir.listFiles()?.forEach { it.delete() }
      promise.resolve(null)
    } catch (_: Exception) {
      promise.reject("decrypt", "decrypt")
    }
  }

  companion object {
    const val NAME: String = "CacheMedia"
  }
}
