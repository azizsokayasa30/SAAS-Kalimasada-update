import 'package:flutter/material.dart';

/// Palet “Field Collector” (Stitch / web kolektor).
class FieldCollectorColors {
  FieldCollectorColors._();

  static const Color background = Color(0xFFF8F9FA);
  static const Color surface = Color(0xFFFFFFFF);
  /// Latar kartu sedikit lebih tinggi dari [surface] (M3 surfaceContainerHigh).
  static const Color surfaceContainerHigh = Color(0xFFECEEF2);
  static const Color primaryContainer = Color(0xFF001F3F);
  static const Color onPrimary = Color(0xFFFFFFFF);
  static const Color onPrimaryContainer = Color(0xFF6F88AD);
  static const Color primaryFixedDim = Color(0xFFAFC8F0);
  static const Color secondaryFixed = Color(0xFF83FC8E);
  static const Color onSurface = Color(0xFF191C1D);
  static const Color onSurfaceVariant = Color(0xFF43474E);
  static const Color outlineVariant = Color(0xFFC4C6CF);
  static const Color errorContainer = Color(0xFFFFDAD6);
  static const Color onErrorContainer = Color(0xFF93000A);
  static const Color secondaryContainer = Color(0xFF80F98B);
  static const Color onSecondaryContainer = Color(0xFF007327);
  static const Color tertiaryFixed = Color(0xFFFFDBCE);
  static const Color onTertiaryFixed = Color(0xFF351002);
  static const Color primary = Color(0xFF000613);
  static const Color navInactive = Color(0xFF94A3B8);

  /// Tombol “Terapkan” filter periode (ungu lembut).
  static const Color periodApplyBackground = Color(0xFFEDE7F6);
  static const Color periodApplyForeground = Color(0xFF4527A0);

  /// Ringkasan dashboard: teks di atas putih.
  static const Color summaryOverdue = Color(0xFFC62828);
  static const Color summaryPaid = Color(0xFF1B5E20);

  // —— Dashboard home (kolektor): latar & kartu warna-warni ——
  /// Latar halaman dashboard (bukan putih polos).
  static const Color dashboardCanvas = Color(0xFFE8EEF7);
  /// Kartu sapaan: gradien header.
  static const Color dashWelcomeTop = Color(0xFF0F3460);
  static const Color dashWelcomeBottom = Color(0xFF1B6BA8);
  static const Color dashWelcomeOnAccent = Color(0xFFFFFFFF);
  static const Color dashWelcomeSubtitle = Color(0xFFB8D4F0);
  /// Target tagihan: gradien gelap + aksen progres.
  static const Color dashTargetA = Color(0xFF0D3B66);
  static const Color dashTargetB = Color(0xFF1A6CAD);
  static const Color dashTargetProgress = Color(0xFFFFD54F);
  static const Color dashTargetProgressTrack = Color(0x33FFFFFF);
  /// Kartu periode (filter bulan).
  static const Color dashPeriodTint = Color(0xFFF3EDFF);
  static const Color dashPeriodBorder = Color(0xFFD7C4F5);
  /// Ringkasan: satu warna per jenis.
  static const Color statTotalBg = Color(0xFFE3EDFF);
  static const Color statTotalIcon = Color(0xFF1565C0);
  static const Color statBelumBg = Color(0xFFFFF4E5);
  static const Color statBelumIcon = Color(0xFFE65100);
  static const Color statLunasBg = Color(0xFFE8F5E9);
  static const Color statLunasIcon = Color(0xFF2E7D32);
  static const Color statIsolirBg = Color(0xFFF1E8FF);
  static const Color statIsolirIcon = Color(0xFF7B1FA2);
  /// Aksi cepat.
  static const Color dashActionA = Color(0xFF3949AB);
  static const Color dashActionB = Color(0xFF5C6BC0);
  static const Color dashActionFg = Color(0xFFFFFFFF);
  /// Prioritas penagihan.
  static const Color dashPriorityRail = Color(0xFFFFB74D);
  static const Color dashPriorityBg = Color(0xFFFFFBF5);
}
