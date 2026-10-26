import 'package:flutter/material.dart';

/// Rute push hanya mewarisi tema gelap dari MaterialApp; layar Manager Area
/// berdesain terang, jadi tanpa tema ini teks default jadi putih di atas putih.
final ThemeData areaManagerTheme = () {
  const primary = Color(0xFF2563EB);
  const textMain = Color(0xFF0F172A);
  const textMuted = Color(0xFF64748B);
  const border = Color(0xFFE2E8F0);
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    scaffoldBackgroundColor: const Color(0xFFF6F7FA),
    colorScheme: ColorScheme.fromSeed(
      seedColor: primary,
      brightness: Brightness.light,
    ).copyWith(
      primary: primary,
      surface: Colors.white,
      onSurface: textMain,
      onSurfaceVariant: textMuted,
      outline: textMuted,
      outlineVariant: border,
    ),
    textSelectionTheme: const TextSelectionThemeData(cursorColor: primary),
    dividerTheme: const DividerThemeData(color: border),
    dialogTheme: const DialogThemeData(backgroundColor: Colors.white),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: Colors.white,
    ),
  );
}();
