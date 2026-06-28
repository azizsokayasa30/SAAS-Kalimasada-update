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
        return Icons.engineering;
      case 'TR':
        return Icons.build_circle_outlined;
      case 'LEAVE':
        return Icons.event_note;
      default:
        return Icons.notifications_outlined;
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
    const bgBackground = Color(0xFFFCF8FF);
    const textOnSurface = Color(0xFF19163F);
    const textOnSurfaceVariant = Color(0xFF474551);

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
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(color: const Color(0xFFE2E8F0), height: 1),
        ),
      ),
      body: Consumer<NotificationProvider>(
        builder: (context, notif, _) {
          if (notif.loading && notif.items.isEmpty) {
            return const Center(
              child: CircularProgressIndicator(color: Color(0xFF070038)),
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
                      child: const Text('Coba lagi'),
                    ),
                  ],
                ),
              ),
            );
          }
          if (notif.items.isEmpty) {
            return const Center(
              child: Text(
                'Belum ada notifikasi tugas.',
                style: TextStyle(color: textOnSurfaceVariant, fontSize: 16),
              ),
            );
          }
          return RefreshIndicator(
            color: const Color(0xFF070038),
            onRefresh: () => notif.fetchNotifications(),
            child: ListView.builder(
              padding: const EdgeInsets.all(20),
              itemCount: notif.items.length,
              itemBuilder: (context, index) {
                final item = notif.items[index];
                final unread = item['unread'] == true;
                final title = item['title']?.toString() ?? 'Tugas';
                final body = item['body']?.toString() ?? '';
                final created = item['created_at']?.toString();
                final kind = item['kind']?.toString();
                return Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Material(
                    color: Colors.transparent,
                    child: InkWell(
                      borderRadius: BorderRadius.circular(8),
                      onTap: () => _openTaskFromNotification(item),
                      child: Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFC8C4D3)),
                          boxShadow: unread
                              ? const [
                                  BoxShadow(
                                    color: Colors.black12,
                                    blurRadius: 4,
                                    offset: Offset(0, 2),
                                  ),
                                ]
                              : null,
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (unread)
                              Container(
                                width: 8,
                                height: 8,
                                margin: const EdgeInsets.only(
                                  top: 20,
                                  right: 8,
                                ),
                                decoration: const BoxDecoration(
                                  color: Color(0xFF070038),
                                  shape: BoxShape.circle,
                                ),
                              )
                            else
                              const SizedBox(width: 16),
                            Container(
                              width: 48,
                              height: 48,
                              decoration: BoxDecoration(
                                color: unread
                                    ? const Color(
                                        0xFF1B0C6B,
                                      ).withValues(alpha: 0.15)
                                    : const Color(0xFFE4DFFF),
                                shape: BoxShape.circle,
                              ),
                              child: Icon(
                                _iconForKind(kind),
                                color: unread
                                    ? const Color(0xFF1B0C6B)
                                    : textOnSurfaceVariant,
                              ),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      Expanded(
                                        child: Text(
                                          title,
                                          style: const TextStyle(
                                            fontSize: 16,
                                            fontWeight: FontWeight.bold,
                                            color: textOnSurface,
                                          ),
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                      Text(
                                        _relativeTime(created),
                                        style: const TextStyle(
                                          fontSize: 12,
                                          color: textOnSurfaceVariant,
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    body,
                                    style: const TextStyle(
                                      fontSize: 14,
                                      color: textOnSurfaceVariant,
                                    ),
                                    maxLines: 3,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    _hintForKind(kind),
                                    style: TextStyle(
                                      fontSize: 12,
                                      color: const Color(
                                        0xFF1B0C6B,
                                      ).withValues(alpha: 0.85),
                                      fontWeight: FontWeight.w600,
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
