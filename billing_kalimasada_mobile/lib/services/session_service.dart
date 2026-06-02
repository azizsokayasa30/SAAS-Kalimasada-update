import 'package:shared_preferences/shared_preferences.dart';

/// Sesi login berlaku sampai jam 00:00 (tengah malam) waktu lokal perangkat.
class SessionService {
  static const _keyExpiresAt = 'session_expires_at';

  /// Batas akhir sesi: tengah malam hari ini (00:00 besok).
  static DateTime nextMidnight([DateTime? from]) {
    final now = from ?? DateTime.now();
    return DateTime(now.year, now.month, now.day + 1);
  }

  static Future<void> markSessionValid() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyExpiresAt, nextMidnight().toIso8601String());
  }

  static Future<bool> isSessionExpired() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_keyExpiresAt);
    if (raw == null || raw.isEmpty) {
      return false;
    }
    final expires = DateTime.tryParse(raw);
    if (expires == null) return false;
    return !DateTime.now().isBefore(expires);
  }

  static Future<void> clearSessionMarker() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keyExpiresAt);
  }

  /// Durasi sampai logout otomatis (untuk Timer).
  static Future<Duration?> timeUntilMidnightLogout() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_keyExpiresAt);
    if (raw == null || raw.isEmpty) return null;
    final expires = DateTime.tryParse(raw);
    if (expires == null) return null;
    final remaining = expires.difference(DateTime.now());
    if (remaining.isNegative) return Duration.zero;
    return remaining + const Duration(seconds: 1);
  }
}
