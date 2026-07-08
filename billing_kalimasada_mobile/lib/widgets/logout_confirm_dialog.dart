import 'package:flutter/material.dart';

/// Dialog konfirmasi logout — pakai warna gelap di background putih
/// agar tidak ikut tema app gelap (teks putih di background putih).
Future<bool> confirmLogout(
  BuildContext context, {
  String title = 'Keluar?',
  String message = 'Yakin ingin keluar dari aplikasi?',
  String confirmLabel = 'Keluar',
}) async {
  final result = await showDialog<bool>(
    context: context,
    barrierDismissible: true,
    builder: (ctx) {
      return AlertDialog(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Text(
          title,
          style: const TextStyle(
            color: Color(0xFF0F172A),
            fontWeight: FontWeight.w800,
            fontSize: 18,
          ),
        ),
        content: Text(
          message,
          style: const TextStyle(
            color: Color(0xFF475569),
            fontSize: 14,
            height: 1.35,
          ),
        ),
        actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text(
              'Batal',
              style: TextStyle(
                color: Color(0xFF64748B),
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFFDC2626),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10),
              ),
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(
              confirmLabel,
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
          ),
        ],
      );
    },
  );
  return result == true;
}
