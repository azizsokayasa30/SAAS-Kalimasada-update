package com.example.billing_kalimasada_mobile

import android.content.ClipData
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
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
    private val installChannelName = "com.kalimasada.mobile/app_install"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, installChannelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "canRequestPackageInstalls" -> {
                        val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            packageManager.canRequestPackageInstalls()
                        } else {
                            true
                        }
                        result.success(allowed)
                    }
                    "openInstallUnknownAppsSettings" -> {
                        try {
                            openInstallUnknownAppsSettings()
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("SETTINGS", e.message, null)
                        }
                    }
                    "installApk" -> {
                        val path = call.argument<String>("filePath")
                        if (path.isNullOrBlank()) {
                            result.error("ARG", "filePath wajib", null)
                            return@setMethodCallHandler
                        }
                        try {
                            installApkFile(path)
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("INSTALL", e.message ?: "Gagal membuka installer", null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
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

    private fun openInstallUnknownAppsSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:$packageName")
        ).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
    }

    /** Buka layar instal APK sistem (FileProvider + ACTION_VIEW). */
    private fun installApkFile(filePath: String) {
        val apk = File(filePath)
        if (!apk.isFile || apk.length() <= 0L) {
            throw Exception("File APK tidak ditemukan atau kosong")
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!packageManager.canRequestPackageInstalls()) {
                openInstallUnknownAppsSettings()
                throw Exception(
                    "Izinkan \"Instal aplikasi tidak dikenal\" untuk Kalimasada Mobile, lalu tap Unduh & instal lagi."
                )
            }
        }

        val apkUri = FileProvider.getUriForFile(
            this,
            "${applicationContext.packageName}.fileprovider",
            apk
        )

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = ClipData.newUri(contentResolver, "update", apkUri)
        }

        @Suppress("DEPRECATION")
        val handlers = packageManager.queryIntentActivities(
            intent,
            PackageManager.MATCH_DEFAULT_ONLY
        )
        if (handlers.isEmpty()) {
            throw Exception("Tidak ada aplikasi pemasang APK di perangkat ini")
        }

        startActivity(intent)
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
