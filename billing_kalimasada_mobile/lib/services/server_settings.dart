import 'package:shared_preferences/shared_preferences.dart';

import 'api_client.dart';
import 'api_origin_cache.dart';

/// URL server billing yang bisa diubah dari app (tanpa rebuild `.env`).
class ServerSettings {
  static const _key = 'api_url_override';

  static String? _memory;

  static String? get override => _memory;

  static Future<void> initialize() async {
    final prefs = await SharedPreferences.getInstance();
    final v = prefs.getString(_key)?.trim();
    _memory = (v != null && v.isNotEmpty) ? ApiClient.normalizeOrigin(v) : null;
    if (_memory != null && _memory!.isNotEmpty) {
      ApiClient.setWorkingOrigin(_memory);
      if (v != _memory) {
        await prefs.setString(_key, _memory!);
      }
    }
  }

  /// URL efektif untuk ditampilkan di UI login.
  static String displayOrigin() {
    return _memory ??
        ApiClient.configuredOrigin ??
        ApiOriginCache.memory ??
        ApiClient.apiOrigin;
  }

  static Future<void> saveOverride(String raw) async {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) {
      await clearOverride();
      return;
    }
    var normalized = ApiClient.normalizeOrigin(trimmed);
    if (!normalized.startsWith('http://') &&
        !normalized.startsWith('https://')) {
      normalized = ApiClient.normalizeOrigin('http://$normalized');
    }
    _memory = normalized;
    ApiClient.setWorkingOrigin(normalized);
    await ApiOriginCache.save(normalized);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, normalized);
  }

  static Future<void> clearOverride() async {
    _memory = null;
    ApiClient.setWorkingOrigin(null);
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}
