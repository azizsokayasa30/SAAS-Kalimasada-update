import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'api_origin_cache.dart';
import 'server_settings.dart';

/// Susun kandidat base URL API sesuai platform + `.env`.
class ApiOriginResolver {
  static int _portFrom(String? origin, {int fallback = 3003}) {
    if (origin == null || origin.isEmpty) return fallback;
    final parsed = Uri.tryParse(ApiClient.normalizeOrigin(origin));
    if (parsed == null || !parsed.hasPort) return fallback;
    return parsed.port;
  }

  static String _origin(String scheme, String host, int port) {
    final omit =
        (scheme == 'http' && port == 80) || (scheme == 'https' && port == 443);
    return ApiClient.normalizeOrigin(
      omit ? '$scheme://$host' : '$scheme://$host:$port',
    );
  }

  static bool _isLanHost(String host) {
    return host.startsWith('192.168.') ||
        host.startsWith('172.') ||
        (host.startsWith('10.') && host != '10.0.2.2');
  }

  static bool _isLocalhost(String host) {
    return host == '127.0.0.1' || host == 'localhost' || host == '::1';
  }

  static bool _isEmulatorHost(String host) {
    return host == '10.0.2.2';
  }

  /// `127.0.0.1` di HP fisik = perangkat sendiri, bukan PC billing.
  static bool isOriginAllowedOnPlatform(String origin) {
    if (kIsWeb) return true;
    final host = Uri.tryParse(ApiClient.normalizeOrigin(origin))?.host ?? '';
    if (host.isEmpty) return false;
    if (Platform.isAndroid && _isLocalhost(host)) return false;
    if (Platform.isAndroid && _isEmulatorHost(host)) {
      return _shouldTryEmulatorOrigin();
    }
    return true;
  }

  static bool _shouldTryEmulatorOrigin() {
    final sources = [
      ServerSettings.override,
      ApiClient.configuredOrigin,
      ApiOriginCache.memory,
    ];
    for (final raw in sources) {
      if (raw == null || raw.trim().isEmpty) continue;
      final host = Uri.tryParse(ApiClient.normalizeOrigin(raw))?.host ?? '';
      if (host == '10.0.2.2') return true;
    }
    return false;
  }

  /// Urutan: override app → `.env` → cache → fallback platform.
  static List<String> candidateOrigins() {
    final ordered = <String>[];
    void add(String? raw) {
      if (raw == null || raw.trim().isEmpty) return;
      final origin = ApiClient.normalizeOrigin(raw);
      if (origin.isEmpty || !isOriginAllowedOnPlatform(origin)) return;
      if (!ordered.contains(origin)) ordered.add(origin);
    }

    final envOrigin = ApiClient.configuredOrigin;
    final parsedEnv =
        envOrigin != null ? Uri.tryParse(ApiClient.normalizeOrigin(envOrigin)) : null;
    final scheme =
        (parsedEnv?.scheme.isNotEmpty == true) ? parsedEnv!.scheme : 'http';
    final port = _portFrom(envOrigin);
    final envHost = parsedEnv?.host ?? '';

    add(ServerSettings.override);
    add(envOrigin);
    add(ApiOriginCache.memory);

    if (!kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS)) {
      add(_origin(scheme, '127.0.0.1', port));
      add(_origin(scheme, 'localhost', port));
    }

    if (!kIsWeb && Platform.isAndroid && _shouldTryEmulatorOrigin()) {
      add(_origin(scheme, '10.0.2.2', port));
    }

    if (envHost.isNotEmpty && _isLanHost(envHost)) {
      add(_origin(scheme, envHost, port));
    }

    if (ordered.isEmpty) {
      add(envOrigin);
      if (!kIsWeb && Platform.isAndroid && _shouldTryEmulatorOrigin()) {
        ordered.add(_origin(scheme, '10.0.2.2', port));
      } else if (!kIsWeb &&
          (Platform.isWindows || Platform.isLinux || Platform.isMacOS)) {
        ordered.add(_origin('http', '127.0.0.1', port));
      }
    }

    return ordered;
  }
}
