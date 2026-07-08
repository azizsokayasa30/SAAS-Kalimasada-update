import 'package:shared_preferences/shared_preferences.dart';

import 'api_client.dart';

/// Origin API yang terakhir berhasil dijangkau dari perangkat ini.
class ApiOriginCache {
  static const _key = 'api_working_origin';

  static String? _memory;

  static String? get memory => _memory;

  static Future<void> initialize() async {
    final prefs = await SharedPreferences.getInstance();
    final v = prefs.getString(_key)?.trim();
    if (v == null || v.isEmpty) {
      _memory = null;
      return;
    }
    final clean = ApiClient.normalizeOrigin(v);
    _memory = clean.isNotEmpty ? clean : null;
    if (_memory != null && v != _memory) {
      await prefs.setString(_key, _memory!);
    }
  }

  static Future<void> save(String origin) async {
    final normalized = ApiClient.normalizeOrigin(origin);
    if (normalized.isEmpty) return;
    _memory = normalized;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, normalized);
  }

  static Future<void> clear() async {
    _memory = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}
