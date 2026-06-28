import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import 'dart:convert';
import '../store/auth_provider.dart';
import '../services/api_client.dart';
import 'app_update_screen.dart';
import 'settings_screen.dart';

class TechnicianProfileScreen extends StatefulWidget {
  const TechnicianProfileScreen({super.key});

  @override
  State<TechnicianProfileScreen> createState() =>
      _TechnicianProfileScreenState();
}

class _TechnicianProfileScreenState extends State<TechnicianProfileScreen> {
  bool _loading = true;
  List<Map<String, dynamic>> _recentTasks = [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final auth = context.read<AuthProvider>();
      await auth.refreshTechnicianProfile();
      final response = await ApiClient.get(
        '/api/mobile-adapter/tasks?history=1',
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['success'] == true && data['data'] is List) {
          final list = List<Map<String, dynamic>>.from(data['data'] as List);
          if (mounted) {
            setState(() => _recentTasks = list.take(12).toList());
          }
        } else if (mounted) {
          setState(() => _recentTasks = []);
        }
      } else if (mounted) {
        setState(() => _recentTasks = []);
      }
    } catch (_) {
      if (mounted) setState(() => _recentTasks = []);
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

  String _fmtDate(String? raw) {
    if (raw == null || raw.isEmpty) return '-';
    final s = raw.trim();
    if (s.length >= 10) return s.substring(0, 10);
    return s;
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final u = auth.user;

    const bgBackground = Color(0xFFFCF8FF);
    const bgSurfaceContainerLowest = Color(0xFFFFFFFF);
    const bgSurfaceContainerLow = Color(0xFFF6F1FF);
    const bgSurfaceContainer = Color(0xFFF0EBFF);
    const primaryColor = Color(0xFF070038);
    const secondaryColor = Color(0xFF7E4990);
    const textOnBackground = Color(0xFF19163F);
    const textOnSurfaceVariant = Color(0xFF474551);
    const outlineVariant = Color(0xFFC8C4D3);

    final name = u?['name']?.toString() ?? 'Teknisi';
    final position = _positionLabel(u?['position']?.toString());
    final phone = u?['phone']?.toString() ?? '';
    final email = u?['email']?.toString();
    final area = u?['area_coverage']?.toString().trim();
    final areaDisplay = (area != null && area.isNotEmpty)
        ? area
        : 'Belum diatur';
    final photoUrl = (u?['photo_url']?.toString() ?? '').trim();
    final hasPhoto = photoUrl.isNotEmpty;

    return Scaffold(
      backgroundColor: bgBackground,
      appBar: AppBar(
        backgroundColor: const Color(0xFF2563EB),
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(color: Colors.white24, height: 1),
        ),
        title: const Text(
          'Profil',
          style: TextStyle(
            color: Colors.white,
            fontSize: 22,
            fontWeight: FontWeight.bold,
          ),
        ),
        centerTitle: false,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white),
            tooltip: 'Muat ulang',
            onPressed: () async {
              setState(() => _loading = true);
              await _load();
              if (mounted) setState(() => _loading = false);
            },
          ),
          IconButton(
            icon: const Icon(Icons.settings, color: Colors.white),
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(builder: (context) => const SettingsScreen()),
              );
            },
            tooltip: 'Pengaturan',
          ),
          IconButton(
            icon: const Icon(Icons.logout, color: Colors.redAccent),
            onPressed: () => _showLogoutDialog(context, auth),
            tooltip: 'Keluar',
          ),
        ],
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: Color(0xFF070038)),
            )
          : SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    decoration: BoxDecoration(
                      color: bgSurfaceContainerLowest,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                        color: outlineVariant.withValues(alpha: 0.5),
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.02),
                          blurRadius: 4,
                          offset: const Offset(0, 1),
                        ),
                      ],
                    ),
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            width: 80,
                            height: 80,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: bgSurfaceContainer,
                              border: Border.all(
                                color: const Color(0xFFE4DFFF),
                                width: 2,
                              ),
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
                                      Icons.engineering,
                                      size: 40,
                                      color: secondaryColor,
                                    ),
                                    loadingBuilder: (context, child, loadingProgress) {
                                      if (loadingProgress == null) return child;
                                      return Center(
                                        child: SizedBox(
                                          width: 28,
                                          height: 28,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                            color: secondaryColor,
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
                                    Icons.engineering,
                                    size: 40,
                                    color: secondaryColor,
                                  ),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  name,
                                  style: const TextStyle(
                                    fontSize: 24,
                                    fontWeight: FontWeight.bold,
                                    color: textOnBackground,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  position,
                                  style: const TextStyle(
                                    fontSize: 16,
                                    color: textOnSurfaceVariant,
                                  ),
                                ),
                                const SizedBox(height: 8),
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 10,
                                    vertical: 4,
                                  ),
                                  decoration: BoxDecoration(
                                    color: Colors.green.shade50,
                                    borderRadius: BorderRadius.circular(20),
                                    border: Border.all(
                                      color: Colors.green.shade200,
                                    ),
                                  ),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(
                                        Icons.check_circle,
                                        size: 14,
                                        color: Colors.green.shade700,
                                      ),
                                      const SizedBox(width: 4),
                                      Text(
                                        'Aktif',
                                        style: TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.bold,
                                          color: Colors.green.shade800,
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
                    ),
                  ),
                  const SizedBox(height: 24),
                  Container(
                    decoration: BoxDecoration(
                      color: bgSurfaceContainerLowest,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                        color: outlineVariant.withValues(alpha: 0.5),
                      ),
                    ),
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Kontak & area',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w600,
                            color: textOnBackground,
                          ),
                        ),
                        const Divider(height: 24),
                        _buildContactItem(
                          Icons.smartphone,
                          'Nomor HP',
                          phone.isNotEmpty ? phone : '—',
                          primaryColor,
                          bgSurfaceContainer,
                          onTap: phone.isNotEmpty
                              ? () {
                                  final digits = phone.replaceAll(
                                    RegExp(r'\s'),
                                    '',
                                  );
                                  launchUrl(Uri.parse('tel:$digits'));
                                }
                              : null,
                        ),
                        const SizedBox(height: 16),
                        _buildContactItem(
                          Icons.email,
                          'Email',
                          (email != null && email.isNotEmpty) ? email : '—',
                          primaryColor,
                          bgSurfaceContainer,
                          onTap: (email != null && email.isNotEmpty)
                              ? () => launchUrl(Uri.parse('mailto:$email'))
                              : null,
                        ),
                        const SizedBox(height: 16),
                        _buildContactItem(
                          Icons.map_outlined,
                          'Area coverage',
                          areaDisplay,
                          primaryColor,
                          bgSurfaceContainer,
                          onTap: null,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),
                  Container(
                    decoration: BoxDecoration(
                      color: bgSurfaceContainerLow,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                        color: outlineVariant.withValues(alpha: 0.5),
                      ),
                    ),
                    child: Column(
                      children: [
                        ListTile(
                          leading: Container(
                            width: 40,
                            height: 40,
                            decoration: BoxDecoration(
                              color: bgSurfaceContainer,
                              shape: BoxShape.circle,
                            ),
                            child: const Icon(
                              Icons.system_update,
                              color: primaryColor,
                              size: 22,
                            ),
                          ),
                          title: const Text(
                            'Update aplikasi',
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: 16,
                              color: textOnBackground,
                            ),
                          ),
                          subtitle: const Text(
                            'Periksa versi terbaru dan instal APK',
                            style: TextStyle(
                              fontSize: 13,
                              color: textOnSurfaceVariant,
                            ),
                          ),
                          trailing: const Icon(
                            Icons.chevron_right,
                            color: outlineVariant,
                          ),
                          onTap: () {
                            Navigator.of(context).push<void>(
                              MaterialPageRoute<void>(
                                builder: (_) => const AppUpdateScreen(),
                              ),
                            );
                          },
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),
                  Container(
                    decoration: BoxDecoration(
                      color: bgSurfaceContainerLowest,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                        color: outlineVariant.withValues(alpha: 0.5),
                      ),
                    ),
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Row(
                          children: [
                            Icon(Icons.work_history, color: secondaryColor),
                            SizedBox(width: 8),
                            Text(
                              'Riwayat selesai teknisi',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w600,
                                color: textOnBackground,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 16),
                        if (_recentTasks.isEmpty)
                          const Text(
                            'Belum ada tugas berstatus selesai.',
                            style: TextStyle(color: textOnSurfaceVariant),
                          )
                        else
                          Column(
                            children: _recentTasks.map((t) {
                              final title = t['title']?.toString() ?? 'Tugas';
                              final when = _fmtDate(
                                t['activity_at']?.toString(),
                              );
                              return _buildHistoryItem(title, when, 'Selesai');
                            }).toList(),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 48),
                ],
              ),
            ),
    );
  }

  Widget _buildHistoryItem(String title, String date, String status) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFF6F1FF),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: const Color(0xFFC8C4D3).withValues(alpha: 0.5),
        ),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF19163F),
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  date,
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xFF474551),
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: Colors.green.shade50,
              borderRadius: BorderRadius.circular(4),
              border: Border.all(color: Colors.green.shade200),
            ),
            child: Text(
              status,
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.bold,
                color: Colors.green.shade700,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildContactItem(
    IconData icon,
    String label,
    String value,
    Color iconColor,
    Color bgIconColor, {
    VoidCallback? onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4.0),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: bgIconColor,
                shape: BoxShape.circle,
              ),
              child: Icon(icon, color: iconColor, size: 20),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label.toUpperCase(),
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF474551),
                      letterSpacing: 1.1,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    value,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF19163F),
                    ),
                  ),
                ],
              ),
            ),
            if (onTap != null)
              const Icon(
                Icons.chevron_right,
                color: Color(0xFFC8C4D3),
                size: 20,
              ),
          ],
        ),
      ),
    );
  }

  void _showLogoutDialog(BuildContext context, AuthProvider auth) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Keluar'),
        content: const Text('Yakin ingin keluar dari aplikasi?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Batal'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              auth.logout();
            },
            child: const Text('Keluar', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
  }
}
