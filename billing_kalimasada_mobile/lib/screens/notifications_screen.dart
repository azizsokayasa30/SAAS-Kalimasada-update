import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../store/notification_provider.dart';
import '../store/task_provider.dart';
import 'task_detail_screen.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _primarySoft = Color(0xFFEFF6FF);
  static const _bg = Color(0xFFF1F5F9);
  static const _textMain = Color(0xFF0F172A);
  static const _textMuted = Color(0xFF64748B);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<NotificationProvider>().fetchNotifications();
    });
  }

  String _relativeTime(String? iso) {
    if (iso == null || iso.isEmpty) return '';
    final t = DateTime.tryParse(iso);
    if (t == null) return '';
    final d = DateTime.now().difference(t);
    if (d.inSeconds < 60) return 'Baru saja';
    if (d.inMinutes < 60) return '${d.inMinutes} m lalu';
    if (d.inHours < 24) return '${d.inHours} j lalu';
    if (d.inDays < 7) return '${d.inDays} h lalu';
    return '${t.day.toString().padLeft(2, '0')}/${t.month.toString().padLeft(2, '0')}/${t.year}';
  }

  IconData _iconForKind(String? kind) {
    switch ((kind ?? '').toUpperCase()) {
      case 'INSTALL':
        return Icons.engineering_rounded;
      case 'TR':
        return Icons.build_circle_outlined;
      case 'LEAVE':
        return Icons.event_note_rounded;
      default:
        return Icons.notifications_rounded;
    }
  }

  Color _accentForKind(String? kind) {
    switch ((kind ?? '').toUpperCase()) {
      case 'INSTALL':
        return const Color(0xFF2563EB);
      case 'TR':
        return const Color(0xFFEA580C);
      case 'LEAVE':
        return const Color(0xFF7C3AED);
      default:
        return _primary;
    }
  }

  String _hintForKind(String? kind) {
    switch ((kind ?? '').toUpperCase()) {
      case 'LEAVE':
        return 'Izin/cuti · ketuk untuk tandai dibaca';
      case 'TR':
        return 'Tiket gangguan · ketuk untuk detail';
      default:
        return 'Instalasi · ketuk untuk detail';
    }
  }

  Future<void> _openTaskFromNotification(Map<String, dynamic> item) async {
    final notif = context.read<NotificationProvider>();
    final kindUpper = (item['kind'] ?? '').toString().toUpperCase();
    if (kindUpper == 'LEAVE') {
      final idRaw = item['id'];
      final nid = idRaw is int ? idRaw : int.tryParse(idRaw.toString());
      if (nid != null) {
        await notif.markRead(nid);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Riwayat keputusan ada di menu Absensi (maks. 30 hari).',
          ),
        ),
      );
      return;
    }
    final tasksProv = context.read<TaskProvider>();
    final idRaw = item['id'];
    final nid = idRaw is int ? idRaw : int.tryParse(idRaw.toString());
    if (nid != null) {
      await notif.markRead(nid);
    }
    await tasksProv.fetchTasks(refresh: true);
    if (!mounted) return;
    final kind = item['kind']?.toString() ?? '';
    final refId = item['ref_id']?.toString() ?? '';
    final tasks = tasksProv.tasks;
    Map<String, dynamic>? found;
    for (final raw in tasks) {
      if (raw is! Map) continue;
      final m = Map<String, dynamic>.from(raw);
      if (m['type']?.toString() == kind && m['id']?.toString() == refId) {
        found = m;
        break;
      }
    }
    if (!mounted) return;
    if (found != null) {
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => TaskDetailScreen(task: found!)),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Tugas belum muncul di daftar. Tarik untuk refresh di menu Tugas.',
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _primary,
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded, color: Colors.white),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text(
          'Notifikasi',
          style: TextStyle(
            color: Colors.white,
            fontSize: 18,
            fontWeight: FontWeight.bold,
          ),
        ),
        centerTitle: true,
        actions: [
          TextButton(
            onPressed: () async {
              final ms = ScaffoldMessenger.of(context);
              final n = context.read<NotificationProvider>();
              await n.markAllRead();
              if (mounted) {
                ms.showSnackBar(
                  const SnackBar(content: Text('Semua ditandai dibaca')),
                );
              }
            },
            child: const Text(
              'Tandai dibaca',
              style: TextStyle(color: Colors.white),
            ),
          ),
        ],
      ),
      body: Consumer<NotificationProvider>(
        builder: (context, notif, _) {
          if (notif.loading && notif.items.isEmpty) {
            return const Center(
              child: CircularProgressIndicator(color: _primary),
            );
          }
          if (notif.error != null && notif.items.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(notif.error!, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: () => notif.fetchNotifications(),
                      style: FilledButton.styleFrom(backgroundColor: _primary),
                      child: const Text('Coba lagi'),
                    ),
                  ],
                ),
              ),
            );
          }
          if (notif.items.isEmpty) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(
                      color: _primarySoft,
                      borderRadius: BorderRadius.circular(24),
                    ),
                    child: const Icon(
                      Icons.notifications_none_rounded,
                      size: 36,
                      color: _primary,
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'Belum ada notifikasi',
                    style: TextStyle(
                      color: _textMain,
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Notifikasi tugas baru akan muncul di sini.',
                    style: TextStyle(color: _textMuted, fontSize: 14),
                  ),
                ],
              ),
            );
          }
          return RefreshIndicator(
            color: _primary,
            onRefresh: () => notif.fetchNotifications(),
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              itemCount: notif.items.length,
              separatorBuilder: (_, _) => const SizedBox(height: 12),
              itemBuilder: (context, index) {
                final item = notif.items[index];
                final unread = item['unread'] == true;
                final title = item['title']?.toString() ?? 'Tugas';
                final body = item['body']?.toString() ?? '';
                final created = item['created_at']?.toString();
                final kind = item['kind']?.toString();
                final accent = _accentForKind(kind);

                return Material(
                  color: Colors.transparent,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(20),
                    onTap: () => _openTaskFromNotification(item),
                    child: Ink(
                      decoration: BoxDecoration(
                        color: unread ? _primarySoft : Colors.white,
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(
                          color: unread
                              ? accent.withValues(alpha: 0.28)
                              : const Color(0xFFE2E8F0),
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: const Color(0xFF0F172A).withValues(
                              alpha: unread ? 0.07 : 0.04,
                            ),
                            blurRadius: 14,
                            offset: const Offset(0, 4),
                          ),
                        ],
                      ),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Stack(
                              clipBehavior: Clip.none,
                              children: [
                                Container(
                                  width: 48,
                                  height: 48,
                                  decoration: BoxDecoration(
                                    color: accent.withValues(
                                      alpha: unread ? 0.16 : 0.10,
                                    ),
                                    borderRadius: BorderRadius.circular(16),
                                  ),
                                  child: Icon(
                                    _iconForKind(kind),
                                    color: accent,
                                    size: 24,
                                  ),
                                ),
                                if (unread)
                                  Positioned(
                                    right: -2,
                                    top: -2,
                                    child: Container(
                                      width: 12,
                                      height: 12,
                                      decoration: BoxDecoration(
                                        color: const Color(0xFFEF4444),
                                        shape: BoxShape.circle,
                                        border: Border.all(
                                          color: Colors.white,
                                          width: 2,
                                        ),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                            const SizedBox(width: 14),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Expanded(
                                        child: Text(
                                          title,
                                          style: TextStyle(
                                            fontSize: 15,
                                            fontWeight: unread
                                                ? FontWeight.w800
                                                : FontWeight.w700,
                                            color: _textMain,
                                            height: 1.25,
                                          ),
                                          maxLines: 2,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      Text(
                                        _relativeTime(created),
                                        style: const TextStyle(
                                          fontSize: 11,
                                          fontWeight: FontWeight.w600,
                                          color: _textMuted,
                                        ),
                                      ),
                                    ],
                                  ),
                                  if (body.isNotEmpty) ...[
                                    const SizedBox(height: 6),
                                    Text(
                                      body,
                                      style: const TextStyle(
                                        fontSize: 13,
                                        color: _textMuted,
                                        height: 1.35,
                                      ),
                                      maxLines: 3,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ],
                                  const SizedBox(height: 10),
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 10,
                                      vertical: 5,
                                    ),
                                    decoration: BoxDecoration(
                                      color: accent.withValues(alpha: 0.10),
                                      borderRadius: BorderRadius.circular(999),
                                    ),
                                    child: Text(
                                      _hintForKind(kind),
                                      style: TextStyle(
                                        fontSize: 11,
                                        color: accent,
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
