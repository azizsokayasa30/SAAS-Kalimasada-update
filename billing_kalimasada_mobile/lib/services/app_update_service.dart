import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client.dart';

/// Info pembaruan dari server billing atau GitHub.
class AppUpdateInfo {
  const AppUpdateInfo({
    required this.version,
    required this.buildNumber,
    required this.apkUrl,
    required this.releaseNotes,
    required this.source,
    this.forceUpdate = false,
  });

  final String version;
  final int buildNumber;
  final String apkUrl;
  final String releaseNotes;
  final String source;
  final bool forceUpdate;

  String get versionLabel =>
      buildNumber > 0 ? '$version+$buildNumber' : version;
}

/// Cek & unduh update APK (server billing → GitHub).
class AppUpdateService {
  static const MethodChannel _installChannel = MethodChannel(
    'com.kalimasada.mobile/app_install',
  );

  static const String _githubRepoOwner = 'azizsokayasa30';
  static const String _githubRepoName = 'billing-kalimasada';

  static const Map<String, String> _githubHeaders = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'KalimasadaBillingMobile/5.9.1',
  };

  static const _prefDismissedBuild = 'dismissed_update_build';

  static Future<({String version, int build})> currentVersionInfo() async {
    final info = await PackageInfo.fromPlatform();
    final build = int.tryParse(info.buildNumber) ?? 0;
    return (version: info.version, build: build);
  }

  static int compareVersionLike(String a, String b) {
    List<int> parseParts(String v) {
      final cleaned = v.replaceFirst(RegExp(r'^[vV]'), '');
      final nums = RegExp(
        r'\d+',
      ).allMatches(cleaned).map((m) => int.parse(m.group(0)!)).toList();
      if (nums.isEmpty) return [0];
      return nums;
    }

    final pa = parseParts(a);
    final pb = parseParts(b);
    final maxLen = pa.length > pb.length ? pa.length : pb.length;
    for (var i = 0; i < maxLen; i++) {
      final va = i < pa.length ? pa[i] : 0;
      final vb = i < pb.length ? pb[i] : 0;
      if (va != vb) return va.compareTo(vb);
    }
    return 0;
  }

  static bool isNewerThanInstalled(
    AppUpdateInfo remote,
    String currentVersion,
    int currentBuild,
  ) {
    final vCmp = compareVersionLike(remote.version, currentVersion);
    if (vCmp > 0) return true;
    if (vCmp < 0) return false;
    if (remote.buildNumber > 0 && currentBuild > 0) {
      return remote.buildNumber > currentBuild;
    }
    return compareVersionLike(
          remote.versionLabel,
          '$currentVersion+$currentBuild',
        ) >
        0;
  }

  static String? _absoluteApkUrl(String raw) {
    final t = raw.trim();
    if (t.isEmpty) return null;
    if (t.startsWith('http://') || t.startsWith('https://')) {
      return Uri.tryParse(t)?.toString();
    }
    final origin = ApiClient.apiOrigin;
    final p = t.startsWith('/') ? t : '/$t';
    return Uri.tryParse('$origin$p')?.toString();
  }

  static AppUpdateInfo? _fromManifestMap(Map<String, dynamic> m) {
    if (m['configured'] != true) return null;
    final v = (m['version'] ?? '').toString().trim();
    final rawApk = (m['apk_url'] ?? '').toString().trim();
    if (v.isEmpty || rawApk.isEmpty) return null;
    final bn = m['build_number'];
    final buildNum = bn is int ? bn : int.tryParse(bn?.toString() ?? '') ?? 0;
    final notes = (m['release_notes'] ?? '').toString().trim();
    final apkAbs = _absoluteApkUrl(rawApk);
    if (apkAbs == null) return null;
    final force =
        m['force_update'] == true ||
        m['force_update'] == 1 ||
        m['force_update'] == '1';
    return AppUpdateInfo(
      version: v,
      buildNumber: buildNum,
      apkUrl: apkAbs,
      releaseNotes: notes.isNotEmpty ? notes : 'Pembaruan aplikasi mobile.',
      source: 'server',
      forceUpdate: force,
    );
  }

  static Future<AppUpdateInfo?> _tryManifestFromBillingServer() async {
    try {
      final uri = Uri.parse(
        '${ApiClient.apiOrigin}/api/mobile-adapter/app-update/manifest',
      );
      final res = await http
          .get(
            uri,
            headers: {'Accept': 'application/json', ...ApiClient.tenantHeaders},
          )
          .timeout(const Duration(seconds: 25));
      if (res.statusCode != 200) return null;
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (!ApiClient.jsonSuccess(data['success'])) return null;
      final inner = data['data'];
      if (inner is! Map) return null;
      return _fromManifestMap(Map<String, dynamic>.from(inner));
    } catch (_) {
      return null;
    }
  }

  static String? _apkUrlFromReleaseAssets(Map<String, dynamic> data) {
    final assets = data['assets'];
    if (assets is! List) return null;
    for (final item in assets) {
      if (item is! Map) continue;
      final name = item['name']?.toString().toLowerCase() ?? '';
      final dl = item['browser_download_url']?.toString();
      if (dl != null && dl.isNotEmpty && name.endsWith('.apk')) {
        return dl;
      }
    }
    return null;
  }

  static Future<Map<String, dynamic>?>
  _fetchFirstGithubReleaseWithFallback() async {
    final latestUri = Uri.parse(
      'https://api.github.com/repos/$_githubRepoOwner/$_githubRepoName/releases/latest',
    );
    final latestRes = await http
        .get(latestUri, headers: _githubHeaders)
        .timeout(const Duration(seconds: 25));
    if (latestRes.statusCode == 200) {
      final decoded = jsonDecode(latestRes.body);
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
      return null;
    }
    if (latestRes.statusCode != 404) return null;

    final listUri = Uri.parse(
      'https://api.github.com/repos/$_githubRepoOwner/$_githubRepoName/releases?per_page=10',
    );
    final listRes = await http
        .get(listUri, headers: _githubHeaders)
        .timeout(const Duration(seconds: 25));
    if (listRes.statusCode != 200) return null;
    final decoded = jsonDecode(listRes.body);
    if (decoded is! List || decoded.isEmpty) return null;
    for (final raw in decoded) {
      if (raw is! Map) continue;
      final m = Map<String, dynamic>.from(raw);
      if (_apkUrlFromReleaseAssets(m) != null ||
          (m['tag_name']?.toString().trim().isNotEmpty ?? false)) {
        return m;
      }
    }
    return null;
  }

  static AppUpdateInfo? _fromGithubRelease(Map<String, dynamic> data) {
    final tag = (data['tag_name']?.toString() ?? '').trim();
    final apkUrl = _apkUrlFromReleaseAssets(data);
    if (apkUrl == null || apkUrl.isEmpty) return null;
    final notes = (data['body']?.toString() ?? '').trim();
    final version = tag.replaceFirst(RegExp(r'^v'), '');
    return AppUpdateInfo(
      version: version.isNotEmpty ? version : tag,
      buildNumber: 0,
      apkUrl: apkUrl,
      releaseNotes: notes.isNotEmpty ? notes : 'Pembaruan dari GitHub.',
      source: 'github',
    );
  }

  /// Cek apakah ada versi lebih baru (server billing dulu, lalu GitHub).
  static Future<AppUpdateInfo?> checkForUpdate() async {
    if (!Platform.isAndroid && !kIsWeb) return null;
    if (kIsWeb) return null;

    final server = await _tryManifestFromBillingServer();
    if (server != null) return server;

    final gh = await _fetchFirstGithubReleaseWithFallback();
    if (gh == null) return null;
    return _fromGithubRelease(gh);
  }

  /// Apakah user sudah menutup dialog untuk build ini (opsional update).
  static Future<bool> wasDismissedForBuild(int buildNumber) async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getInt(_prefDismissedBuild) == buildNumber;
  }

  static Future<void> markDismissedForBuild(int buildNumber) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(_prefDismissedBuild, buildNumber);
  }

  /// Unduh APK dan buka installer Android (tap Install di sistem).
  static Future<void> downloadAndInstall(
    String apkUrl, {
    void Function(double? progress)? onProgress,
  }) async {
    if (!Platform.isAndroid) {
      throw UnsupportedError('Update APK hanya untuk Android');
    }

    final client = http.Client();
    final dir = await getTemporaryDirectory();
    final filePath =
        '${dir.path}/kalimasada-update-${DateTime.now().millisecondsSinceEpoch}.apk';
    final file = File(filePath);
    try {
      final request = http.Request('GET', Uri.parse(apkUrl));
      final streamed = await client.send(request);
      if (streamed.statusCode != 200) {
        throw Exception('HTTP ${streamed.statusCode}');
      }

      final sink = file.openWrite();
      final totalBytes = streamed.contentLength ?? -1;
      var downloadedBytes = 0;
      await for (final chunk in streamed.stream) {
        sink.add(chunk);
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          onProgress?.call((downloadedBytes / totalBytes).clamp(0.0, 1.0));
        } else {
          onProgress?.call(null);
        }
      }
      await sink.flush();
      await sink.close();
    } finally {
      client.close();
    }

    onProgress?.call(1.0);
    await _launchApkInstaller(file.path);
  }

  /// Intent instal sistem via FileProvider (OpenFilex sering gagal di Android 7+).
  static Future<void> _launchApkInstaller(String filePath) async {
    try {
      final allowed = await _installChannel.invokeMethod<bool>(
        'canRequestPackageInstalls',
      );
      if (allowed == false) {
        await _installChannel.invokeMethod<void>(
          'openInstallUnknownAppsSettings',
        );
        throw Exception(
          'Izinkan instal dari sumber tidak dikenal untuk aplikasi ini, lalu coba lagi.',
        );
      }
      await _installChannel.invokeMethod<void>('installApk', {
        'filePath': filePath,
      });
    } on PlatformException catch (e) {
      throw Exception(e.message ?? 'Gagal membuka installer');
    }
  }
}
