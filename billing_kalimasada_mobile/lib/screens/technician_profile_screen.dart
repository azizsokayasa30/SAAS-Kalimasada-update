import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/api_client.dart';
import '../store/auth_provider.dart';
import '../store/customer_provider.dart';
import '../widgets/logout_confirm_dialog.dart';
import 'app_update_screen.dart';
import 'technician_profile_edit_screen.dart';

class TechnicianProfileScreen extends StatefulWidget {
  const TechnicianProfileScreen({super.key});

  @override
  State<TechnicianProfileScreen> createState() =>
      _TechnicianProfileScreenState();
}

class _TechnicianProfileScreenState extends State<TechnicianProfileScreen> {
  static const _lastOfflineSyncKey = 'technician_last_offline_sync_at';

  static const _primary = Color(0xFF2563EB);
  static const _primarySoft = Color(0xFFEFF6FF);
  static const _bg = Color(0xFFF8FAFC);
  static const _surface = Colors.white;
  static const _border = Color(0xFFE2E8F0);
  static const _text = Color(0xFF0F172A);
  static const _muted = Color(0xFF64748B);
  static const _danger = Color(0xFFE84C4F);
  static const _success = Color(0xFF10B981);

  bool _loading = true;
  bool _syncingOffline = false;
  bool _uploadingPhoto = false;
  DateTime? _lastOfflineSyncAt;

  @override
  void initState() {
    super.initState();
    _loadLastOfflineSync();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _loadLastOfflineSync() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_lastOfflineSyncKey);
    if (!mounted || raw == null || raw.isEmpty) return;
    setState(() => _lastOfflineSyncAt = DateTime.tryParse(raw));
  }

  Future<void> _load() async {
    try {
      await context.read<AuthProvider>().refreshTechnicianProfile();
    } catch (_) {
      // keep previous profile data on refresh failure
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _positionLabel(String? position) {
    switch ((position ?? 'technician').toLowerCase()) {
      case 'field_officer':
        return 'Petugas Lapangan';
      case 'collector':
        return 'Kolektor';
      case 'technician':
      default:
        return 'Teknisi Lapangan';
    }
  }

  String _tenantName(Map<String, dynamic>? user) {
    const keys = [
      'tenant_name',
      'tenantName',
      'company_header',
      'companyHeader',
      'company',
      'business_name',
      'tenant',
    ];
    for (final key in keys) {
      final value = user?[key]?.toString().trim() ?? '';
      if (value.isNotEmpty) return value;
    }
    final slug = ApiClient.apiTenant?.trim();
    if (slug != null && slug.isNotEmpty) {
      return slug[0].toUpperCase() + slug.substring(1);
    }
    return 'Billing Kalimasada';
  }

  String _syncSubtitle() {
    final last = _lastOfflineSyncAt;
    if (_syncingOffline) return 'Menyinkronkan data offline...';
    if (last == null) return 'Belum pernah disinkronkan';
    final when = DateFormat(
      'd MMM yyyy, HH:mm',
      'id_ID',
    ).format(last.toLocal());
    return 'Terakhir disinkronkan: $when';
  }

  Future<void> _syncOfflineData() async {
    if (_syncingOffline) return;
    setState(() => _syncingOffline = true);
    try {
      final customers = context.read<CustomerProvider>();
      await Future.wait([
        customers.fetchDashboardStats(bustCache: true),
        customers.fetchAreaOptions(),
        context.read<AuthProvider>().refreshTechnicianProfile(),
      ]);

      final now = DateTime.now();
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_lastOfflineSyncKey, now.toIso8601String());

      if (!mounted) return;
      setState(() => _lastOfflineSyncAt = now);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Data offline disinkronkan pada ${DateFormat('d MMM yyyy, HH:mm', 'id_ID').format(now)}',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Gagal menyinkronkan data offline: $e')),
      );
    } finally {
      if (mounted) setState(() => _syncingOffline = false);
    }
  }

  Future<void> _openHelpCenter() async {
    final uri = Uri.parse('https://chat.whatsapp.com/H4VjU8bGbRmHZrn8M6pO6C');
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Tidak bisa membuka grup WhatsApp bantuan.'),
        ),
      );
    }
  }

  void _openArticle({
    required String title,
    required List<_ArticleSection> sections,
  }) {
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => _LegalArticleScreen(title: title, sections: sections),
      ),
    );
  }

  Future<void> _showLogoutDialog(AuthProvider auth) async {
    final ok = await confirmLogout(
      context,
      title: 'Logout',
      message: 'Yakin ingin keluar dari aplikasi?',
      confirmLabel: 'Logout',
    );
    if (ok && mounted) {
      await auth.logout();
    }
  }

  Future<void> _openPhotoEditor() async {
    if (_uploadingPhoto) return;
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return Theme(
          data: Theme.of(ctx).copyWith(
            listTileTheme: const ListTileThemeData(
              textColor: _text,
              iconColor: _primary,
            ),
            textTheme: Theme.of(ctx).textTheme.apply(
              bodyColor: _text,
              displayColor: _text,
            ),
          ),
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 40,
                    height: 4,
                    decoration: BoxDecoration(
                      color: const Color(0xFFCBD5E1),
                      borderRadius: BorderRadius.circular(999),
                    ),
                  ),
                  const SizedBox(height: 14),
                  const Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'Edit foto profil',
                      style: TextStyle(
                        color: _text,
                        fontSize: 18,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'Pilih sumber foto untuk memperbarui profil teknisi',
                      style: TextStyle(
                        color: _muted,
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: _primarySoft,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.photo_camera_rounded,
                        color: _primary,
                      ),
                    ),
                    title: const Text(
                      'Ambil dari kamera',
                      style: TextStyle(
                        color: _text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    onTap: () => Navigator.pop(ctx, ImageSource.camera),
                  ),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: _primarySoft,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.photo_library_rounded,
                        color: _primary,
                      ),
                    ),
                    title: const Text(
                      'Pilih dari galeri',
                      style: TextStyle(
                        color: _text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    onTap: () => Navigator.pop(ctx, ImageSource.gallery),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
    if (source == null || !mounted) return;
    await _pickAndUploadPhoto(source);
  }

  Future<void> _pickAndUploadPhoto(ImageSource source) async {
    try {
      final picker = ImagePicker();
      final file = await picker.pickImage(
        source: source,
        maxWidth: 1280,
        maxHeight: 1280,
        imageQuality: 85,
      );
      if (file == null || !mounted) return;

      setState(() => _uploadingPhoto = true);
      final bytes = await file.readAsBytes();
      final b64 = base64Encode(bytes);
      if (!mounted) return;
      final auth = context.read<AuthProvider>();
      final err = await auth.updateTechnicianPhotoBase64(
        'data:image/jpeg;base64,$b64',
      );
      if (!mounted) return;
      setState(() => _uploadingPhoto = false);
      if (err != null) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(err)));
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Foto profil berhasil diperbarui')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _uploadingPhoto = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Gagal mengunggah foto: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final u = auth.user;
    final name = u?['name']?.toString() ?? 'Teknisi';
    final position = _positionLabel(u?['position']?.toString());
    final phone = u?['phone']?.toString().trim() ?? '';
    final email = u?['email']?.toString().trim() ?? '';
    final area = u?['area_coverage']?.toString().trim();
    final areaDisplay = (area != null && area.isNotEmpty)
        ? area
        : 'Belum diatur';
    final photoUrl = (u?['photo_url']?.toString() ?? '').trim();
    final tenantName = _tenantName(u);
    final subtitle = phone.isNotEmpty
        ? phone
        : (email.isNotEmpty ? email : 'Teknisi lapangan');

    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _primary,
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: const Text(
          'Profil',
          style: TextStyle(fontWeight: FontWeight.w800),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            tooltip: 'Muat ulang',
            onPressed: _loading
                ? null
                : () async {
                    setState(() => _loading = true);
                    await _load();
                  },
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: _primary))
          : RefreshIndicator(
              color: _primary,
              onRefresh: () async {
                setState(() => _loading = true);
                await _load();
              },
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
                children: [
                  _profileCard(
                    tenantName: tenantName,
                    name: name,
                    subtitle: subtitle,
                    position: position,
                    photoUrl: photoUrl,
                    areaDisplay: areaDisplay,
                    onEditPhoto: _uploadingPhoto ? null : _openPhotoEditor,
                    uploadingPhoto: _uploadingPhoto,
                  ),
                  const SizedBox(height: 18),
                  _sectionTitle('AKUN'),
                  const SizedBox(height: 8),
                  _settingsGroup([
                    _settingsTile(
                      icon: Icons.manage_accounts_rounded,
                      title: 'Pengaturan akun',
                      subtitle: 'Ubah nama, alamat, email, dan nomor HP',
                      onTap: () {
                        Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(
                            builder: (_) =>
                                const TechnicianProfileEditScreen(),
                          ),
                        );
                      },
                      isLast: true,
                    ),
                  ]),
                  const SizedBox(height: 18),
                  _sectionTitle('PENGATURAN'),
                  const SizedBox(height: 8),
                  _settingsGroup([
                    _settingsTile(
                      icon: Icons.sync_rounded,
                      title: 'Sync Offline Data',
                      subtitle: _syncSubtitle(),
                      trailing: _syncingOffline
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(
                              Icons.chevron_right_rounded,
                              color: _muted,
                            ),
                      onTap: _syncOfflineData,
                    ),
                    _settingsTile(
                      icon: Icons.system_update_rounded,
                      title: 'Update aplikasi',
                      subtitle: 'Cek versi dan unduh update aplikasi',
                      onTap: () {
                        Navigator.of(context).push<void>(
                          MaterialPageRoute<void>(
                            builder: (_) => const AppUpdateScreen(),
                          ),
                        );
                      },
                      isLast: true,
                    ),
                  ]),
                  const SizedBox(height: 18),
                  _sectionTitle('SUPPORT & LEGAL'),
                  const SizedBox(height: 8),
                  _settingsGroup([
                    _settingsTile(
                      icon: Icons.help_center_rounded,
                      title: 'Help Center',
                      trailing: const Icon(
                        Icons.open_in_new_rounded,
                        color: _muted,
                      ),
                      onTap: _openHelpCenter,
                    ),
                    _settingsTile(
                      icon: Icons.description_rounded,
                      title: 'Terms of Service',
                      subtitle:
                          'Ketentuan penggunaan aplikasi Billing Kalimasada',
                      onTap: () => _openArticle(
                        title: 'Terms of Service',
                        sections: _termsSections,
                      ),
                    ),
                    _settingsTile(
                      icon: Icons.privacy_tip_rounded,
                      title: 'Privacy Policy',
                      subtitle:
                          'Cara aplikasi mengelola data pengguna dan pelanggan',
                      onTap: () => _openArticle(
                        title: 'Privacy Policy',
                        sections: _privacySections,
                      ),
                      isLast: true,
                    ),
                  ]),
                  const SizedBox(height: 18),
                  _settingsGroup([
                    _settingsTile(
                      icon: Icons.logout_rounded,
                      iconColor: _danger,
                      title: 'Logout',
                      subtitle: 'Keluar dari sesi teknisi',
                      titleColor: _danger,
                      onTap: () => _showLogoutDialog(auth),
                      isLast: true,
                    ),
                  ]),
                  const SizedBox(height: 18),
                  const Text(
                    'Aplikasi ini dibuat oleh\nJenderale skynet mamas ajizs',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: Color(0xFF3B82F6),
                      fontSize: 12,
                      height: 1.4,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _profileCard({
    required String tenantName,
    required String name,
    required String subtitle,
    required String position,
    required String photoUrl,
    required String areaDisplay,
    VoidCallback? onEditPhoto,
    bool uploadingPhoto = false,
  }) {
    final hasPhoto = photoUrl.isNotEmpty;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFFEFF6FF), Color(0xFFFFFFFF)],
        ),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: const Color(0xFFBFDBFE)),
        boxShadow: [
          BoxShadow(
            color: _primary.withValues(alpha: 0.08),
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              GestureDetector(
                onTap: onEditPhoto,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Container(
                      width: 72,
                      height: 72,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: _primarySoft,
                        border: Border.all(color: Colors.white, width: 3),
                        boxShadow: [
                          BoxShadow(
                            color: _primary.withValues(alpha: 0.18),
                            blurRadius: 12,
                            offset: const Offset(0, 4),
                          ),
                        ],
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: uploadingPhoto
                          ? const Center(
                              child: SizedBox(
                                width: 26,
                                height: 26,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.4,
                                  color: _primary,
                                ),
                              ),
                            )
                          : hasPhoto
                          ? Image.network(
                              photoUrl,
                              key: ValueKey(photoUrl),
                              width: 72,
                              height: 72,
                              fit: BoxFit.cover,
                              gaplessPlayback: true,
                              errorBuilder: (_, _, _) => const Icon(
                                Icons.engineering_rounded,
                                color: _primary,
                                size: 34,
                              ),
                            )
                          : const Icon(
                              Icons.engineering_rounded,
                              color: _primary,
                              size: 34,
                            ),
                    ),
                    Positioned(
                      right: -2,
                      bottom: -2,
                      child: Container(
                        width: 28,
                        height: 28,
                        decoration: BoxDecoration(
                          color: _primary,
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white, width: 2),
                          boxShadow: [
                            BoxShadow(
                              color: _primary.withValues(alpha: 0.3),
                              blurRadius: 6,
                              offset: const Offset(0, 2),
                            ),
                          ],
                        ),
                        child: const Icon(
                          Icons.camera_alt_rounded,
                          color: Colors.white,
                          size: 14,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Tenant $tenantName',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: _primary,
                        fontSize: 13,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: _text,
                        fontSize: 20,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: _muted,
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 8),
                    InkWell(
                      onTap: onEditPhoto,
                      borderRadius: BorderRadius.circular(999),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 5,
                        ),
                        decoration: BoxDecoration(
                          color: _primarySoft,
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: const Color(0xFFBFDBFE)),
                        ),
                        child: Text(
                          uploadingPhoto
                              ? 'Mengunggah foto...'
                              : 'Edit foto profil',
                          style: const TextStyle(
                            color: _primary,
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _chip(Icons.verified_rounded, position.toUpperCase()),
              _chip(Icons.map_outlined, areaDisplay),
              _chip(Icons.check_circle_rounded, 'AKTIF', color: _success),
            ],
          ),
        ],
      ),
    );
  }

  Widget _chip(IconData icon, String label, {Color color = _primary}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: _border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 5),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 160),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: _text,
                fontSize: 11,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String title) {
    return Text(
      title,
      style: const TextStyle(
        color: _muted,
        fontSize: 12,
        fontWeight: FontWeight.w900,
        letterSpacing: 0.8,
      ),
    );
  }

  Widget _settingsGroup(List<Widget> children) {
    return Container(
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _border),
      ),
      child: Column(children: children),
    );
  }

  Widget _settingsTile({
    required IconData icon,
    required String title,
    String? subtitle,
    Widget? trailing,
    VoidCallback? onTap,
    bool isLast = false,
    Color iconColor = _primary,
    Color titleColor = _text,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.vertical(
        top: const Radius.circular(18),
        bottom: isLast ? const Radius.circular(18) : Radius.zero,
      ),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        decoration: BoxDecoration(
          border: isLast
              ? null
              : const Border(bottom: BorderSide(color: _border)),
        ),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: iconColor.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: iconColor, size: 21),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      color: titleColor,
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: const TextStyle(
                        color: _muted,
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            trailing ?? const Icon(Icons.chevron_right_rounded, color: _muted),
          ],
        ),
      ),
    );
  }
}

class _ArticleSection {
  const _ArticleSection({required this.title, required this.body});

  final String title;
  final String body;
}

const _termsSections = [
  _ArticleSection(
    title: 'Penggunaan Aplikasi',
    body:
        'Billing Kalimasada digunakan untuk membantu operasional billing internet, pengelolaan pelanggan, tugas teknisi, jaringan, dan laporan internal tenant. Pengguna wajib memakai akun sesuai peran yang diberikan dan menjaga kerahasiaan aksesnya.',
  ),
  _ArticleSection(
    title: 'Akurasi Data',
    body:
        'Data pelanggan, tagihan, pembayaran, lokasi, dan status jaringan harus diisi sesuai kondisi sebenarnya. Perubahan data yang dilakukan melalui aplikasi menjadi tanggung jawab pengguna yang sedang login.',
  ),
  _ArticleSection(
    title: 'Sinkronisasi dan Koneksi',
    body:
        'Beberapa fitur membutuhkan koneksi ke server billing. Jika koneksi bermasalah, data yang tampil dapat tertunda sampai sinkronisasi berikutnya berhasil.',
  ),
  _ArticleSection(
    title: 'Batasan Layanan',
    body:
        'Aplikasi disediakan untuk kebutuhan operasional Billing Kalimasada. Penyalahgunaan akses, perubahan data tanpa izin, atau penggunaan di luar kepentingan tenant dapat menyebabkan akun dinonaktifkan.',
  ),
  _ArticleSection(
    title: 'Dukungan',
    body:
        'Pertanyaan, kendala teknis, dan permintaan bantuan dapat disampaikan melalui Help Center yang mengarah ke grup WhatsApp resmi APK Billing Kalimasada.',
  ),
];

const _privacySections = [
  _ArticleSection(
    title: 'Data yang Dikelola',
    body:
        'Aplikasi dapat menampilkan dan memproses data akun pengguna, pelanggan, nomor kontak, alamat, paket internet, tagihan, pembayaran, tugas teknisi, koordinat lokasi, dan informasi jaringan yang dibutuhkan untuk operasional billing.',
  ),
  _ArticleSection(
    title: 'Tujuan Penggunaan Data',
    body:
        'Data digunakan untuk administrasi pelanggan, penagihan, monitoring layanan, pelaksanaan tugas lapangan, pencatatan pembayaran, dan peningkatan kualitas operasional tenant.',
  ),
  _ArticleSection(
    title: 'Penyimpanan dan Keamanan',
    body:
        'Aplikasi menyimpan sesi login dan sebagian informasi pendukung di perangkat agar proses kerja lebih cepat. Pengguna wajib menjaga perangkat, PIN, biometrik, dan akun agar tidak diakses pihak yang tidak berwenang.',
  ),
  _ArticleSection(
    title: 'Berbagi Data',
    body:
        'Data tidak ditujukan untuk dibagikan ke pihak luar selain kebutuhan operasional tenant, dukungan teknis, kewajiban hukum, atau tindakan yang disetujui oleh pengelola layanan.',
  ),
  _ArticleSection(
    title: 'Kontrol Pengguna',
    body:
        'Pengguna dapat logout dari aplikasi kapan saja. Jika perangkat hilang atau akun diduga disalahgunakan, segera hubungi pengelola tenant agar akses dapat diamankan.',
  ),
];

class _LegalArticleScreen extends StatelessWidget {
  const _LegalArticleScreen({required this.title, required this.sections});

  final String title;
  final List<_ArticleSection> sections;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _TechnicianProfileScreenState._bg,
      appBar: AppBar(
        backgroundColor: _TechnicianProfileScreenState._primary,
        foregroundColor: Colors.white,
        elevation: 0,
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: _TechnicianProfileScreenState._border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: _TechnicianProfileScreenState._text,
                    fontSize: 22,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Billing Kalimasada',
                  style: TextStyle(
                    color: _TechnicianProfileScreenState._muted,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 18),
                for (final section in sections) ...[
                  Text(
                    section.title,
                    style: const TextStyle(
                      color: _TechnicianProfileScreenState._text,
                      fontSize: 16,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    section.body,
                    style: const TextStyle(
                      color: _TechnicianProfileScreenState._muted,
                      fontSize: 14,
                      height: 1.5,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  if (section != sections.last) const SizedBox(height: 18),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
