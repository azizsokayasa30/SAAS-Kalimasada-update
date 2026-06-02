package com.example.billing_kalimasada_mobile

import android.content.ClipData
import android.content.ContentUris
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream

/**
 * Kirim resi: buka WhatsApp dengan gambar + teks sudah terlampir.
 * Kolektor pilih kontak pelanggan manual jika perlu (tanpa jid / wa.me).
 */
class MainActivity : FlutterFragmentActivity() {
    private val channelName = "com.kalimasada.mobile/whatsapp_share"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "cleanupGalleryReceipts" -> {
                        try {
                            result.success(cleanupKalimasadaResiGallery())
                        } catch (e: Exception) {
                            result.error("CLEANUP", e.message, null)
                        }
                    }
                    "shareReceiptImagePlanB" -> {
                        val path = call.argument<String>("filePath")
                        val text = call.argument<String>("text") ?: ""
                        if (path.isNullOrBlank()) {
                            result.error("ARG", "filePath wajib", null)
                            return@setMethodCallHandler
                        }
                        try {
                            shareReceiptImageReady(path, text)
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("SHARE", e.message ?: "Gagal membuka WhatsApp", null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun pngToJpegCache(source: File): File {
        val bitmap = BitmapFactory.decodeFile(source.absolutePath)
            ?: throw Exception("Gagal membaca gambar resi")
        val jpeg = File(source.parentFile, source.nameWithoutExtension + ".jpg")
        FileOutputStream(jpeg).use { out ->
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 92, out)) {
                throw Exception("Gagal mengonversi gambar resi")
            }
        }
        bitmap.recycle()
        if (source.extension.equals("png", ignoreCase = true) && source != jpeg) {
            source.delete()
        }
        return jpeg
    }

    private fun cleanupKalimasadaResiGallery(): Int {
        var deleted = 0
        val resolver = contentResolver
        val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val projection = arrayOf(MediaStore.Images.Media._ID)
            val selection =
                "(${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?) OR (${MediaStore.Images.Media.DISPLAY_NAME} LIKE ?)"
            val selectionArgs = arrayOf("%KalimasadaResi%", "Resi-%")
            resolver.query(collection, projection, selection, selectionArgs, null)?.use { cursor ->
                val idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
                while (cursor.moveToNext()) {
                    val uri = ContentUris.withAppendedId(collection, cursor.getLong(idCol))
                    if (resolver.delete(uri, null, null) > 0) deleted++
                }
            }
        } else {
            @Suppress("DEPRECATION")
            val folder = File(
                android.os.Environment.getExternalStoragePublicDirectory(
                    android.os.Environment.DIRECTORY_PICTURES
                ),
                "KalimasadaResi"
            )
            if (folder.isDirectory) {
                folder.listFiles()?.forEach { f ->
                    if (f.isFile && f.delete()) deleted++
                }
            }
        }
        return deleted
    }

    /**
     * Buka WhatsApp dengan gambar resi terlampir (+ teks opsional).
     * Tanpa jid — kolektor pilih pelanggan di WhatsApp; gambar tetap ikut.
     */
    private fun shareReceiptImageReady(filePath: String, text: String) {
        val source = File(filePath)
        if (!source.exists()) {
            throw Exception("File resi tidak ditemukan")
        }

        val jpeg = pngToJpegCache(source)
        val shareUri = FileProvider.getUriForFile(
            this,
            "${applicationContext.packageName}.fileprovider",
            jpeg
        )
        val message = text.trim()

        val packages = listOf("com.whatsapp", "com.whatsapp.w4b")
        var lastError: Exception? = null

        for (pkg in packages) {
            try {
                grantUriPermission(pkg, shareUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "image/jpeg"
                    setPackage(pkg)
                    putExtra(Intent.EXTRA_STREAM, shareUri)
                    if (message.isNotEmpty()) {
                        putExtra(Intent.EXTRA_TEXT, message)
                    }
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    clipData = ClipData.newUri(contentResolver, "Resi", shareUri)
                }
                startActivity(intent)
                return
            } catch (e: Exception) {
                lastError = e
            }
        }

        throw lastError ?: Exception("WhatsApp tidak terpasang di perangkat ini")
    }
}
