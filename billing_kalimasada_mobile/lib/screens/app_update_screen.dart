import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/api_client.dart';
import '../services/app_update_service.dart';

/// Layar menu update: cek versi dari server billing lalu GitHub, unduh APK di Android.
class AppUpdateScreen extends StatefulWidget {
  const AppUpdateScreen({super.key});

  @override
  State<AppUpdateScreen> createState() => _AppUpdateScreenState();
}

class _AppUpdateScreenState extends State<AppUpdateScreen> {
  static const String _githubRepoOwner = 'azizsokayasa30';
  static const String _githubRepoName = 'billing-kalimasada';

  /// GitHub menolak permintaan tanpa User-Agent yang wajar.
  static const Map<String, String> _githubHeaders = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'KalimasadaBillingMobile/5.8',
  };

  String _currentVersion = '-';
  String _latestVersion = '-';
  String _latestReleaseNotes = '-';
  String? _latestApkUrl;
  String? _latestReleasePageUrl;
  bool _checkingUpdate = false;
  bool _installingUpdate = false;
  double? _downloadProgress;
  String _updateSource = 'none';

  @override
  void initState() {
    super.initState();
    _loadVersionInfo();
  }

  Future<void> _loadVersionInfo() async {
    try {
      final info = await PackageInfo.fromPlatform();
      final current = '${info.version}+${info.buildNumber}';
      if (!mounted) return;
      setState(() => _currentVersion = current);
    } catch (_) {}
    await _fetchLatestRelease(silent: true);
  }

  int _compareVersionLike(String a, String b) {
    List<int> parseParts(String v) {
      final cleaned = v.replaceFirst(RegExp(r'^[vV]'), '');
      final nums = RegExp(r'\d+').allMatches(cleaned).map((m) => int.parse(m.group(0)!)).toList();
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

  bool get _hasNewVersion {
    if (_currentVersion == '-' || _latestVersion == '-') return false;
    return _compareVersionLike(_latestVersion, _currentVersion) > 0;
  }

  String get _updateSourceLabel {
    switch (_updateSource) {
      case 'server':
        return 'Server billing';
      case 'github':
        return 'GitHub';
      default:
        return '—';
    }
  }

  String? _absoluteApkUrl(String raw) {
    final t = raw.trim();
    if (t.isEmpty) return null;
    if (t.startsWith('http://') || t.startsWith('https://')) {
      return Uri.tryParse(t)?.toString();
    }
    final origin = ApiClient.apiOrigin;
    final p = t.startsWith('/') ? t : '/$t';
    return Uri.tryParse('$origin$p')?.toString();
  }

  Future<bool> _tryFetchManifestFromBillingServer() async {
    try {
      final uri = Uri.parse(
        '${ApiClient.apiOrigin}/api/mobile-adapter/app-update/manifest',
      );
      final res = await http
          .get(uri, headers: const {'Accept': 'application/json'})
          .timeout(const Duration(seconds: 25));
      // 404 = server lama / proxy tidak meneruskan rute; lanjut ke GitHub tanpa error keras.
      if (res.statusCode != 200) return false;
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (!ApiClient.jsonSuccess(data['success'])) return false;
      final inner = data['data'];
      if (inner is! Map) return false;
      final m = Map<String, dynamic>.from(inner);
      if (m['configured'] != true) return false;
      final v = (m['version'] ?? '').toString().trim();
      final rawApk = (m['apk_url'] ?? '').toString().trim();
      if (v.isEmpty || rawApk.isEmpty) return false;
      final bn = m['build_number'];
      final buildNum = bn is int ? bn : int.tryParse(bn?.toString() ?? '') ?? 0;
      final notes = (m['release_notes'] ?? '').toString().trim();
      final apkAbs = _absoluteApkUrl(rawApk);
      if (apkAbs == null) return false;
      if (!mounted) return true;
      setState(() {
        _updateSource = 'server';
        _latestVersion = '$v+$buildNum';
        _latestReleaseNotes = notes.isNotEmpty ? notes : 'Pembaruan aplikasi mobile.';
        _latestApkUrl = apkAbs;
        _latestReleasePageUrl = null;
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Ambil URL APK pertama dari aset release GitHub.
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

  void _applyGithubReleaseMap(Map<String, dynamic> data) {
    final tag = (data['tag_name']?.toString() ?? '').trim();
    final releaseUrl = (data['html_url']?.toString() ?? '').trim();
    final notes = (data['body']?.toString() ?? '').trim();
    final apkUrl = _apkUrlFromReleaseAssets(data);
    setState(() {
      _updateSource = 'github';
      _latestVersion = tag.isNotEmpty ? tag : '-';
      _latestReleaseNotes = notes.isNotEmpty ? notes : 'Tidak ada catatan pembaruan.';
      _latestApkUrl = apkUrl;
      _latestReleasePageUrl = releaseUrl.isNotEmpty ? releaseUrl : null;
    });
  }

  /// Jika `/releases/latest` 404 (belum ada rilis), coba daftar `/releases`.
  Future<Map<String, dynamic>?> _fetchFirstGithubReleaseWithFallback() async {
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
    if (latestRes.statusCode != 404) {
      return {'__error_status': latestRes.statusCode};
    }

    final listUri = Uri.parse(
      'https://api.github.com/repos/$_githubRepoOwner/$_githubRepoName/releases?per_page=10',
    );
    final listRes = await http.get(listUri, headers: _githubHeaders).timeout(const Duration(seconds: 25));
    if (listRes.statusCode != 200) {
      return {'__error_status': listRes.statusCode};
    }
    final decoded = jsonDecode(listRes.body);
    if (decoded is! List || decoded.isEmpty) {
      return {'__no_releases': true};
    }
    for (final raw in decoded) {
      if (raw is! Map) continue;
      final m = Map<String, dynamic>.from(raw);
      if (_apkUrlFromReleaseAssets(m) != null || (m['tag_name']?.toString().trim().isNotEmpty ?? false)) {
        return m;
      }
    }
    final first = decoded.first;
    if (first is Map<String, dynamic>) return first;
    if (first is Map) return Map<String, dynamic>.from(first);
    return {'__no_releases': true};
  }

  void _setNoUpdateSourceAvailable({required bool silent}) {
    if (!mounted) return;
    setState(() {
      _updateSource = 'none';
      _latestVersion = '-';
      _latestApkUrl = null;
      _latestReleasePageUrl = null;
      _latestReleaseNotes =
          'Tidak ada pembaruan dari server billing (manifest belum diisi) dan tidak ada rilis GitHub '
          'dengan APK untuk repo ini.\n\n'
          'Admin: isi `public/mobile-app/manifest.json` atau pengaturan '
          '`mobile_app_version`, `mobile_app_build`, `mobile_app_apk_url` di server, '
          'atau publikasikan release dengan lampiran .apk di GitHub.';
    });
    if (!silent) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Tidak ada sumber update (GitHub tanpa rilis / server tanpa manifest). Lihat catatan di layar.',
          ),
          duration: Duration(seconds: 6),
        ),
      );
    }
  }

  Future<void> _fetchLatestReleaseFromGithub({bool silent = false}) async {
    try {
      final data = await _fetchFirstGithubReleaseWithFallback();
      if (data == null) {
        _setNoUpdateSourceAvailable(silent: silent);
        return;
      }
      if (data['__no_releases'] == true) {
        _setNoUpdateSourceAvailable(silent: silent);
        return;
      }
      final errStatus = data['__error_status'];
      if (errStatus is int) {
        if (!silent && mounted) {
          final msg = errStatus == 403
              ? 'GitHub menolak permintaan (403). Coba lagi nanti atau pakai manifest di server billing.'
              : 'Gagal cek update GitHub (HTTP $errStatus).';
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
        }
        return;
      }

      if (!mounted) return;
      _applyGithubReleaseMap(data);
      if (!silent && mounted) {
        final text = _hasNewVersion
            ? 'Update tersedia: $_latestVersion'
            : 'Aplikasi sudah versi terbaru ($_currentVersion)';
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
      }
    } catch (e) {
      if (!silent && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Gagal cek update: $e')),
        );
      }
    }
  }

  Future<void> _fetchLatestRelease({bool silent = false}) async {
    if (_checkingUpdate) return;
    if (mounted) setState(() => _checkingUpdate = true);
    try {
      if (await _tryFetchManifestFromBillingServer()) {
        if (!silent && mounted) {
          final text = _hasNewVersion
              ? 'Update tersedia: $_latestVersion (dari server billing)'
              : 'Aplikasi sudah versi terbaru ($_currentVersion)';
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
        }
        return;
      }
      await _fetchLatestReleaseFromGithub(silent: silent);
    } finally {
      if (mounted) setState(() => _checkingUpdate = false);
    }
  }

  Future<void> _downloadLatestUpdate() async {
    if (_installingUpdate) return;
    final target = _latestApkUrl ?? _latestReleasePageUrl;
    if (target == null || target.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Tidak ada URL APK. Admin: set manifest di server (public/mobile-app/manifest.json) atau lampirkan APK di release GitHub.',
            ),
          ),
        );
      }
      return;
    }

    if (Platform.isAndroid && _latestApkUrl != null && _latestApkUrl!.isNotEmpty) {
      final messenger = ScaffoldMessenger.of(context);
      try {
        if (mounted) {
          setState(() {
            _installingUpdate = true;
            _downloadProgress = 0;
          });
          messenger.showSnackBar(
            const SnackBar(content: Text('Mengunduh update APK...')),
          );
        }

        await AppUpdateService.downloadAndInstall(
          _latestApkUrl!,
          onProgress: (p) {
            if (mounted) setState(() => _downloadProgress = p);
          },
        );

        if (!mounted) return;
        messenger.showSnackBar(
          const SnackBar(content: Text('Membuka layar instal. Tap Install di sistem.')),
        );
      } catch (e) {
        if (mounted) {
          messenger.showSnackBar(
            SnackBar(content: Text('Gagal unduh/instal update: $e')),
          );
        }
      } finally {
        if (mounted) {
          setState(() {
            _installingUpdate = false;
            _downloadProgress = null;
          });
        }
      }
      return;
    }

    final uri = Uri.parse(target);
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Tidak dapat membuka link update.')),
      );
    }
  }

  static const _primaryContainer = Color(0xFF1B0C6B);
  static const _textOnSurface = Color(0xFF19163F);
  static const _textVariant = Color(0xFF474551);
  static const _surfaceLow = Color(0xFFF6F1FF);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFFCF8FF),
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: _primaryContainer),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text(
          'Update aplikasi',
          style: TextStyle(
            color: _primaryContainer,
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(color: const Color(0xFFE2E8F0), height: 1),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: _surfaceLow,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFC8C4D3).withValues(alpha: 0.3)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      _hasNewVersion ? Icons.new_releases_rounded : Icons.info_outline,
                      color: _hasNewVersion ? const Color(0xFFB3261E) : _primaryContainer,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        _hasNewVersion ? 'Versi baru tersedia' : 'Versi Anda',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                          color: _textOnSurface,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                _kv('Terpasang', _currentVersion),
                const SizedBox(height: 6),
                _kv('Terbaru (remote)', _latestVersion),
                const SizedBox(height: 6),
                _kv('Sumber', _updateSourceLabel),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFC8C4D3).withValues(alpha: 0.3)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Catatan pembaruan',
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                    color: _textOnSurface,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  _latestReleaseNotes,
                  style: const TextStyle(fontSize: 14, color: _textVariant, height: 1.35),
                ),
              ],
            ),
          ),
          if (_installingUpdate) ...[
            const SizedBox(height: 16),
            Text(
              _downloadProgress != null
                  ? 'Progress unduhan: ${(_downloadProgress! * 100).toStringAsFixed(0)}%'
                  : 'Menyiapkan unduhan...',
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
            ),
            const SizedBox(height: 8),
            LinearProgressIndicator(
              minHeight: 8,
              value: _downloadProgress,
              borderRadius: BorderRadius.circular(99),
            ),
          ],
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: _checkingUpdate ? null : () => _fetchLatestRelease(silent: false),
            icon: _checkingUpdate
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Icon(Icons.refresh_rounded),
            label: Text(_checkingUpdate ? 'Memeriksa...' : 'Periksa update'),
            style: FilledButton.styleFrom(
              minimumSize: const Size(double.infinity, 48),
              backgroundColor: _primaryContainer,
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.tonalIcon(
            onPressed: (!_hasNewVersion || _installingUpdate || _checkingUpdate)
                ? null
                : _downloadLatestUpdate,
            icon: _installingUpdate
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.system_update_alt_rounded),
            label: Text(
              _installingUpdate
                  ? (_downloadProgress != null
                        ? 'Mengunduh ${(_downloadProgress! * 100).toStringAsFixed(0)}%'
                        : 'Menyiapkan...')
                  : 'Unduh & instal',
            ),
            style: FilledButton.styleFrom(minimumSize: const Size(double.infinity, 48)),
          ),
          const SizedBox(height: 20),
          Text(
            'Prioritas: manifest di server billing (API), jika tidak dikonfigurasi dipakai rilis terbaru GitHub.',
            style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
          ),
        ],
      ),
    );
  }

  Widget _kv(String k, String v) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 130,
          child: Text(
            k,
            style: const TextStyle(fontSize: 13, color: _textVariant, fontWeight: FontWeight.w600),
          ),
        ),
        Expanded(
          child: Text(
            v,
            style: const TextStyle(fontSize: 13, color: _textOnSurface),
          ),
        ),
      ],
    );
  }
}
