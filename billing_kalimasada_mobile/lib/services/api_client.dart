import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

import 'api_origin_cache.dart';

class ApiClient {
  /// Batas waktu request agar UI tidak menggantung jika server tidak terjangkau dari HP.
  static const Duration requestTimeout = Duration(seconds: 45);

  static String? _runtimeTenant;
  static String? _workingOrigin;
  /// Token di memori — hindari SharedPreferences di setiap request.
  static String? _memoryToken;

  static void setAuthToken(String? token) {
    final t = token?.trim();
    _memoryToken = (t == null || t.isEmpty) ? null : t;
  }

  static String? get memoryToken => _memoryToken;

  static Future<String?> _resolveToken() async {
    if (_memoryToken != null && _memoryToken!.isNotEmpty) {
      return _memoryToken;
    }
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token');
    if (token != null && token.isNotEmpty) {
      _memoryToken = token;
    }
    return token;
  }

  static const List<String> _baseUrlEnvKeys = [
    'API_URL',
    'BILLING_API_URL',
    'API_BASE_URL',
  ];

  static const List<String> _tenantEnvKeys = [
    'API_TENANT',
    'BILLING_TENANT',
    'KALIMASADA_TENANT',
    'TENANT',
  ];

  static String? _readEnvValue(String key) {
    final direct = dotenv.env[key]?.trim();
    if (direct != null && direct.isNotEmpty) return direct;
    for (final entry in dotenv.env.entries) {
      final normalizedKey = entry.key.replaceAll('\ufeff', '').trim();
      if (normalizedKey == key) {
        final v = entry.value.trim();
        if (v.isNotEmpty) return v;
      }
    }
    return null;
  }

  /// Origin dari `.env` saja (tanpa cache / default).
  static String? get configuredOrigin {
    for (final key in _baseUrlEnvKeys) {
      final v = _readEnvValue(key);
      if (v != null && v.isNotEmpty) {
        return _normalizeOrigin(v);
      }
    }
    return null;
  }

  static String? get _configuredBaseUrl => configuredOrigin;

  static String normalizeOrigin(String raw) => _normalizeOrigin(raw);

  static String _normalizeOrigin(String raw) {
    var base = raw.trim();
    if (base.isEmpty) return base;

    // Bersihkan sampah dari autofill / salah ketik di HP (mis. ?# di akhir).
    base = base.split('#').first.trim();
    final q = base.indexOf('?');
    if (q >= 0) base = base.substring(0, q).trim();
    base = base.replaceAll(RegExp(r'/+$'), '');

    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      base = 'http://$base';
    }

    final parsed = Uri.tryParse(base);
    if (parsed != null && parsed.hasScheme && parsed.host.isNotEmpty) {
      final defaultPort = parsed.scheme == 'https' ? 443 : 80;
      final port = parsed.hasPort ? parsed.port : defaultPort;
      final omitPort =
          (parsed.scheme == 'http' && port == 80) ||
          (parsed.scheme == 'https' && port == 443);
      final portSuffix = omitPort ? '' : ':$port';
      return '${parsed.scheme}://${parsed.host}$portSuffix';
    }

    return base;
  }

  static void setWorkingOrigin(String? origin) {
    final normalized = origin == null ? null : _normalizeOrigin(origin);
    _workingOrigin =
        (normalized == null || normalized.isEmpty) ? null : normalized;
  }

  static String get _baseUrl {
    final base = _workingOrigin ??
        _configuredBaseUrl ??
        ApiOriginCache.memory ??
        'http://127.0.0.1:3003';
    return _normalizeOrigin(base);
  }

  /// Tenant dari pilihan user di login (prioritas tertinggi).
  static void setRuntimeTenant(String? tenant) {
    final normalized = tenant?.trim().toLowerCase();
    _runtimeTenant =
        (normalized == null || normalized.isEmpty) ? null : normalized;
  }

  static String? get runtimeTenant => _runtimeTenant;

  /// Tenant dari `.env` atau query `?tenant=` di API_URL.
  static String? get envTenant {
    for (final key in _tenantEnvKeys) {
      final v = _readEnvValue(key);
      if (v != null && v.isNotEmpty) {
        return v.toLowerCase();
      }
    }
    final configured = _configuredBaseUrl;
    if (configured == null) return null;
    final fromQuery = Uri.tryParse(configured)?.queryParameters['tenant']?.trim();
    if (fromQuery == null || fromQuery.isEmpty) return null;
    return fromQuery.toLowerCase();
  }

  /// Tenant efektif: pilihan login → `.env` → query API_URL.
  static String? get apiTenant {
    if (_runtimeTenant != null && _runtimeTenant!.isNotEmpty) {
      return _runtimeTenant;
    }
    return envTenant;
  }

  static Map<String, String> get tenantHeaders {
    final tenant = apiTenant;
    if (tenant == null || tenant.isEmpty) return const {};
    return {'X-Tenant': tenant};
  }

  /// Origin API (tanpa path), mis. untuk `Image.network` logo `/public/img/...`.
  static String get apiOrigin => _baseUrl;

  /// Mengenali flag sukses respons API walau ada proxy yang mengubah tipe (`true`, `1`, `"true"`).
  static bool jsonSuccess(dynamic value) {
    if (value == true || value == 1) return true;
    if (value is String) {
      final s = value.trim().toLowerCase();
      return s == 'true' || s == '1';
    }
    return false;
  }

  static Uri _uri(String endpoint) {
    final path = endpoint.startsWith('/') ? endpoint : '/$endpoint';
    return Uri.parse(_baseUrl).resolve(path);
  }

  static Future<Map<String, String>> _getHeaders() async {
    final token = await _resolveToken();
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...tenantHeaders,
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
    };
  }

  /// Decode JSON object dari respons HTTP. Menghindari [FormatException] mentah jika server mengembalikan HTML/teks.
  static Map<String, dynamic> decodeJsonObject(
    http.Response response, {
    String? debugLabel,
  }) {
    final bytes = response.bodyBytes;
    if (bytes.isEmpty) {
      throw FormatException(
        '${debugLabel ?? 'API'}: body kosong (HTTP ${response.statusCode})',
      );
    }
    var raw = utf8.decode(bytes).trimLeft();
    if (raw.startsWith('\ufeff')) {
      raw = raw.substring(1);
    }
    if (raw.isEmpty) {
      throw FormatException(
        '${debugLabel ?? 'API'}: body hanya BOM/spasi (HTTP ${response.statusCode})',
      );
    }
    final first = raw.codeUnitAt(0);
    if (first != 0x7B && first != 0x5B) {
      final head = raw.length > 200 ? '${raw.substring(0, 200)}…' : raw;
      throw FormatException(
        '${debugLabel ?? 'API'}: bukan JSON (HTTP ${response.statusCode}), awal: $head',
      );
    }
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
      throw FormatException(
        '${debugLabel ?? 'API'}: JSON harus object, dapat ${decoded.runtimeType}',
      );
    } on FormatException catch (e) {
      final head = raw.length > 160 ? '${raw.substring(0, 160)}…' : raw;
      throw FormatException(
        '${debugLabel ?? 'API'}: ${e.message} — cuplikan: $head',
      );
    }
  }

  static Future<http.Response> get(String endpoint) async {
    final headers = await _getHeaders();
    final uri = _uri(endpoint);
    final response = await http
        .get(uri, headers: headers)
        .timeout(requestTimeout);
    print('GET $uri → ${response.statusCode}');
    return response;
  }

  /// Unduh file biner (mis. PDF resi) dengan token auth yang sama.
  static Future<http.Response> download(
    String endpoint, {
    String accept = 'application/pdf',
  }) async {
    final token = await _resolveToken();
    final uri = _uri(endpoint);
    final response = await http
        .get(
          uri,
          headers: {
            'Accept': accept,
            ...tenantHeaders,
            if (token != null && token.isNotEmpty)
              'Authorization': 'Bearer $token',
          },
        )
        .timeout(requestTimeout);
    print('DOWNLOAD $uri → ${response.statusCode}');
    return response;
  }

  static Future<http.Response> post(
    String endpoint,
    Map<String, dynamic> body,
  ) async {
    final headers = await _getHeaders();
    return http
        .post(_uri(endpoint), headers: headers, body: jsonEncode(body))
        .timeout(requestTimeout);
  }

  /// POST multipart (mis. bukti transfer). Jangan set `Content-Type` manual — boundary diisi otomatis.
  static Future<http.Response> postMultipart(
    String endpoint,
    Map<String, String> fields, {
    List<http.MultipartFile> files = const [],
  }) async {
    final token = await _resolveToken();
    final uri = _uri(endpoint);
    final req = http.MultipartRequest('POST', uri);
    req.headers['Accept'] = 'application/json';
    req.headers.addAll(tenantHeaders);
    if (token != null && token.isNotEmpty) {
      req.headers['Authorization'] = 'Bearer $token';
    }
    req.fields.addAll(fields);
    req.files.addAll(files);
    final streamed = await req.send().timeout(requestTimeout);
    return http.Response.fromStream(streamed).timeout(requestTimeout);
  }

  static Future<http.Response> put(
    String endpoint,
    Map<String, dynamic> body,
  ) async {
    final headers = await _getHeaders();
    return http
        .put(_uri(endpoint), headers: headers, body: jsonEncode(body))
        .timeout(requestTimeout);
  }

  static Future<http.Response> patch(
    String endpoint,
    Map<String, dynamic> body,
  ) async {
    final headers = await _getHeaders();
    return http
        .patch(_uri(endpoint), headers: headers, body: jsonEncode(body))
        .timeout(requestTimeout);
  }

  static Future<http.Response> delete(String endpoint) async {
    final headers = await _getHeaders();
    return http
        .delete(_uri(endpoint), headers: headers)
        .timeout(requestTimeout);
  }
}
