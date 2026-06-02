import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

/// Kirim resi: WhatsApp terbuka dengan gambar resi terlampir.
/// Pilih kontak pelanggan manual di WhatsApp jika perlu.
class WhatsAppReceiptShare {
  static const MethodChannel _channel = MethodChannel('com.kalimasada.mobile/whatsapp_share');

  static Future<void> shareImageToCustomer({
    required List<int> pngBytes,
    required String fileName,
    required String customerPhone,
    String? prefilledText,
  }) async {
    if (!Platform.isAndroid) {
      throw UnsupportedError('Kirim resi lewat WhatsApp hanya didukung di Android');
    }
    if (pngBytes.isEmpty) {
      throw Exception('Gambar resi kosong');
    }

    try {
      await _channel.invokeMethod<int>('cleanupGalleryReceipts');
    } catch (_) {}

    final dir = await getTemporaryDirectory();
    await _cleanupCacheReceipts(dir);

    final safeName = fileName.replaceAll(RegExp(r'[^\w\-.]+'), '_');
    final file = File('${dir.path}/$safeName');
    await file.writeAsBytes(pngBytes, flush: true);

    await _channel.invokeMethod<void>('shareReceiptImagePlanB', {
      'filePath': file.path,
      'text': prefilledText?.trim() ?? '',
    });
  }

  static Future<void> _cleanupCacheReceipts(Directory dir) async {
    try {
      for (final entity in dir.listSync()) {
        if (entity is! File) continue;
        final name = entity.path.split(Platform.pathSeparator).last;
        if (name.startsWith('Resi-') && (name.endsWith('.png') || name.endsWith('.jpg'))) {
          try {
            await entity.delete();
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
}
