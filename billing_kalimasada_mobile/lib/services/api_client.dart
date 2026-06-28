import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

class ApiClient {
  /// Batas waktu request agar UI tidak menggantung jika server tidak terjangkau dari HP.
  static const Duration requestTimeout = Duration(seconds: 45);

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

  /// Prioritas: API_URL → BILLING_API_URL → API_BASE_URL (tanpa slash akhir).
  /// Contoh: `http://192.168.1.10:3000` atau `https://billing.domain.com`
  static String? get _configuredBaseUrl {
    for (final key in _baseUrlEnvKeys) {
      final v = dotenv.env[key]?.trim();
      if (v != null && v.isNotEmpty) {
        return v;
      }
    }
    return null;
  }

  static String get _baseUrl {
    String base = _configuredBaseUrl ?? 'http://192.168.0.200:2002';
    final parsed = Uri.tryParse(base);
    if (parsed != null && parsed.hasScheme && parsed.host.isNotEmpty) {
      base = parsed.replace(path: '', query: '', fragment: '').toString();
    }
    while (base.endsWith('/')) {
      base = base.substring(0, base.length - 1);
    }
    return base;
  }

  /// Tenant dipakai saat debug lewat IP/LAN, karena server tidak bisa membaca subdomain.
  static String? get apiTenant {
    for (final key in _tenantEnvKeys) {
      final v = dotenv.env[key]?.trim();
      if (v != null && v.isNotEmpty) {
        return v;
      }
    }
    final configured = _configuredBaseUrl;
    if (configured == null) return null;
    return Uri.tryParse(configured)?.queryParameters['tenant']?.trim();
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
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token');
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...tenantHeaders,
      if (token != null) 'Authorization': 'Bearer $token',
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
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token');
    final uri = _uri(endpoint);
    final response = await http
        .get(
          uri,
          headers: {
            'Accept': accept,
            ...tenantHeaders,
            if (token != null) 'Authorization': 'Bearer $token',
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
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token');
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
