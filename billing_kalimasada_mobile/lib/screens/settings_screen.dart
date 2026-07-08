import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../store/auth_provider.dart';
import '../widgets/logout_confirm_dialog.dart';
import 'app_update_screen.dart';
import 'technician_profile_edit_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final auth = context.read<AuthProvider>();
      if (auth.role == 'technician') {
        auth.refreshTechnicianProfile();
      }
    });
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

  Future<void> _showLogoutDialog(BuildContext context, AuthProvider auth) async {
    final ok = await confirmLogout(
      context,
      title: 'Logout',
      message: 'Yakin ingin keluar dari aplikasi?',
      confirmLabel: 'Logout',
    );
    if (!ok || !context.mounted) return;
    Navigator.pop(context); // close settings
    await auth.logout();
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final u = auth.user;
    final photoUrl = (u?['photo_url']?.toString() ?? '').trim();
    final hasPhoto = photoUrl.isNotEmpty;
    final String roleChipLabel;
    if (auth.role == 'technician') {
      roleChipLabel = _positionLabel(u?['position']?.toString());
    } else if (auth.role == 'collector') {
      roleChipLabel = 'Kolektor';
    } else if (auth.role == 'agent') {
      roleChipLabel = 'Agen';
    } else if (auth.role == 'admin') {
      roleChipLabel = 'Admin';
    } else {
      roleChipLabel = 'Akun';
    }

    const bgBackground = Color(0xFFFCF8FF);
    const textOnSurface = Color(0xFF19163F);
    const textOnSurfaceVariant = Color(0xFF474551);
    const primaryColor = Color(0xFF070038);
    const primaryContainer = Color(0xFF1B0C6B);

    return Scaffold(
      backgroundColor: bgBackground,
      appBar: AppBar(
        backgroundColor: const Color(0xFF2563EB),
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text(
          'Settings',
          style: TextStyle(
            color: Colors.white,
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
        ),
        centerTitle: false,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(color: Colors.white24, height: 1),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            // Account Section
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: const Color(0xFFF6F1FF), // surface-container-low
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: const Color(0xFFC8C4D3).withValues(alpha: 0.3),
                ),
              ),
              child: Column(
                children: [
                  Row(
                    children: [
                      Container(
                        width: 80,
                        height: 80,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: const Color(0xFFF0EBFF),
                          border: Border.all(color: primaryContainer, width: 2),
                        ),
                        clipBehavior: Clip.antiAlias,
                        child: hasPhoto
                            ? Image.network(
                                photoUrl,
                                width: 80,
                                height: 80,
                                fit: BoxFit.cover,
                                gaplessPlayback: true,
                                errorBuilder: (_, _, _) => Icon(
                                  Icons.person,
                                  size: 40,
                                  color: primaryContainer,
                                ),
                                loadingBuilder:
                                    (context, child, loadingProgress) {
                                      if (loadingProgress == null) return child;
                                      return Center(
                                        child: SizedBox(
                                          width: 28,
                                          height: 28,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                            color: primaryContainer,
                                            value:
                                                loadingProgress
                                                        .expectedTotalBytes !=
                                                    null
                                                ? loadingProgress
                                                          .cumulativeBytesLoaded /
                                                      loadingProgress
                                                          .expectedTotalBytes!
                                                : null,
                                          ),
                                        ),
                                      );
                                    },
                              )
                            : Icon(
                                Icons.person,
                                size: 40,
                                color: primaryContainer,
                              ),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              u?['name']?.toString() ?? 'Pengguna',
                              style: const TextStyle(
                                fontSize: 22,
                                fontWeight: FontWeight.bold,
                                color: textOnSurface,
                              ),
                            ),
                            Text(
                              'ID: ${u?['id'] ?? '-'}',
                              style: const TextStyle(
                                fontSize: 16,
                                color: textOnSurfaceVariant,
                              ),
                            ),
                            const SizedBox(height: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 4,
                              ),
                              decoration: BoxDecoration(
                                color: const Color(
                                  0xFFEAE5FF,
                                ), // surface-container-high
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(
                                    Icons.verified,
                                    size: 16,
                                    color: primaryColor,
                                  ),
                                  const SizedBox(width: 4),
                                  Text(
                                    roleChipLabel.toUpperCase(),
                                    style: const TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.bold,
                                      color: primaryColor,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  ElevatedButton.icon(
                    onPressed: () => _showLogoutDialog(context, auth),
                    icon: const Icon(Icons.logout, color: Colors.white),
                    label: const Text(
                      'Logout',
                      style: TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFFBA1A1A), // error
                      minimumSize: const Size(double.infinity, 48),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 32),

            if (auth.role == 'technician') ...[
              _buildSectionTitle('AKUN'),
              const SizedBox(height: 8),
              _buildSettingsGroup([
                _buildSettingsTile(
                  icon: Icons.manage_accounts,
                  title: 'Pengaturan akun',
                  subtitle: 'Ubah nama, alamat, email, dan nomor HP',
                  onTap: () {
                    Navigator.of(context).push<void>(
                      MaterialPageRoute<void>(
                        builder: (_) => const TechnicianProfileEditScreen(),
                      ),
                    );
                  },
                  isLast: true,
                ),
              ]),
              const SizedBox(height: 32),
            ],

            // Technical Settings
            _buildSectionTitle('TECHNICAL'),
            const SizedBox(height: 8),
            _buildSettingsGroup([
              _buildSettingsTile(
                icon: Icons.sync,
                title: 'Sync Offline Data',
                subtitle: 'Last synced: Today, 08:30 AM',
                trailing: const Icon(
                  Icons.cloud_sync,
                  color: textOnSurfaceVariant,
                ),
                onTap: () {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Menyinkronkan data offline...'),
                    ),
                  );
                },
              ),
              _buildSettingsTile(
                icon: Icons.system_update,
                title: 'Update aplikasi',
                subtitle:
                    'Cek versi, unduh APK dari server billing atau GitHub',
                trailing: const Icon(
                  Icons.chevron_right,
                  color: textOnSurfaceVariant,
                ),
                onTap: () {
                  Navigator.of(context).push<void>(
                    MaterialPageRoute<void>(
                      builder: (_) => const AppUpdateScreen(),
                    ),
                  );
                },
              ),
            ]),
            const SizedBox(height: 32),

            // Support & Legal
            _buildSectionTitle('SUPPORT & LEGAL'),
            const SizedBox(height: 8),
            _buildSettingsGroup([
              _buildSettingsTile(
                icon: Icons.help_center,
                title: 'Help Center',
                trailing: const Icon(
                  Icons.open_in_new,
                  color: textOnSurfaceVariant,
                ),
                onTap: () => launchUrl(Uri.parse('https://example.com/help')),
              ),
              _buildSettingsTile(
                icon: Icons.description,
                title: 'Terms of Service',
                onTap: () => launchUrl(Uri.parse('https://example.com/terms')),
              ),
              _buildSettingsTile(
                icon: Icons.privacy_tip,
                title: 'Privacy Policy',
                onTap: () =>
                    launchUrl(Uri.parse('https://example.com/privacy')),
                isLast: true,
              ),
            ]),

            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }

  Widget _buildSectionTitle(String title) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Text(
        title,
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.bold,
          color: Color(0xFF474551),
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  Widget _buildSettingsGroup(List<Widget> children) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFFF6F1FF),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: const Color(0xFFC8C4D3).withValues(alpha: 0.3),
        ),
      ),
      child: Column(children: children),
    );
  }

  Widget _buildSettingsTile({
    required IconData icon,
    required String title,
    String? subtitle,
    Widget? trailing,
    VoidCallback? onTap,
    bool isLast = false,
  }) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          border: isLast
              ? null
              : Border(
                  bottom: BorderSide(
                    color: const Color(0xFFC8C4D3).withValues(alpha: 0.2),
                  ),
                ),
        ),
        child: Row(
          children: [
            Icon(icon, color: const Color(0xFF1B0C6B)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 18,
                      color: Color(0xFF19163F),
                    ),
                  ),
                  if (subtitle != null)
                    Text(
                      subtitle,
                      style: const TextStyle(
                        fontSize: 14,
                        color: Color(0xFF474551),
                      ),
                    ),
                ],
              ),
            ),
            if (trailing != null)
              trailing
            else
              const Icon(Icons.chevron_right, color: Color(0xFF474551)),
          ],
        ),
      ),
    );
  }
}
