import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../theme/colors.dart';
import '../store/auth_provider.dart';
import '../store/notification_provider.dart';
import '../store/customer_provider.dart';
import '../store/task_provider.dart';
import '../screens/login_screen.dart';
import '../screens/technician_dashboard.dart';
import '../screens/collector/collector_home_tab.dart';
import '../theme/collector_colors.dart';
import '../screens/collector/collector_settlement_tab.dart';
import '../screens/collector/collector_profile_tab.dart';
import '../store/collector_provider.dart';
import '../store/collector_notification_provider.dart';
import '../screens/collector/collector_notifications_screen.dart';
import '../screens/customer_list_screen.dart';
import '../screens/collector/collector_customers_screen.dart';
import '../utils/collector_debug_log.dart';

import '../screens/technician_profile_screen.dart';
import '../screens/task_list_screen.dart';
import '../screens/network_menu_screen.dart';
import '../screens/network_map_screen.dart';
import '../screens/admin/admin_dashboard_screen.dart';
import '../screens/admin/admin_customer_overview_screen.dart';
import '../screens/admin/admin_more_screen.dart';
import '../widgets/app_update_dialog.dart';

class RootNavigator extends StatefulWidget {
  const RootNavigator({super.key});

  @override
  State<RootNavigator> createState() => _RootNavigatorState();
}

class _RootNavigatorState extends State<RootNavigator>
    with WidgetsBindingObserver {
  bool _updateCheckDone = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkAppUpdateOnce());
  }

  Future<void> _checkAppUpdateOnce() async {
    if (_updateCheckDone || !mounted) return;
    _updateCheckDone = true;
    await showAppUpdateDialogIfNeeded(context);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      context.read<AuthProvider>().checkSessionExpiry();
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();

    if (!auth.isInitialized) {
      return const Scaffold(
        backgroundColor: AppColors.background,
        body: Center(
          child: CircularProgressIndicator(color: AppColors.primary),
        ),
      );
    }

    if (auth.token == null) {
      return const LoginScreen();
    }

    if (auth.role == 'technician') {
      return const _TechnicianTabs();
    } else if (auth.role == 'collector') {
      return const _CollectorTabs();
    } else {
      return const _AdminTabs();
    }
  }
}

class _TechnicianTabs extends StatefulWidget {
  const _TechnicianTabs();

  @override
  State<_TechnicianTabs> createState() => _TechnicianTabsState();
}

class _TechnicianTabsState extends State<_TechnicianTabs> {
  int _currentIndex = 0;

  /// Dipakai saat buka tab Tugas (mis. filter Tiket dari dashboard); `null` = Semua.
  String? _taskListInitialFilter;
  NotificationProvider? _notificationProvider;
  Set<int> _seenUnreadTroubleNotifIds = <int>{};

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_notificationProvider == null) {
      _notificationProvider = context.read<NotificationProvider>();
      _notificationProvider!.addListener(_onNotificationProviderChanged);
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final n = context.read<NotificationProvider>();
      n.ensurePolling();
      n.fetchNotifications(silent: true);
    });
  }

  @override
  void dispose() {
    _notificationProvider?.removeListener(_onNotificationProviderChanged);
    _notificationProvider?.stopPolling();
    super.dispose();
  }

  void _onNotificationProviderChanged() {
    final notif = _notificationProvider;
    if (notif == null || !mounted) return;

    final unreadTroubleIds = <int>{};
    for (final item in notif.items) {
      final kind = (item['kind'] ?? '').toString().toUpperCase();
      final unread = item['unread'] == true;
      if (kind != 'TR' || !unread) continue;
      final rawId = item['id'];
      final id = rawId is int ? rawId : int.tryParse(rawId?.toString() ?? '');
      if (id != null) unreadTroubleIds.add(id);
    }

    final hasNewTroubleNotif = unreadTroubleIds.any(
      (id) => !_seenUnreadTroubleNotifIds.contains(id),
    );
    _seenUnreadTroubleNotifIds = unreadTroubleIds;
    if (!hasNewTroubleNotif) return;

    // Saat tiket gangguan baru masuk, sinkronkan data agar badge/status pelanggan
    // dan angka pelanggan aktif di dashboard langsung ikut berubah.
    context.read<TaskProvider>().fetchTasks(refresh: true);
    context.read<CustomerProvider>().fetchDashboardStats();
  }

  void _navigateToTab(int index, {String? taskListFilter}) {
    setState(() {
      _currentIndex = index;
      if (index == 2) {
        _taskListInitialFilter = taskListFilter;
      } else {
        _taskListInitialFilter = null;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final List<Widget> screens = [
      TechnicianDashboard(onNavigateToTab: _navigateToTab),
      const CustomerListScreen(),
      TaskListScreen(
        key: ValueKey('tasks_${_taskListInitialFilter ?? 'all'}'),
        onNavigateToTab: _navigateToTab,
        initialTaskTypeFilter: _taskListInitialFilter,
      ),
      const NetworkMapScreen(),
      const TechnicianProfileScreen(),
    ];

    return Scaffold(
      body: screens[_currentIndex],
      // We will implement the custom bottom nav bar matching Stitch design inside the Scaffold's bottomNavigationBar
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: const Color(0xFFF9F8FC).withValues(alpha: 0.9),
          border: const Border(top: BorderSide(color: Color(0x4DC8C4D3))),
          boxShadow: const [
            BoxShadow(
              color: Color(0x0D000000),
              offset: Offset(0, -10),
              blurRadius: 20,
              spreadRadius: -5,
            ),
          ],
          borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                _buildNavItem(0, Icons.home, 'Dashboard'),
                _buildNavItem(1, Icons.group, 'Pelanggan'),
                _buildNavItem(2, Icons.assignment, 'Tugas'),
                _buildNavItem(3, Icons.wifi, 'Jaringan'),
                _buildNavItem(4, Icons.account_circle, 'Profil'),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildNavItem(int index, IconData icon, String label) {
    final isSelected = _currentIndex == index;
    final activeColor = const Color(0xFF2563EB);
    final inactiveColor = const Color(0xFF64748B);

    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _navigateToTab(index),
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.topCenter,
        children: [
          if (isSelected)
            Positioned(
              top: -8,
              child: Container(
                width: 32,
                height: 4,
                decoration: BoxDecoration(
                  color: activeColor,
                  borderRadius: const BorderRadius.vertical(
                    bottom: Radius.circular(4),
                  ),
                ),
              ),
            ),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 48,
                height: 32,
                decoration: BoxDecoration(
                  color: isSelected
                      ? const Color(0xFFDBEAFE).withValues(alpha: 0.7)
                      : Colors.transparent,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Icon(
                  icon,
                  color: isSelected ? activeColor : inactiveColor,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: isSelected ? FontWeight.w600 : FontWeight.w500,
                  color: isSelected ? activeColor : inactiveColor,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _CollectorTabs extends StatefulWidget {
  const _CollectorTabs();

  @override
  State<_CollectorTabs> createState() => _CollectorTabsState();
}

class _CollectorTabsState extends State<_CollectorTabs> {
  int _currentIndex = 0;
  int _customersSyncStamp = 0;
  String _customersInitialStatus = '';
  CollectorNotificationProvider? _collectorNotif;

  Future<void> _syncAll() async {
    final col = context.read<CollectorProvider>();
    await Future.wait([
      col.fetchOverview(),
      col.fetchSettlement(),
      col.fetchMe(),
      col.fetchCustomers(
        status: col.lastCustomersFetchStatus,
        q: col.lastCustomersFetchQ,
        area: col.lastCustomersFetchArea,
      ),
    ]);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _collectorNotif ??= context.read<CollectorNotificationProvider>();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _syncAll();
      final n =
          _collectorNotif ?? context.read<CollectorNotificationProvider>();
      n.ensurePolling();
      n.fetchNotifications(silent: true);
    });
  }

  @override
  void dispose() {
    _collectorNotif?.stopPolling();
    super.dispose();
  }

  void _goCustomersTab([String status = '']) {
    collectorDbg(
      'Nav: dashboard → Pelanggan filter="$status" '
      '(stamp $_customersSyncStamp→${_customersSyncStamp + 1})',
    );
    setState(() {
      _currentIndex = 1;
      _customersInitialStatus = status;
      _customersSyncStamp++;
    });
  }

  void _onNavTap(int i) {
    setState(() => _currentIndex = i);
    final col = context.read<CollectorProvider>();
    if (i == 0) col.fetchOverview();
    if (i == 1) {
      col.fetchCustomers(
        status: col.lastCustomersFetchStatus,
        q: col.lastCustomersFetchQ,
        area: col.lastCustomersFetchArea,
      );
    }
    if (i == 2) col.fetchSettlement();
    if (i == 3) col.fetchMe();
  }

  @override
  Widget build(BuildContext context) {
    const bg = FieldCollectorColors.dashboardCanvas;
    final titles = ['Field Collector', 'Pelanggan', 'Setoran', 'Profil'];
    final notif = context.watch<CollectorNotificationProvider>();
    final unread = notif.unreadCount;

    final body = IndexedStack(
      index: _currentIndex,
      children: [
        CollectorHomeTab(onOpenCustomersList: _goCustomersTab),
        CollectorCustomersScreen(
          onSync: _syncAll,
          initialStatus: _customersInitialStatus,
          syncStamp: _customersSyncStamp,
        ),
        const CollectorSettlementTab(),
        const CollectorProfileTab(),
      ],
    );

    // ThemeData lengkap (bukan hanya colorScheme) agar FilterChip/M3 tidak null di runtime.
    return Theme(
      data: ThemeData.light(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: bg,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF001F3F),
          brightness: Brightness.light,
        ),
      ),
      child: Scaffold(
        backgroundColor: bg,
        // Tab Pelanggan = layar penuh seperti teknisi (CustomerListScreen punya AppBar sendiri).
        appBar: _currentIndex == 1
            ? null
            : AppBar(
                backgroundColor: Colors.white,
                foregroundColor: const Color(0xFF001F3F),
                elevation: 0,
                surfaceTintColor: Colors.transparent,
                title: Text(
                  titles[_currentIndex],
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 18,
                  ),
                ),
                leading: IconButton(
                  icon: const Icon(Icons.menu),
                  onPressed: () {
                    setState(() => _currentIndex = 3);
                    context.read<CollectorProvider>().fetchMe();
                  },
                ),
                actions: [
                  IconButton(
                    tooltip: 'Notifikasi',
                    iconSize: 32,
                    padding: const EdgeInsets.all(10),
                    constraints: const BoxConstraints(
                      minWidth: 48,
                      minHeight: 48,
                    ),
                    onPressed: () async {
                      final nav = Navigator.of(context);
                      final notifProv = context
                          .read<CollectorNotificationProvider>();
                      await nav.push<void>(
                        MaterialPageRoute<void>(
                          builder: (_) => const CollectorNotificationsScreen(),
                        ),
                      );
                      await notifProv.fetchNotifications(silent: true);
                    },
                    icon: Stack(
                      clipBehavior: Clip.none,
                      alignment: Alignment.center,
                      children: [
                        const Icon(Icons.notifications_outlined, size: 32),
                        if (unread > 0)
                          Positioned(
                            right: 0,
                            top: -1,
                            child: Container(
                              width: 11,
                              height: 11,
                              decoration: const BoxDecoration(
                                color: Color(0xFFFF1744),
                                shape: BoxShape.circle,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
                bottom: const PreferredSize(
                  preferredSize: Size.fromHeight(1),
                  child: Divider(height: 1),
                ),
              ),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: body),
            if (_currentIndex == 1) _collectorCustomersStatsBar(),
          ],
        ),
        bottomNavigationBar: Container(
          decoration: BoxDecoration(
            color: Colors.white,
            border: Border(top: BorderSide(color: Colors.grey.shade200)),
            boxShadow: const [
              BoxShadow(
                color: Color(0x0D000000),
                blurRadius: 10,
                offset: Offset(0, -2),
              ),
            ],
          ),
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  _collectorNavItem(0, Icons.dashboard, 'Dashboard'),
                  _collectorNavItem(1, Icons.group, 'Pelanggan'),
                  _collectorNavItem(2, Icons.payments, 'Setoran'),
                  _collectorNavItem(3, Icons.account_circle, 'Profil'),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  String _collectorStripRupiah(int n) {
    return 'Rp ${NumberFormat.decimalPattern('id_ID').format(n)}';
  }

  Widget _collectorCustomersStatsBar() {
    return Consumer<CollectorProvider>(
      builder: (context, col, _) {
        var count = 0;
        var total = 0;
        for (final raw in col.customers) {
          if (raw is Map) {
            count++;
            final m = Map<String, dynamic>.from(raw);
            final p = m['package_price'];
            final n = p is num
                ? p.round()
                : int.tryParse(p?.toString() ?? '') ?? 0;
            total += n;
          }
        }
        final hasArea = col.lastCustomersFetchArea.isNotEmpty;
        return Material(
          color: Colors.transparent,
          elevation: 0,
          child: Container(
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [Color(0xFFB8DAFF), Color(0xFFA8E6CF)],
              ),
              border: Border(top: BorderSide(color: Color(0x4D1565C0))),
              boxShadow: [
                BoxShadow(
                  color: Color(0x14000000),
                  blurRadius: 8,
                  offset: Offset(0, -2),
                ),
              ],
            ),
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '$count pelanggan',
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 15,
                          color: Color(0xFF0D2847),
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Total paket ${_collectorStripRupiah(total)}',
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 13,
                          color: Color(0xFF1B3A52),
                        ),
                      ),
                    ],
                  ),
                ),
                if (hasArea)
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 160),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFFE3F2FD),
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(color: const Color(0xFF90CAF9)),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.filter_alt,
                            size: 14,
                            color: Color(0xFF1565C0),
                          ),
                          const SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              col.lastCustomersFetchArea,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                color: Color(0xFF0D47A1),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _collectorNavItem(int index, IconData icon, String label) {
    final sel = _currentIndex == index;
    const active = Color(0xFF001F3F);
    const inactive = Color(0xFF94A3B8);
    return InkWell(
      onTap: () => _onNavTap(index),
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              decoration: BoxDecoration(
                color: sel ? const Color(0xFFF1F5F9) : Colors.transparent,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: sel ? active : inactive, size: 24),
            ),
            const SizedBox(height: 2),
            Text(
              label,
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.4,
                color: sel ? active : inactive,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AdminTabs extends StatefulWidget {
  const _AdminTabs();

  @override
  State<_AdminTabs> createState() => _AdminTabsState();
}

class _AdminTabsState extends State<_AdminTabs> {
  int _currentIndex = 0;
  String? _taskListInitialFilter;

  void _navigateToTab(int index, {String? taskListFilter}) {
    setState(() {
      _currentIndex = index;
      if (index == 2) {
        _taskListInitialFilter = taskListFilter;
      } else {
        _taskListInitialFilter = null;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final screens = [
      AdminDashboardScreen(onNavigateToTab: _navigateToTab),
      const AdminCustomerOverviewScreen(),
      TaskListScreen(
        key: ValueKey('admin_tasks_${_taskListInitialFilter ?? 'all'}'),
        onNavigateToTab: _navigateToTab,
        initialTaskTypeFilter: _taskListInitialFilter,
      ),
      const NetworkMenuScreen(),
      const AdminMoreScreen(),
    ];

    return Scaffold(
      body: screens[_currentIndex],
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          border: const Border(top: BorderSide(color: Color(0xFFE7ECF5))),
          boxShadow: const [
            BoxShadow(
              color: Color(0x140F172A),
              offset: Offset(0, -8),
              blurRadius: 22,
              spreadRadius: -10,
            ),
          ],
          borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                _buildAdminNavItem(
                  0,
                  Icons.home_rounded,
                  'Beranda',
                  const Color(0xFF2563EB),
                ),
                _buildAdminNavItem(
                  1,
                  Icons.groups_rounded,
                  'Pelanggan',
                  const Color(0xFF14B8A6),
                ),
                _buildAdminNavItem(
                  2,
                  Icons.confirmation_number_rounded,
                  'Tugas',
                  const Color(0xFF2563EB),
                ),
                _buildAdminNavItem(
                  3,
                  Icons.router_rounded,
                  'Jaringan',
                  const Color(0xFF8B5CF6),
                ),
                _buildAdminNavItem(
                  4,
                  Icons.menu_rounded,
                  'Lainnya',
                  const Color(0xFF64748B),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildAdminNavItem(
    int index,
    IconData icon,
    String label,
    Color color,
  ) {
    final isSelected = _currentIndex == index;
    const inactiveColor = Color(0xFF64748B);

    return Expanded(
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: () => _navigateToTab(index),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(vertical: 6),
          decoration: BoxDecoration(
            color: isSelected
                ? color.withValues(alpha: 0.14)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 38,
                height: 30,
                decoration: BoxDecoration(
                  color: isSelected
                      ? color.withValues(alpha: 0.12)
                      : Colors.transparent,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Icon(
                  icon,
                  size: 23,
                  color: isSelected ? color : inactiveColor,
                ),
              ),
              const SizedBox(height: 3),
              AnimatedDefaultTextStyle(
                duration: const Duration(milliseconds: 180),
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: isSelected ? FontWeight.w800 : FontWeight.w600,
                  color: isSelected ? color : inactiveColor,
                ),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
