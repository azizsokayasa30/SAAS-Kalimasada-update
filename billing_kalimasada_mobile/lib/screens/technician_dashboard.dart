import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../store/auth_provider.dart';
import '../store/customer_provider.dart';
import '../store/task_provider.dart';
import '../store/notification_provider.dart';
import 'notifications_screen.dart';
import 'technician_profile_screen.dart';
import 'attendance_screen.dart';
import 'network_status_screen.dart';
import 'customer_list_screen.dart';
import 'task_list_screen.dart';
import 'tag_location_screen.dart';
import 'tag_customer_location_screen.dart';

class TechnicianDashboard extends StatefulWidget {
  final void Function(int index, {String? taskListFilter})? onNavigateToTab;

  const TechnicianDashboard({super.key, this.onNavigateToTab});

  @override
  State<TechnicianDashboard> createState() => _TechnicianDashboardState();
}

class _TechnicianDashboardState extends State<TechnicianDashboard>
    with SingleTickerProviderStateMixin {
  /// Tinggi seragam kartu stat; mini card butuh ruang label tanpa overflow.
  static const double _statCardHeight = 132;

  late final AnimationController _pulseController;
  late final Animation<double> _pulseOpacity;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat(reverse: true);
    _pulseOpacity = Tween<double>(begin: 0.35, end: 1.0).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.read<CustomerProvider>().fetchDashboardStats();
      context.read<TaskProvider>().fetchTasks();
      context.read<TaskProvider>().fetchWeekPerformance();
      context.read<NotificationProvider>().fetchNotifications(silent: true);
    });
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  Future<void> _onPullRefreshDashboard() async {
    if (!mounted) return;
    await Future.wait<void>([
      context.read<CustomerProvider>().fetchDashboardStats(bustCache: true),
      context.read<TaskProvider>().fetchTasks(refresh: true),
      context.read<TaskProvider>().fetchWeekPerformance(refresh: true),
      context.read<NotificationProvider>().fetchNotifications(silent: true),
    ]);
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final provider = context.watch<CustomerProvider>();
    final taskProvider = context.watch<TaskProvider>();
    final stats = provider.stats;
    final openTasks = taskProvider.tasks.where((t) {
      final s = (t['status'] ?? '').toString().toLowerCase();
      return s != 'closed' && s != 'selesai';
    }).toList();
    final activeTasks = openTasks.length;
    final troubleCustomerIds = <int>{};
    for (final t in openTasks) {
      final type = (t['type'] ?? '').toString().toUpperCase();
      if (type != 'TR') continue;
      final rawCid = t['customer_id'];
      final cid = rawCid is int
          ? rawCid
          : int.tryParse(rawCid?.toString() ?? '');
      if (cid != null) troubleCustomerIds.add(cid);
    }
    final totalPlg = (stats['total'] as num?)?.toInt() ?? 0;
    final activePlgRaw = (stats['active'] as num?)?.toInt() ?? 0;
    final isolatedRaw = (stats['isolated'] as num?)?.toInt() ?? 0;
    final gangguanCount = math.max(isolatedRaw, troubleCustomerIds.length);
    final activePlg = math.max(0, activePlgRaw - troubleCustomerIds.length);
    final numFmt = NumberFormat.decimalPattern('id_ID');

    // Design Colors from Stitch
    const bgBackground = Color(0xFFF1ECF8);
    const bgSurfaceContainerLowest = Color(0xFFFFFFFF);
    const bgSurfaceContainerLow = Color(0xFFF6F1FF);

    const primaryColor = Color(0xFF2563EB);
    const primaryContainerColor = Color(0xFF1D4ED8);
    const surfaceTint = Color(0xFF2563EB);
    const secondaryColor = Color(0xFF7E4990);

    const textOnBackground = Color(0xFF19163F);
    const textOnSurfaceVariant = Color(0xFF474551);
    const textOnPrimary = Color(0xFFFFFFFF);
    const inversePrimary = Color(0xFFEAF2FF);
    const errorColor = Color(0xFFBA1A1A);

    final topInset = MediaQuery.paddingOf(context).top;
    final isAdmin = auth.role == 'admin';
    final displayName =
        auth.user?['name'] ??
        auth.user?['username'] ??
        (isAdmin ? 'Admin' : 'Teknisi');
    final displayArea = isAdmin
        ? 'Dashboard Admin'
        : (auth.user?['area_coverage'] ?? 'Indonesia');

    return Scaffold(
      backgroundColor: bgBackground,
      body: RefreshIndicator(
        color: surfaceTint,
        edgeOffset: topInset + 8,
        displacement: topInset + 32,
        triggerMode: RefreshIndicatorTriggerMode.onEdge,
        notificationPredicate: (ScrollNotification notification) {
          if (notification.metrics.axis != Axis.vertical) return false;
          if (notification.depth == 0) return true;
          return notification is OverscrollNotification &&
              notification.depth == 1;
        },
        onRefresh: _onPullRefreshDashboard,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(
              child: Container(
                padding: const EdgeInsets.only(
                  top: 48,
                  bottom: 32,
                  left: 16,
                  right: 16,
                ),
                decoration: const BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [primaryColor, primaryContainerColor],
                  ),
                  borderRadius: BorderRadius.only(
                    bottomLeft: Radius.circular(24),
                    bottomRight: Radius.circular(24),
                  ),
                ),
                child: Stack(
                  children: [
                    // Decorative elements
                    Positioned(
                      right: -40,
                      top: -40,
                      child: Container(
                        width: 160,
                        height: 160,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: surfaceTint.withValues(alpha: 0.2),
                        ),
                      ),
                    ),
                    Positioned(
                      left: -40,
                      bottom: 0,
                      child: Container(
                        width: 128,
                        height: 128,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: secondaryColor.withValues(alpha: 0.2),
                        ),
                      ),
                    ),

                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Hallo, $displayName',
                                  style: const TextStyle(
                                    color: textOnPrimary,
                                    fontSize: 22,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                Text(
                                  displayArea,
                                  style: const TextStyle(
                                    color: inversePrimary,
                                    fontSize: 14,
                                  ),
                                ),
                              ],
                            ),
                            Row(
                              children: [
                                Consumer<NotificationProvider>(
                                  builder: (context, notif, _) {
                                    final c = notif.unreadCount;
                                    return Stack(
                                      clipBehavior: Clip.none,
                                      children: [
                                        IconButton(
                                          onPressed: () {
                                            final notif = context
                                                .read<NotificationProvider>();
                                            Navigator.push(
                                              context,
                                              MaterialPageRoute(
                                                builder: (context) =>
                                                    const NotificationsScreen(),
                                              ),
                                            ).then((_) {
                                              notif.fetchNotifications(
                                                silent: true,
                                              );
                                            });
                                          },
                                          icon: const Icon(
                                            Icons.notifications_outlined,
                                            color: textOnPrimary,
                                          ),
                                          style: IconButton.styleFrom(
                                            backgroundColor: Colors.white
                                                .withValues(alpha: 0.1),
                                          ),
                                        ),
                                        if (c > 0)
                                          Positioned(
                                            right: 4,
                                            top: 4,
                                            child: Container(
                                              padding:
                                                  const EdgeInsets.symmetric(
                                                    horizontal: 5,
                                                    vertical: 2,
                                                  ),
                                              decoration: BoxDecoration(
                                                color: const Color(0xFFBA1A1A),
                                                borderRadius:
                                                    BorderRadius.circular(10),
                                                border: Border.all(
                                                  color: Colors.white
                                                      .withValues(alpha: 0.3),
                                                ),
                                              ),
                                              constraints: const BoxConstraints(
                                                minWidth: 18,
                                                minHeight: 18,
                                              ),
                                              child: Text(
                                                c > 99 ? '99+' : '$c',
                                                textAlign: TextAlign.center,
                                                style: const TextStyle(
                                                  color: Colors.white,
                                                  fontSize: 10,
                                                  fontWeight: FontWeight.w700,
                                                  height: 1.1,
                                                ),
                                              ),
                                            ),
                                          ),
                                      ],
                                    );
                                  },
                                ),
                                const SizedBox(width: 8),
                                GestureDetector(
                                  onTap: () {
                                    Navigator.push(
                                      context,
                                      MaterialPageRoute(
                                        builder: (context) =>
                                            const TechnicianProfileScreen(),
                                      ),
                                    );
                                  },
                                  child: Container(
                                    width: 48,
                                    height: 48,
                                    decoration: BoxDecoration(
                                      shape: BoxShape.circle,
                                      color: Colors.white.withValues(
                                        alpha: 0.1,
                                      ),
                                      border: Border.all(
                                        color: Colors.white.withValues(
                                          alpha: 0.1,
                                        ),
                                      ),
                                    ),
                                    child: const Icon(
                                      Icons.account_circle,
                                      color: textOnPrimary,
                                      size: 28,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Icon(Icons.update, color: inversePrimary, size: 14),
                            const SizedBox(width: 4),
                            Text(
                              'Last Updated: Today, 09:41 AM',
                              style: TextStyle(
                                color: inversePrimary,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),

            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 36, 20, 0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _buildTugasAktifHeroCard(
                      context: context,
                      activeTasks: activeTasks,
                      accentBlue: const Color(0xFFC4B5FD),
                      textOnPrimary: textOnPrimary,
                      pulseOpacity: _pulseOpacity,
                    ),
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: _buildPelangganMiniCard(
                            icon: Icons.groups_outlined,
                            iconBg: const Color(0xFFE8EAED),
                            iconColor: const Color(0xFF5F6368),
                            value: numFmt.format(totalPlg),
                            label: 'TOTAL PELANGGAN',
                            onTap: () {
                              if (widget.onNavigateToTab != null) {
                                widget.onNavigateToTab!(1);
                              } else {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (context) =>
                                        const CustomerListScreen(),
                                  ),
                                );
                              }
                            },
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _buildPelangganMiniCard(
                            icon: Icons.wifi,
                            iconBg: const Color(0xFF66DF75),
                            iconColor: Colors.black87,
                            value: numFmt.format(activePlg),
                            label: 'AKTIF',
                            onTap: () {
                              if (widget.onNavigateToTab != null) {
                                widget.onNavigateToTab!(1);
                              } else {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (context) =>
                                        const CustomerListScreen(),
                                  ),
                                );
                              }
                            },
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _buildGangguanWideCard(
                      context: context,
                      countText: numFmt.format(gangguanCount),
                      errorColor: errorColor,
                    ),
                    const SizedBox(height: 32),

                    // Quick Actions
                    const Text(
                      'QUICK ACTIONS',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: textOnSurfaceVariant,
                        letterSpacing: 1.2,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Container(
                      width: double.infinity,
                      height: 48,
                      decoration: BoxDecoration(
                        gradient: const LinearGradient(
                          colors: [primaryContainerColor, surfaceTint],
                        ),
                        borderRadius: BorderRadius.circular(12),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withValues(alpha: 0.1),
                            blurRadius: 4,
                            offset: const Offset(0, 2),
                          ),
                        ],
                      ),
                      child: ElevatedButton.icon(
                        onPressed: () {
                          Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (context) => const AttendanceScreen(),
                            ),
                          );
                        },
                        icon: const Icon(
                          Icons.touch_app,
                          color: textOnPrimary,
                          size: 20,
                        ),
                        label: const Text(
                          'Absensi',
                          style: TextStyle(
                            color: textOnPrimary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.transparent,
                          shadowColor: Colors.transparent,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        if (auth.role != 'technician') ...[
                          Expanded(
                            child: Container(
                              height: 48,
                              decoration: BoxDecoration(
                                color: bgSurfaceContainerLowest,
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(
                                  color: const Color(
                                    0xFFC8C4D3,
                                  ).withValues(alpha: 0.6),
                                ),
                              ),
                              child: InkWell(
                                onTap: () {},
                                borderRadius: BorderRadius.circular(12),
                                child: Row(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    Icon(
                                      Icons.add_task,
                                      color: surfaceTint,
                                      size: 20,
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      'Create Task',
                                      style: TextStyle(
                                        color: textOnBackground,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                        ],
                        Expanded(
                          child: Container(
                            height: 48,
                            decoration: BoxDecoration(
                              color: bgSurfaceContainerLowest,
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                color: const Color(
                                  0xFFC8C4D3,
                                ).withValues(alpha: 0.6),
                              ),
                            ),
                            child: InkWell(
                              onTap: () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (context) =>
                                        const NetworkStatusScreen(),
                                  ),
                                );
                              },
                              borderRadius: BorderRadius.circular(12),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Icon(
                                    Icons.wifi_tethering,
                                    color: surfaceTint,
                                    size: 20,
                                  ),
                                  const SizedBox(width: 8),
                                  Text(
                                    'Status Jaringan',
                                    style: TextStyle(
                                      color: textOnBackground,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: Container(
                            height: 48,
                            decoration: BoxDecoration(
                              color: bgSurfaceContainerLowest,
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                color: const Color(
                                  0xFFC8C4D3,
                                ).withValues(alpha: 0.6),
                              ),
                            ),
                            child: InkWell(
                              onTap: () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (context) =>
                                        const TagLocationScreen(),
                                  ),
                                );
                              },
                              borderRadius: BorderRadius.circular(12),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Icon(
                                    Icons.qr_code_scanner,
                                    color: surfaceTint,
                                    size: 20,
                                  ),
                                  const SizedBox(width: 8),
                                  Text(
                                    'Tag ODP',
                                    style: TextStyle(
                                      color: textOnBackground,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Container(
                            height: 48,
                            decoration: BoxDecoration(
                              color: bgSurfaceContainerLowest,
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                color: const Color(
                                  0xFFC8C4D3,
                                ).withValues(alpha: 0.6),
                              ),
                            ),
                            child: InkWell(
                              onTap: () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (context) =>
                                        const TagCustomerLocationScreen(),
                                  ),
                                );
                              },
                              borderRadius: BorderRadius.circular(12),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Icon(
                                    Icons.person_pin_circle_outlined,
                                    color: surfaceTint,
                                    size: 22,
                                  ),
                                  const SizedBox(width: 8),
                                  Flexible(
                                    child: Text(
                                      'Tag Pelanggan',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        color: textOnBackground,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),

                    const SizedBox(height: 32),
                    _buildPerformaAndaCard(
                      context: context,
                      taskProvider: taskProvider,
                      bgSurfaceContainerLowest: bgSurfaceContainerLowest,
                      bgSurfaceContainerLow: bgSurfaceContainerLow,
                      textOnBackground: textOnBackground,
                      textOnSurfaceVariant: textOnSurfaceVariant,
                      surfaceTint: surfaceTint,
                    ),

                    const SizedBox(height: 32),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTugasAktifHeroCard({
    required BuildContext context,
    required int activeTasks,
    required Color accentBlue,
    required Color textOnPrimary,
    required Animation<double> pulseOpacity,
  }) {
    void goTasks() {
      if (widget.onNavigateToTab != null) {
        widget.onNavigateToTab!(2);
      } else {
        Navigator.push(
          context,
          MaterialPageRoute(builder: (context) => const TaskListScreen()),
        );
      }
    }

    return SizedBox(
      height: _statCardHeight,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: goTasks,
          borderRadius: BorderRadius.circular(16),
          child: Ink(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(16),
              gradient: const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [Color(0xFF3D2B6E), Color(0xFF1E1038)],
              ),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF12082A).withValues(alpha: 0.55),
                  blurRadius: 18,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Stack(
                clipBehavior: Clip.hardEdge,
                children: [
                  Positioned(
                    right: 4,
                    top: 0,
                    bottom: 0,
                    child: Center(
                      child: Icon(
                        Icons.engineering,
                        size: 118,
                        color: textOnPrimary.withValues(alpha: 0.14),
                      ),
                    ),
                  ),
                  Positioned(
                    top: 8,
                    right: 10,
                    child: FadeTransition(
                      opacity: pulseOpacity,
                      child: Container(
                        width: 13,
                        height: 13,
                        decoration: BoxDecoration(
                          color: const Color(0xFF66DF75),
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: const Color(
                                0xFF66DF75,
                              ).withValues(alpha: 0.7),
                              blurRadius: 8,
                              spreadRadius: 1,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        Expanded(
                          child: Padding(
                            padding: const EdgeInsets.only(right: 56),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Text(
                                  'TUGAS AKTIF',
                                  style: TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w700,
                                    letterSpacing: 0.7,
                                    color: textOnPrimary.withValues(
                                      alpha: 0.55,
                                    ),
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Row(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.baseline,
                                  textBaseline: TextBaseline.alphabetic,
                                  children: [
                                    Text(
                                      '$activeTasks',
                                      style: TextStyle(
                                        fontSize: 28,
                                        fontWeight: FontWeight.w800,
                                        height: 1,
                                        color: textOnPrimary,
                                        letterSpacing: -0.5,
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    Flexible(
                                      child: Text(
                                        'Tiket & PSB',
                                        style: TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.w600,
                                          color: accentBlue,
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ],
                                ),
                                if (activeTasks > 0) ...[
                                  const SizedBox(height: 6),
                                  FadeTransition(
                                    opacity: pulseOpacity,
                                    child: Text(
                                      'menunggu dikerjakan',
                                      style: TextStyle(
                                        fontSize: 12,
                                        fontWeight: FontWeight.w800,
                                        letterSpacing: 0.15,
                                        color: const Color(0xFF66DF75),
                                        shadows: [
                                          Shadow(
                                            color: const Color(
                                              0xFF66DF75,
                                            ).withValues(alpha: 0.55),
                                            blurRadius: 8,
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ),
                        Material(
                          color: const Color(0xFF12082A),
                          shape: const CircleBorder(),
                          child: InkWell(
                            customBorder: const CircleBorder(),
                            onTap: goTasks,
                            child: Padding(
                              padding: const EdgeInsets.all(11),
                              child: Icon(
                                Icons.arrow_forward,
                                color: textOnPrimary,
                                size: 20,
                              ),
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
      ),
    );
  }

  Widget _buildPelangganMiniCard({
    required IconData icon,
    required Color iconBg,
    required Color iconColor,
    required String value,
    required String label,
    VoidCallback? onTap,
  }) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Ink(
          decoration: BoxDecoration(
            color: const Color(0xFFF3F4F6),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: const Color(0xFFE0E2E6)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.04),
                blurRadius: 8,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          child: SizedBox(
            height: _statCardHeight,
            width: double.infinity,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 38,
                        height: 38,
                        decoration: BoxDecoration(
                          color: iconBg,
                          shape: BoxShape.circle,
                        ),
                        child: Icon(icon, color: iconColor, size: 21),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    value,
                    style: const TextStyle(
                      fontSize: 21,
                      fontWeight: FontWeight.w800,
                      height: 1.05,
                      color: Color(0xFF191C1D),
                      letterSpacing: -0.5,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    label,
                    style: const TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w700,
                      height: 1.1,
                      letterSpacing: 0.5,
                      color: Color(0xFF5F6368),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildGangguanWideCard({
    required BuildContext context,
    required String countText,
    required Color errorColor,
  }) {
    final borderRed = Color.lerp(errorColor, Colors.white, 0.55)!;
    final bgTint = const Color(0xFFFFF1F1);

    void openDaftarTiket() {
      if (widget.onNavigateToTab != null) {
        widget.onNavigateToTab!(2, taskListFilter: 'Tiket');
      } else {
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) =>
                const TaskListScreen(initialTaskTypeFilter: 'Tiket'),
          ),
        );
      }
    }

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: openDaftarTiket,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          decoration: BoxDecoration(
            color: bgTint,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: borderRed, width: 1.2),
            boxShadow: [
              BoxShadow(
                color: errorColor.withValues(alpha: 0.08),
                blurRadius: 10,
                offset: const Offset(0, 3),
              ),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: errorColor.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.warning_amber_rounded,
                  color: errorColor,
                  size: 28,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      countText,
                      style: TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.w800,
                        color: errorColor,
                        height: 1,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'GANGGUAN',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.6,
                        color: errorColor,
                      ),
                    ),
                  ],
                ),
              ),
              FilledButton(
                onPressed: openDaftarTiket,
                style: FilledButton.styleFrom(
                  backgroundColor: errorColor,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 18,
                    vertical: 12,
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                  elevation: 0,
                ),
                child: const Text(
                  'AYO CEK',
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 12,
                    letterSpacing: 0.5,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPerformaAndaCard({
    required BuildContext context,
    required TaskProvider taskProvider,
    required Color bgSurfaceContainerLowest,
    required Color bgSurfaceContainerLow,
    required Color textOnBackground,
    required Color textOnSurfaceVariant,
    required Color surfaceTint,
  }) {
    const taskBarColor = Color(0xFF2E7D32);
    const attBarColor = Color(0xFF5A53AB);
    final days = taskProvider.weekPerfDays;
    int taskMax = taskProvider.tasksWeekMaxPerDay;
    for (final d in days) {
      final n = (d['tasks_completed'] as num?)?.toInt() ?? 0;
      taskMax = math.max(taskMax, n);
    }
    if (taskMax < 1) taskMax = 1;

    final subtitleParts = <String>[
      '${taskProvider.tasksWeekTotal} tugas selesai',
      if (taskProvider.employeeMatched)
        'absensi rata-rata ${taskProvider.attendanceWeekAvg.toStringAsFixed(0)}%'
      else
        'absensi: hubungkan HP ke data karyawan',
    ];

    Widget chartBody;
    if (taskProvider.weekPerfLoading && days.isEmpty) {
      chartBody = const SizedBox(
        height: 150,
        child: Center(
          child: SizedBox(
            width: 28,
            height: 28,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    } else if (taskProvider.weekPerfError != null && days.isEmpty) {
      chartBody = SizedBox(
        height: 150,
        child: Center(
          child: TextButton.icon(
            onPressed: () => context.read<TaskProvider>().fetchWeekPerformance(
              refresh: true,
            ),
            icon: const Icon(Icons.refresh, size: 20),
            label: const Text('Muat ulang performa'),
          ),
        ),
      );
    } else if (days.isEmpty) {
      chartBody = const SizedBox(
        height: 150,
        child: Center(child: Text('Belum ada data minggu ini.')),
      );
    } else {
      chartBody = SizedBox(
        height: 150,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            for (final day in days)
              _buildPerformanceDayColumn(
                label: (day['weekday'] ?? '') as String,
                isToday: day['is_today'] == true,
                tasksCompleted: (day['tasks_completed'] as num?)?.toInt() ?? 0,
                tasksMaxForScale: taskMax,
                attendanceScore:
                    (day['attendance_score'] as num?)?.toInt() ?? 0,
                tintColor: surfaceTint,
                taskBarColor: taskBarColor,
                attBarColor: attBarColor,
              ),
          ],
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: bgSurfaceContainerLowest,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: const Color(0xFFC8C4D3).withValues(alpha: 0.4),
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Performa Anda',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                  color: textOnBackground,
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: bgSurfaceContainerLow,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: const Color(0xFFC8C4D3).withValues(alpha: 0.5),
                  ),
                ),
                child: Text(
                  'MINGGU INI',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: textOnSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            subtitleParts.join(' · '),
            style: TextStyle(
              fontSize: 12,
              height: 1.35,
              color: textOnSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              _perfLegendDot(taskBarColor, 'Tugas', textOnSurfaceVariant),
              const SizedBox(width: 16),
              _perfLegendDot(attBarColor, 'Absensi', textOnSurfaceVariant),
            ],
          ),
          const SizedBox(height: 8),
          chartBody,
        ],
      ),
    );
  }

  Widget _perfLegendDot(Color color, String text, Color textColor) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 6),
        Text(
          text,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: textColor,
          ),
        ),
      ],
    );
  }

  Widget _buildPerformanceDayColumn({
    required String label,
    required bool isToday,
    required int tasksCompleted,
    required int tasksMaxForScale,
    required int attendanceScore,
    required Color tintColor,
    required Color taskBarColor,
    required Color attBarColor,
  }) {
    const double barMaxH = 108.0;
    final taskRatio = (tasksCompleted / tasksMaxForScale).clamp(0.0, 1.0);
    final attRatio = (attendanceScore / 100).clamp(0.0, 1.0);
    final taskH = barMaxH * taskRatio;
    final attH = barMaxH * attRatio;
    final border = isToday
        ? Border.all(color: tintColor.withValues(alpha: 0.45), width: 1.2)
        : null;

    return Expanded(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(8),
                border: border,
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Expanded(
                    child: Align(
                      alignment: Alignment.bottomCenter,
                      child: Container(
                        height: taskH < 2 && tasksCompleted > 0 ? 2.0 : taskH,
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.bottomCenter,
                            end: Alignment.topCenter,
                            colors: isToday
                                ? [
                                    taskBarColor.withValues(alpha: 0.95),
                                    taskBarColor.withValues(alpha: 0.48),
                                  ]
                                : [
                                    taskBarColor.withValues(alpha: 0.72),
                                    taskBarColor.withValues(alpha: 0.32),
                                  ],
                          ),
                          borderRadius: const BorderRadius.vertical(
                            top: Radius.circular(4),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 3),
                  Expanded(
                    child: Align(
                      alignment: Alignment.bottomCenter,
                      child: Container(
                        height: attH < 2 && attendanceScore > 0 ? 2.0 : attH,
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.bottomCenter,
                            end: Alignment.topCenter,
                            colors: isToday
                                ? [
                                    attBarColor,
                                    attBarColor.withValues(alpha: 0.52),
                                  ]
                                : [
                                    attBarColor.withValues(alpha: 0.7),
                                    attBarColor.withValues(alpha: 0.32),
                                  ],
                          ),
                          borderRadius: const BorderRadius.vertical(
                            top: Radius.circular(4),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11,
                fontWeight: isToday ? FontWeight.bold : FontWeight.w500,
                color: isToday ? tintColor : const Color(0xFF474551),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
