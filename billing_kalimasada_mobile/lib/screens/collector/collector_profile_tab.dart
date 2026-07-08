import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/api_client.dart';
import '../../store/auth_provider.dart';
import '../../store/collector_provider.dart';
import '../../theme/collector_colors.dart';
import '../../widgets/logout_confirm_dialog.dart';
import '../app_update_screen.dart';
import 'collector_profile_edit_screen.dart';

String _rupiah(num? v) {
  final n = (v ?? 0).round();
  return 'Rp ${NumberFormat.decimalPattern('id_ID').format(n)}';
}

class CollectorProfileTab extends StatefulWidget {
  const CollectorProfileTab({super.key});

  @override
  State<CollectorProfileTab> createState() => _CollectorProfileTabState();
}

class _CollectorProfileTabState extends State<CollectorProfileTab>
    with AutomaticKeepAliveClientMixin {
  static const _primary = Color(0xFF0D3B66);
  static const _primarySoft = Color(0xFFE8F1FA);
  static const _bg = Color(0xFFF5F8FC);
  static const _surface = Colors.white;
  static const _border = Color(0xFFD6E2F0);
  static const _text = Color(0xFF0F172A);
  static const _muted = Color(0xFF64748B);
  static const _danger = Color(0xFFE84C4F);

  bool _uploadingPhoto = false;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<CollectorProvider>().fetchMe();
    });
  }

  String _tenantName() {
    const keys = [
      'tenant_name',
      'tenantName',
      'company_header',
      'companyHeader',
      'company',
      'business_name',
      'tenant',
    ];
    final authUser = context.read<AuthProvider>().user;
    for (final key in keys) {
      final value = authUser?[key]?.toString().trim() ?? '';
      if (value.isNotEmpty) return value;
    }
    final slug = ApiClient.apiTenant?.trim();
    if (slug != null && slug.isNotEmpty) {
      return slug[0].toUpperCase() + slug.substring(1);
    }
    return 'Billing Kalimasada';
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

  Future<void> _showLogoutDialog() async {
    final ok = await confirmLogout(
      context,
      title: 'Logout',
      message: 'Yakin ingin keluar dari aplikasi?',
      confirmLabel: 'Logout',
    );
    if (ok && mounted) {
      await context.read<AuthProvider>().logout();
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
                      'Pilih sumber foto untuk memperbarui profil kolektor',
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
                      'Kamera',
                      style: TextStyle(fontWeight: FontWeight.w700),
                    ),
                    subtitle: const Text('Ambil foto baru'),
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
                      'Galeri',
                      style: TextStyle(fontWeight: FontWeight.w700),
                    ),
                    subtitle: const Text('Pilih dari galeri'),
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
      final err = await context
          .read<CollectorProvider>()
          .updateCollectorPhotoBase64('data:image/jpeg;base64,$b64');
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
    super.build(context);
    final c = context.watch<CollectorProvider>();
    final m = c.me;
    final stats = m != null ? m['profileStats'] as Map<String, dynamic>? : null;
    final name = m?['name']?.toString() ?? 'Kolektor';
    final id = m?['id'];
    final phone = m?['phone']?.toString().trim() ?? '';
    final email = m?['email']?.toString().trim() ?? '';
    final photoUrl = (m?['photo_url']?.toString() ?? '').trim();
    final comm = (stats?['monthlyCommission'] as num?)?.toInt() ?? 0;
    final tx = (stats?['totalCollections'] as num?)?.toInt() ?? 0;
    final tenantName = _tenantName();
    final subtitle = phone.isNotEmpty
        ? phone
        : (email.isNotEmpty ? email : 'Kolektor lapangan');

    if (c.meLoading && m == null) {
      return const ColoredBox(
        color: _bg,
        child: Center(child: CircularProgressIndicator(color: _primary)),
      );
    }

    return ColoredBox(
      color: _bg,
      child: RefreshIndicator(
        color: _primary,
        onRefresh: () => context.read<CollectorProvider>().fetchMe(),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
          children: [
            _profileCard(
              tenantName: tenantName,
              name: name,
              subtitle: subtitle,
              photoUrl: photoUrl,
              collectorId: id?.toString() ?? '-',
              onEditPhoto: _uploadingPhoto ? null : _openPhotoEditor,
              uploadingPhoto: _uploadingPhoto,
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: _statMini(
                    icon: Icons.account_balance_wallet_rounded,
                    label: 'Komisi bulan ini',
                    value: _rupiah(comm),
                    tint: FieldCollectorColors.statLunasBg,
                    iconColor: FieldCollectorColors.statLunasIcon,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: _statMini(
                    icon: Icons.trending_up_rounded,
                    label: 'Transaksi selesai',
                    value: '$tx',
                    tint: FieldCollectorColors.statTotalBg,
                    iconColor: FieldCollectorColors.statTotalIcon,
                  ),
                ),
              ],
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
                  if (m == null) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text(
                          'Profil belum dimuat. Tarik untuk memuat ulang.',
                        ),
                      ),
                    );
                    return;
                  }
                  Navigator.of(context).push<void>(
                    MaterialPageRoute<void>(
                      builder: (_) => const CollectorProfileEditScreen(),
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
                trailing: const Icon(Icons.open_in_new_rounded, color: _muted),
                onTap: _openHelpCenter,
              ),
              _settingsTile(
                icon: Icons.description_rounded,
                title: 'Terms of Service',
                subtitle: 'Ketentuan penggunaan aplikasi Billing Kalimasada',
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
                subtitle: 'Keluar dari sesi kolektor',
                titleColor: _danger,
                onTap: _showLogoutDialog,
                isLast: true,
              ),
            ]),
            const SizedBox(height: 18),
            const Text(
              'Aplikasi ini dibuat oleh\nJenderale skynet mamas ajizs',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Color(0xFF1565C0),
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
    required String photoUrl,
    required String collectorId,
    VoidCallback? onEditPhoto,
    bool uploadingPhoto = false,
  }) {
    final hasPhoto = photoUrl.isNotEmpty;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 12, 14),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            FieldCollectorColors.dashWelcomeTop,
            FieldCollectorColors.dashWelcomeBottom,
          ],
        ),
        borderRadius: BorderRadius.circular(20),
        boxShadow: const [
          BoxShadow(
            color: Color(0x400F3460),
            blurRadius: 16,
            offset: Offset(0, 8),
          ),
        ],
      ),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              GestureDetector(
                onTap: onEditPhoto,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Container(
                      width: 64,
                      height: 64,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Colors.white.withValues(alpha: 0.15),
                        border: Border.all(
                          color: Colors.white.withValues(alpha: 0.45),
                          width: 2.5,
                        ),
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: uploadingPhoto
                          ? const Center(
                              child: SizedBox(
                                width: 24,
                                height: 24,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.4,
                                  color: Colors.white,
                                ),
                              ),
                            )
                          : hasPhoto
                          ? Image.network(
                              photoUrl,
                              key: ValueKey(photoUrl),
                              width: 64,
                              height: 64,
                              fit: BoxFit.cover,
                              gaplessPlayback: true,
                              errorBuilder: (_, _, _) => const Icon(
                                Icons.person_rounded,
                                color: FieldCollectorColors.dashWelcomeOnAccent,
                                size: 30,
                              ),
                            )
                          : const Icon(
                              Icons.person_rounded,
                              color: FieldCollectorColors.dashWelcomeOnAccent,
                              size: 30,
                            ),
                    ),
                    Positioned(
                      right: -2,
                      bottom: -2,
                      child: Container(
                        width: 24,
                        height: 24,
                        decoration: BoxDecoration(
                          color: Colors.white,
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: FieldCollectorColors.dashWelcomeTop,
                            width: 1.5,
                          ),
                        ),
                        child: const Icon(
                          Icons.camera_alt_rounded,
                          color: FieldCollectorColors.dashWelcomeTop,
                          size: 12,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(right: 72),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Tenant $tenantName',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: FieldCollectorColors.dashWelcomeSubtitle,
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: FieldCollectorColors.dashWelcomeOnAccent,
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          height: 1.15,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: FieldCollectorColors.dashWelcomeSubtitle,
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 8),
                      InkWell(
                        onTap: onEditPhoto,
                        borderRadius: BorderRadius.circular(999),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 9,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            color: Colors.white.withValues(alpha: 0.14),
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(
                              color: Colors.white.withValues(alpha: 0.28),
                            ),
                          ),
                          child: Text(
                            uploadingPhoto
                                ? 'Mengunggah...'
                                : 'Edit foto',
                            style: const TextStyle(
                              color: FieldCollectorColors.dashWelcomeOnAccent,
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          Positioned(
            top: 0,
            right: 0,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                _cornerPill('KOLEKTOR'),
                const SizedBox(height: 6),
                _cornerPill('ID $collectorId'),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _cornerPill(String label) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Colors.white.withValues(alpha: 0.28)),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          color: FieldCollectorColors.dashWelcomeOnAccent,
          fontSize: 9,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.3,
        ),
      ),
    );
  }

  Widget _statMini({
    required IconData icon,
    required String label,
    required String value,
    required Color tint,
    required Color iconColor,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _border),
        boxShadow: const [
          BoxShadow(
            color: Color(0x0D000000),
            blurRadius: 10,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: tint,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, size: 20, color: iconColor),
          ),
          const SizedBox(height: 10),
          Text(
            label,
            style: const TextStyle(
              fontSize: 11,
              color: _muted,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            value,
            style: const TextStyle(
              fontWeight: FontWeight.w900,
              fontSize: 16,
              color: _text,
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String title) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Text(
        title,
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w800,
          color: _muted,
          letterSpacing: 0.6,
        ),
      ),
    );
  }

  Widget _settingsGroup(List<Widget> children) {
    return Container(
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _border),
        boxShadow: const [
          BoxShadow(
            color: Color(0x0A000000),
            blurRadius: 10,
            offset: Offset(0, 4),
          ),
        ],
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
    Color? iconColor,
    Color? titleColor,
    bool isLast = false,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(isLast ? 16 : 0),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          border: isLast
              ? null
              : const Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
        ),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: (iconColor ?? _primary).withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: iconColor ?? _primary, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      color: titleColor ?? _text,
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: const TextStyle(fontSize: 13, color: _muted),
                    ),
                  ],
                ],
              ),
            ),
            trailing ??
                const Icon(Icons.chevron_right_rounded, color: _muted),
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
        'Billing Kalimasada digunakan untuk membantu operasional billing internet, pengelolaan pelanggan, penagihan kolektor, dan laporan internal tenant. Pengguna wajib memakai akun sesuai peran yang diberikan dan menjaga kerahasiaan aksesnya.',
  ),
  _ArticleSection(
    title: 'Akurasi Data',
    body:
        'Data pelanggan, tagihan, pembayaran, dan setoran harus diisi sesuai kondisi sebenarnya. Perubahan data yang dilakukan melalui aplikasi menjadi tanggung jawab pengguna yang sedang login.',
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
        'Aplikasi dapat menampilkan dan memproses data akun pengguna, pelanggan, nomor kontak, alamat, paket internet, tagihan, pembayaran, setoran, dan informasi wilayah kolektor yang dibutuhkan untuk operasional billing.',
  ),
  _ArticleSection(
    title: 'Tujuan Penggunaan Data',
    body:
        'Data digunakan untuk administrasi pelanggan, penagihan, pencatatan pembayaran, setoran, dan peningkatan kualitas operasional tenant.',
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
      backgroundColor: _CollectorProfileTabState._bg,
      appBar: AppBar(
        backgroundColor: _CollectorProfileTabState._primary,
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
              border: Border.all(color: _CollectorProfileTabState._border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: _CollectorProfileTabState._text,
                    fontSize: 22,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Billing Kalimasada',
                  style: TextStyle(
                    color: _CollectorProfileTabState._muted,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 18),
                for (final section in sections) ...[
                  Text(
                    section.title,
                    style: const TextStyle(
                      color: _CollectorProfileTabState._text,
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    section.body,
                    style: const TextStyle(
                      color: _CollectorProfileTabState._muted,
                      fontSize: 14,
                      height: 1.45,
                    ),
                  ),
                  const SizedBox(height: 16),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
