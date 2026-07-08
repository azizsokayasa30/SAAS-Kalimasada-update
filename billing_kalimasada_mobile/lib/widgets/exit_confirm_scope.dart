import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Dialog konfirmasi keluar aplikasi (tombol back / gesture).
Future<bool> confirmAppExit(BuildContext context) async {
  final result = await showDialog<bool>(
    context: context,
    barrierDismissible: true,
    builder: (ctx) {
      return AlertDialog(
        backgroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text(
          'Keluar aplikasi?',
          style: TextStyle(
            color: Color(0xFF0F172A),
            fontWeight: FontWeight.w800,
            fontSize: 18,
          ),
        ),
        content: const Text(
          'Anda yakin ingin menutup aplikasi Billing Kalimasada?',
          style: TextStyle(
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
              backgroundColor: const Color(0xFF2563EB),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10),
              ),
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(
              'Keluar',
              style: TextStyle(fontWeight: FontWeight.w800),
            ),
          ),
        ],
      );
    },
  );
  return result == true;
}

/// Cegah close kebablasan: back di tab non-home → ke tab 0; di home → konfirmasi keluar.
class ExitConfirmScope extends StatelessWidget {
  final Widget child;

  /// Index tab bottom nav saat ini (0 = beranda). Null = tidak ada tab (mis. login).
  final int? currentTabIndex;

  /// Dipanggil saat back dari tab selain beranda.
  final VoidCallback? onGoHomeTab;

  const ExitConfirmScope({
    super.key,
    required this.child,
    this.currentTabIndex,
    this.onGoHomeTab,
  });

  Future<void> _handlePop(BuildContext context, bool didPop) async {
    if (didPop) return;

    final tab = currentTabIndex;
    if (tab != null && tab != 0 && onGoHomeTab != null) {
      onGoHomeTab!();
      return;
    }

    final shouldExit = await confirmAppExit(context);
    if (shouldExit && context.mounted) {
      await SystemNavigator.pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) => _handlePop(context, didPop),
      child: child,
    );
  }
}
