import 'dart:convert';
import 'dart:io' show HttpClient, Platform;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api_client.dart';
import 'api_origin_cache.dart';
import 'api_origin_resolver.dart';
import 'server_settings.dart';

class TenantOption {
  const TenantOption({required this.subdomain, required this.name});

  final String subdomain;
  final String name;

  factory TenantOption.fromJson(Map<String, dynamic> json) {
    return TenantOption(
      subdomain: json['subdomain']?.toString().trim().toLowerCase() ?? '',
      name: json['name']?.toString().trim() ?? '',
    );
  }
}

class TenantFetchResult {
  const TenantFetchResult({
    required this.tenants,
    this.error,
    this.usedOrigin,
    this.triedOrigins = const [],
  });

  final List<TenantOption> tenants;
  final String? error;
  final String? usedOrigin;
  final List<String> triedOrigins;

  bool get ok => tenants.isNotEmpty;
}

/// Ambil daftar tenant aktif dari server (tanpa auth).
class TenantService {
  static const Duration _fetchTimeout = Duration(seconds: 8);

  static List<TenantOption> _parseTenantList(dynamic raw) {
    if (raw is! List) return const [];
    final tenants = <TenantOption>[];
    for (final item in raw) {
      if (item is! Map) continue;
      final option = TenantOption.fromJson(Map<String, dynamic>.from(item));
      if (option.subdomain.isNotEmpty) tenants.add(option);
    }
    return tenants;
  }

  static Uri _tenantsUri(String origin) {
    final base = Uri.parse(ApiClient.normalizeOrigin(origin));
    return Uri(
      scheme: base.scheme.isNotEmpty ? base.scheme : 'http',
      host: base.host,
      port: base.hasPort ? base.port : null,
      path: '/api/public/tenants',
    );
  }

  /// `package:http` kadang gagal ke IP LAN di Android; `HttpClient` lebih andal.
  static Future<http.Response> _httpGet(Uri uri) async {
    if (kIsWeb) {
      return http
          .get(uri, headers: const {'Accept': 'application/json'})
          .timeout(_fetchTimeout);
    }
    final client = HttpClient();
    client.connectionTimeout = _fetchTimeout;
    try {
      final request = await client.getUrl(uri);
      request.headers.set('Accept', 'application/json');
      request.headers.set('Connection', 'close');
      final response = await request.close().timeout(_fetchTimeout);
      final bytes = await response.fold<List<int>>(
        [],
        (prev, chunk) => prev..addAll(chunk),
      );
      return http.Response.bytes(
        bytes,
        response.statusCode,
        headers: {'content-type': 'application/json'},
      );
    } finally {
      client.close(force: true);
    }
  }

  static Future<TenantFetchResult> _fetchFromOrigin(String origin) async {
    final cleanOrigin = ApiClient.normalizeOrigin(origin);
    final uri = _tenantsUri(cleanOrigin);
    final response = await _httpGet(uri);

    if (response.statusCode != 200) {
      return TenantFetchResult(
        tenants: const [],
        usedOrigin: cleanOrigin,
        error: 'HTTP ${response.statusCode} dari $uri',
      );
    }

    final body = utf8.decode(response.bodyBytes).trimLeft();
    if (body.startsWith('\ufeff')) {
      // strip BOM
    }
    final decoded = jsonDecode(body);
    if (decoded is! Map) {
      return TenantFetchResult(
        tenants: const [],
        usedOrigin: cleanOrigin,
        error: 'Bukan JSON dari $uri',
      );
    }

    final map = Map<String, dynamic>.from(decoded);
    if (!ApiClient.jsonSuccess(map['success'])) {
      return TenantFetchResult(
        tenants: const [],
        usedOrigin: cleanOrigin,
        error: map['message']?.toString() ?? 'success=false',
      );
    }

    final tenants = _parseTenantList(map['data']);
    if (tenants.isEmpty) {
      return TenantFetchResult(
        tenants: const [],
        usedOrigin: cleanOrigin,
        error: 'data kosong',
      );
    }

    return TenantFetchResult(tenants: tenants, usedOrigin: cleanOrigin);
  }

  static Future<TenantFetchResult> _safeFetch(String origin) async {
    final clean = ApiClient.normalizeOrigin(origin);
    try {
      return await _fetchFromOrigin(clean);
    } catch (e) {
      return TenantFetchResult(
        tenants: const [],
        usedOrigin: clean,
        error: '$clean → $e',
      );
    }
  }

  static String _platformHint() {
    if (kIsWeb) {
      return 'Jalankan app di Android/Windows desktop, atau pastikan CORS server aktif.';
    }
    if (Platform.isAndroid) {
      return 'HP fisik: isi http://IP_LAN_PC:3003 lalu tap ikon sync. '
          'Pastikan backend npm run dev aktif.';
    }
    if (Platform.isWindows) {
      return 'Flutter Windows: gunakan API_URL=http://127.0.0.1:3003 lalu full restart app.';
    }
    return 'Pastikan backend npm run dev aktif dan API_URL di .env sesuai perangkat.';
  }

  static Future<TenantFetchResult> fetchActiveTenants() async {
    final origins = ApiOriginResolver.candidateOrigins();
    if (kDebugMode) {
      debugPrint('[TenantService] mencoba origins: $origins');
    }

    final errors = <String>[];
    for (final origin in origins) {
      final result = await _safeFetch(origin);
      if (result.ok) {
        final clean = result.usedOrigin ?? ApiClient.normalizeOrigin(origin);
        ApiClient.setWorkingOrigin(clean);
        await ApiOriginCache.save(clean);
        await ServerSettings.saveOverride(clean);
        if (kDebugMode) {
          debugPrint(
            '[TenantService] OK ${result.tenants.length} tenant via $clean',
          );
        }
        return TenantFetchResult(
          tenants: result.tenants,
          usedOrigin: clean,
          triedOrigins: origins,
        );
      }
      if (result.error != null && result.error!.isNotEmpty) {
        errors.add(result.error!);
      }
    }

    await ApiOriginCache.clear();
    ApiClient.setWorkingOrigin(null);

    final lines = <String>[
      'Tidak dapat menghubungi server billing.',
      'API .env: ${ApiClient.configuredOrigin ?? '(kosong)'}',
      if (errors.isNotEmpty) errors.first else 'Dicoba: ${origins.join(', ')}',
      _platformHint(),
    ];
    return TenantFetchResult(
      tenants: const [],
      triedOrigins: origins,
      error: lines.join('\n'),
    );
  }
}
