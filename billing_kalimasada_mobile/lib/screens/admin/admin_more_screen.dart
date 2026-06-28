import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../store/auth_provider.dart';
import '../../store/customer_provider.dart';
import '../app_update_screen.dart';

class AdminMoreScreen extends StatefulWidget {
  const AdminMoreScreen({super.key});

  @override
  State<AdminMoreScreen> createState() => _AdminMoreScreenState();
}

class _AdminMoreScreenState extends State<AdminMoreScreen> {
  static const _lastOfflineSyncKey = 'admin_last_offline_sync_at';

  static const _primary = Color(0xFF2563EB);
  static const _bg = Colors.white;
  static const _surface = Color(0xFFF8FAFC);
  static const _border = Color(0xFFE2E8F0);
  static const _text = Color(0xFF1E293B);
  static const _muted = Color(0xFF64748B);
  static const _danger = Color(0xFFE84C4F);

  DateTime? _lastOfflineSyncAt;
  bool _syncingOffline = false;

  @override
  void initState() {
    super.initState();
    _loadLastOfflineSync();
  }

  String _displayName(Map<String, dynamic>? user) {
    final name = user?['name']?.toString().trim() ?? '';
    if (name.isNotEmpty) return name;
    final username = user?['username']?.toString().trim() ?? '';
    if (username.isNotEmpty) return username;
    return 'Admin';
  }

  String _displayEmail(Map<String, dynamic>? user) {
    final email = user?['email']?.toString().trim() ?? '';
    if (email.isNotEmpty) return email;
    final phone = user?['phone']?.toString().trim() ?? '';
    if (phone.isNotEmpty) return phone;
    return 'Administrator billing';
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

  Future<void> _loadLastOfflineSync() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_lastOfflineSyncKey);
    if (!mounted || raw == null || raw.isEmpty) return;
    setState(() => _lastOfflineSyncAt = DateTime.tryParse(raw));
  }

  Future<void> _syncOfflineData(BuildContext context) async {
    if (_syncingOffline) return;

    setState(() => _syncingOffline = true);
    try {
      final customers = context.read<CustomerProvider>();
      await Future.wait([
        customers.fetchDashboardStats(bustCache: true),
        customers.fetchAreaOptions(),
      ]);

      final now = DateTime.now();
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_lastOfflineSyncKey, now.toIso8601String());

      if (!context.mounted) return;
      final when = DateFormat('d MMM yyyy, HH:mm', 'id_ID').format(now);
      setState(() => _lastOfflineSyncAt = now);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Data offline disinkronkan pada $when')),
      );
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Gagal menyinkronkan data offline: $e')),
      );
    } finally {
      if (mounted) setState(() => _syncingOffline = false);
    }
  }

  Future<void> _openHelpCenter(BuildContext context) async {
    final uri = Uri.parse('https://chat.whatsapp.com/H4VjU8bGbRmHZrn8M6pO6C');
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Tidak bisa membuka grup WhatsApp bantuan.'),
        ),
      );
    }
  }

  void _openArticle(
    BuildContext context, {
    required String title,
    required List<_ArticleSection> sections,
  }) {
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => _LegalArticleScreen(title: title, sections: sections),
      ),
    );
  }

  void _showLogoutDialog(BuildContext context, AuthProvider auth) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: Colors.white,
        title: const Text('Logout'),
        content: const Text('Keluar dari aplikasi admin?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Batal'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(context).pop();
              auth.logout();
            },
            style: FilledButton.styleFrom(
              backgroundColor: _danger,
              foregroundColor: Colors.white,
            ),
            child: const Text('Logout'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final user = auth.user;
    final name = _displayName(user);
    final subtitle = _displayEmail(user);
    final tenantName = _tenantName(user);

    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _primary,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text(
          'Lainnya',
          style: TextStyle(fontWeight: FontWeight.w800),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
        children: [
          _profileCard(
            tenantName: tenantName,
            name: name,
            subtitle: subtitle,
            user: user,
          ),
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
                  : const Icon(Icons.chevron_right_rounded, color: _muted),
              onTap: () => _syncOfflineData(context),
            ),
            _settingsTile(
              icon: Icons.system_update_rounded,
              title: 'Update aplikasi',
              subtitle: 'Cek versi dan unduh update aplikasi',
              trailing: const Icon(Icons.chevron_right_rounded, color: _muted),
              onTap: () {
                Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                    builder: (_) => const AppUpdateScreen(),
                  ),
                );
              },
            ),
          ]),
          const SizedBox(height: 18),
          _sectionTitle('SUPPORT & LEGAL'),
          const SizedBox(height: 8),
          _settingsGroup([
            _settingsTile(
              icon: Icons.help_center_rounded,
              title: 'Help Center',
              trailing: const Icon(Icons.open_in_new_rounded, color: _muted),
              onTap: () => _openHelpCenter(context),
            ),
            _settingsTile(
              icon: Icons.description_rounded,
              title: 'Terms of Service',
              subtitle: 'Ketentuan penggunaan aplikasi Billing Kalimasada',
              onTap: () => _openArticle(
                context,
                title: 'Terms of Service',
                sections: _termsSections,
              ),
            ),
            _settingsTile(
              icon: Icons.privacy_tip_rounded,
              title: 'Privacy Policy',
              subtitle: 'Cara aplikasi mengelola data pengguna dan pelanggan',
              onTap: () => _openArticle(
                context,
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
              subtitle: 'Keluar dari sesi admin',
              titleColor: _danger,
              onTap: () => _showLogoutDialog(context, auth),
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
    );
  }

  Widget _profileCard({
    required String tenantName,
    required String name,
    required String subtitle,
    required Map<String, dynamic>? user,
  }) {
    final id = user?['id']?.toString() ?? '-';
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: _border),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 16,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _primary.withValues(alpha: 0.12),
            ),
            child: const Icon(
              Icons.admin_panel_settings_rounded,
              color: _primary,
              size: 34,
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
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: [
                    _chip(Icons.verified_rounded, 'ADMIN'),
                    _chip(Icons.apartment_rounded, 'TENANT'),
                    _chip(Icons.badge_rounded, 'ID $id'),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _chip(IconData icon, String label) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: _border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: _primary),
          const SizedBox(width: 4),
          Text(
            label,
            style: const TextStyle(
              color: _text,
              fontSize: 11,
              fontWeight: FontWeight.w800,
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
        color: Colors.white,
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
      backgroundColor: _AdminMoreScreenState._bg,
      appBar: AppBar(
        backgroundColor: _AdminMoreScreenState._primary,
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
              color: _AdminMoreScreenState._surface,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: _AdminMoreScreenState._border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: _AdminMoreScreenState._text,
                    fontSize: 22,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Billing Kalimasada',
                  style: TextStyle(
                    color: _AdminMoreScreenState._muted,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 18),
                for (final section in sections) ...[
                  Text(
                    section.title,
                    style: const TextStyle(
                      color: _AdminMoreScreenState._text,
                      fontSize: 16,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    section.body,
                    style: const TextStyle(
                      color: _AdminMoreScreenState._muted,
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
