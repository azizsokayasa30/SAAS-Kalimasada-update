import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../store/auth_provider.dart';
import '../app_update_screen.dart';

class AdminMoreScreen extends StatelessWidget {
  const AdminMoreScreen({super.key});

  static const _primary = Color(0xFF2563EB);
  static const _bg = Colors.white;
  static const _surface = Color(0xFFF8FAFC);
  static const _border = Color(0xFFE2E8F0);
  static const _text = Color(0xFF1E293B);
  static const _muted = Color(0xFF64748B);
  static const _danger = Color(0xFFE84C4F);

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
          _profileCard(name: name, subtitle: subtitle, user: user),
          const SizedBox(height: 18),
          _sectionTitle('PENGATURAN'),
          const SizedBox(height: 8),
          _settingsGroup([
            _settingsTile(
              icon: Icons.sync_rounded,
              title: 'Sync Offline Data',
              subtitle: 'Sinkronkan data lokal dengan server billing',
              onTap: () {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('Menyinkronkan data offline...'),
                  ),
                );
              },
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
              onTap: () => launchUrl(Uri.parse('https://example.com/help')),
            ),
            _settingsTile(
              icon: Icons.description_rounded,
              title: 'Terms of Service',
              onTap: () => launchUrl(Uri.parse('https://example.com/terms')),
            ),
            _settingsTile(
              icon: Icons.privacy_tip_rounded,
              title: 'Privacy Policy',
              onTap: () => launchUrl(Uri.parse('https://example.com/privacy')),
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
        ],
      ),
    );
  }

  Widget _profileCard({
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
