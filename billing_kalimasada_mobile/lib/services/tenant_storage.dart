import 'package:shared_preferences/shared_preferences.dart';

import 'api_client.dart';

/// Tenant yang dipilih user saat login (satu APK untuk banyak tenant).
class TenantStorage {
  static const _key = 'selected_tenant_slug';

  static Future<String?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final slug = prefs.getString(_key)?.trim().toLowerCase();
    if (slug == null || slug.isEmpty) return null;
    return slug;
  }

  static Future<void> save(String? slug) async {
    final prefs = await SharedPreferences.getInstance();
    final normalized = slug?.trim().toLowerCase();
    if (normalized == null || normalized.isEmpty) {
      await prefs.remove(_key);
      ApiClient.setRuntimeTenant(null);
      return;
    }
    await prefs.setString(_key, normalized);
    ApiClient.setRuntimeTenant(normalized);
  }

  /// Muat tenant tersimpan atau fallback dari `.env` (API_TENANT, dll.).
  static Future<void> initialize() async {
    final saved = await load();
    if (saved != null && saved.isNotEmpty) {
      ApiClient.setRuntimeTenant(saved);
      return;
    }
    final fromEnv = ApiClient.envTenant;
    if (fromEnv != null && fromEnv.isNotEmpty) {
      ApiClient.setRuntimeTenant(fromEnv);
    }
  }
}
