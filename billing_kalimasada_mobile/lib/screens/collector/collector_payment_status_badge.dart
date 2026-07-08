import 'package:flutter/material.dart';

import '../../theme/collector_colors.dart';

/// Gaya pill status pembayaran — dipakai bersama oleh kartu pelanggan & prioritas dashboard.
class CollectorPaymentStatusBadgeStyle {
  const CollectorPaymentStatusBadgeStyle({
    required this.label,
    required this.background,
    required this.foreground,
    required this.border,
  });

  final String label;
  final Color background;
  final Color foreground;
  final Color border;

  Widget buildPill({double fontSize = 11}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: border),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: fontSize,
          fontWeight: FontWeight.w800,
          color: foreground,
          letterSpacing: 0.2,
        ),
      ),
    );
  }
}

/// Prioritas: Nonaktif → Isolir → Lunas (periode) → Baru (belum pernah invoice)
/// → Belum bayar (unpaid periode) → Lunas (historis, tidak ada tagihan periode).
CollectorPaymentStatusBadgeStyle collectorPaymentBadgeFor({
  required bool isIsolirAccount,
  required String paymentStatus,
  bool isInactiveAccount = false,
  String? lifetimePaymentStatus,
}) {
  if (isInactiveAccount) {
    return CollectorPaymentStatusBadgeStyle(
      label: 'Nonaktif',
      background: const Color(0xFFE8E8E8),
      foreground: const Color(0xFF5F5F5F),
      border: const Color(0xFF9E9E9E).withValues(alpha: 0.45),
    );
  }
  final ps = paymentStatus.toLowerCase();
  final life = (lifetimePaymentStatus ?? paymentStatus).toLowerCase();
  if (isIsolirAccount) {
    return CollectorPaymentStatusBadgeStyle(
      label: 'Isolir',
      background: FieldCollectorColors.errorContainer,
      foreground: FieldCollectorColors.onErrorContainer,
      border: FieldCollectorColors.onErrorContainer.withValues(alpha: 0.38),
    );
  }
  if (ps == 'paid') {
    return CollectorPaymentStatusBadgeStyle(
      label: 'Lunas',
      background: FieldCollectorColors.statLunasBg,
      foreground: FieldCollectorColors.statLunasIcon,
      border: FieldCollectorColors.statLunasIcon.withValues(alpha: 0.35),
    );
  }
  // "Baru" = belumpunya tagihan sama sekali (lifetime), tetap tampil meski filter bulan aktif.
  if (life == 'no_invoice') {
    return CollectorPaymentStatusBadgeStyle(
      label: 'Baru',
      background: FieldCollectorColors.statTotalBg,
      foreground: FieldCollectorColors.statTotalIcon,
      border: FieldCollectorColors.statTotalIcon.withValues(alpha: 0.35),
    );
  }
  if (ps == 'unpaid' || ps == 'overdue') {
    return CollectorPaymentStatusBadgeStyle(
      label: 'Belum bayar',
      background: FieldCollectorColors.statBelumBg,
      foreground: FieldCollectorColors.statBelumIcon,
      border: FieldCollectorColors.statBelumIcon.withValues(alpha: 0.35),
    );
  }
  // Periode tanpa tagihan, tetapi pernah lunas di periode lain.
  if (life == 'paid') {
    return CollectorPaymentStatusBadgeStyle(
      label: 'Lunas',
      background: FieldCollectorColors.statLunasBg,
      foreground: FieldCollectorColors.statLunasIcon,
      border: FieldCollectorColors.statLunasIcon.withValues(alpha: 0.35),
    );
  }
  return CollectorPaymentStatusBadgeStyle(
    label: 'Belum bayar',
    background: FieldCollectorColors.statBelumBg,
    foreground: FieldCollectorColors.statBelumIcon,
    border: FieldCollectorColors.statBelumIcon.withValues(alpha: 0.35),
  );
}

/// Warna nominal besar di kartu (sama logika di pelanggan & prioritas).
Color collectorPaymentAmountHeadlineColor({
  required bool isIsolirAccount,
  required String paymentStatus,
  bool isInactiveAccount = false,
  String? lifetimePaymentStatus,
}) {
  if (isInactiveAccount) return FieldCollectorColors.onSurfaceVariant;
  if (isIsolirAccount) return FieldCollectorColors.onSurface;
  final ps = paymentStatus.toLowerCase();
  final life = (lifetimePaymentStatus ?? paymentStatus).toLowerCase();
  if (ps == 'paid') return FieldCollectorColors.onSurfaceVariant;
  if (life == 'no_invoice') return FieldCollectorColors.onSurfaceVariant;
  if (ps == 'overdue') return FieldCollectorColors.summaryOverdue;
  return FieldCollectorColors.onSurface;
}
