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
                            val intent = buildWhatsAppShareIntent(path, text)
                            result.success(true)
                            startActivity(intent)
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
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw Exception("Gagal membaca gambar resi (file tidak valid)")
        }

        var sampleSize = 1
        val maxDim = 4096
        while (
            bounds.outHeight / sampleSize > maxDim ||
            bounds.outWidth / sampleSize > maxDim
        ) {
            sampleSize *= 2
        }

        val decodeOpts = BitmapFactory.Options().apply {
            inSampleSize = sampleSize
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        val bitmap = BitmapFactory.decodeFile(source.absolutePath, decodeOpts)
            ?: throw Exception("Gagal membaca gambar resi (terlalu besar atau memori penuh)")

        val jpeg = File(source.parentFile, source.nameWithoutExtension + ".jpg")
        try {
            FileOutputStream(jpeg).use { out ->
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)) {
                    throw Exception("Gagal mengonversi gambar resi ke JPEG")
                }
            }
        } finally {
            bitmap.recycle()
        }

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

    private fun isPackageInstalled(packageName: String): Boolean {
        return try {
            packageManager.getPackageInfo(packageName, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    /**
     * Intent kirim gambar resi ke WhatsApp (atau chooser jika WA tidak ada).
     */
    private fun buildWhatsAppShareIntent(filePath: String, text: String): Intent {
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

        val base = Intent(Intent.ACTION_SEND).apply {
            type = "image/jpeg"
            putExtra(Intent.EXTRA_STREAM, shareUri)
            if (message.isNotEmpty()) {
                putExtra(Intent.EXTRA_TEXT, message)
            }
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = ClipData.newUri(contentResolver, "Resi", shareUri)
        }

        for (pkg in listOf("com.whatsapp", "com.whatsapp.w4b")) {
            if (!isPackageInstalled(pkg)) continue
            try {
                grantUriPermission(pkg, shareUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                return Intent(base).apply { setPackage(pkg) }
            } catch (_: Exception) {
            }
        }

        return Intent.createChooser(base, "Kirim resi via").apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }
}
