import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../attendance_screen.dart';
import '../../services/api_client.dart';
import '../../store/auth_provider.dart';
import 'admin_customer_overview_screen.dart';
import 'admin_finance_screen.dart';
import 'admin_warehouse_screen.dart';

class AdminDashboardScreen extends StatefulWidget {
  final void Function(int index)? onNavigateToTab;

  const AdminDashboardScreen({super.key, this.onNavigateToTab});

  @override
  State<AdminDashboardScreen> createState() => _AdminDashboardScreenState();
}

class _AdminDashboardScreenState extends State<AdminDashboardScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _primaryDark = Color(0xFF1D4ED8);
  static const _primarySoft = Color(0xFFEAF2FF);
  static const _bg = Color(0xFFF6F7FA);
  static const _trafficRouterName = 'Dell-R630-SKYNET';
  static const _defaultTrafficInterface = 'ether1-ISP';

  final _moneyCompact = NumberFormat.compactCurrency(
    locale: 'id_ID',
    symbol: 'Rp ',
    decimalDigits: 1,
  );
  final _countFormat = NumberFormat.decimalPattern('id_ID');

  bool _loading = true;
  bool _refreshing = false;
  String? _error;
  DateTime _now = DateTime.now();
  String? _tenantName;
  String? _logoFilename;
  Map<String, dynamic>? _dashboardStats;
  Map<String, dynamic>? _adminOverview;
  Map<String, dynamic>? _networkStatus;
  Map<String, dynamic>? _interfaceTraffic;
  String _trafficInterface = _defaultTrafficInterface;
  Timer? _networkTimer;
  Timer? _clockTimer;
  bool _networkRequestInFlight = false;
  final List<_TrafficSample> _trafficHistory = [];

  @override
  void initState() {
    super.initState();
    _loadDashboard();
    _startNetworkPolling();
    _startClock();
  }

  @override
  void dispose() {
    _networkTimer?.cancel();
    _clockTimer?.cancel();
    super.dispose();
  }

  void _startClock() {
    _clockTimer?.cancel();
    _clockTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _now = DateTime.now());
    });
  }

  void _startNetworkPolling() {
    _networkTimer?.cancel();
    _networkTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _refreshNetworkStatus(),
    );
  }

  Future<void> _refreshNetworkStatus() async {
    if (_networkRequestInFlight) return;
    _networkRequestInFlight = true;
    try {
      final results = await Future.wait<Map<String, dynamic>?>([
        _fetchNetworkStatus(<String>[]),
        _fetchMainInterfaceTraffic(<String>[]),
      ]);
      final interfaceTraffic =
          await _fetchMainInterfaceTraffic(<String>[], status: results[0]) ??
          results[1];
      if (!mounted || results.every((item) => item == null)) return;
      setState(() {
        if (results[0] != null) _networkStatus = results[0];
        if (interfaceTraffic != null) _interfaceTraffic = interfaceTraffic;
        _rememberTraffic(_currentTraffic());
      });
    } finally {
      _networkRequestInFlight = false;
    }
  }

  Future<void> _loadDashboard({bool refresh = false}) async {
    if (!mounted) return;
    setState(() {
      if (refresh) {
        _refreshing = true;
      } else {
        _loading = true;
      }
      _error = null;
    });

    final errors = <String>[];
    final appInfo = await _fetchAppInfo(errors);
    _applyAppInfo(appInfo);

    final results = await Future.wait<Map<String, dynamic>?>([
      _fetchDashboardStats(errors),
      _fetchAdminOverview(errors),
      _fetchNetworkStatus(errors),
      _fetchMainInterfaceTraffic(errors),
    ]);
    final interfaceTraffic =
        await _fetchMainInterfaceTraffic(errors, status: results[2]) ??
        results[3];

    if (!mounted) return;
    setState(() {
      _dashboardStats = results[0];
      _adminOverview = results[1];
      _networkStatus = results[2];
      _interfaceTraffic = interfaceTraffic;
      _rememberTraffic(_currentTraffic());
      _error = results.every((item) => item == null) && errors.isNotEmpty
          ? errors.first
          : null;
      _loading = false;
      _refreshing = false;
    });
  }

  Future<Map<String, dynamic>?> _fetchDashboardStats(
    List<String> errors,
  ) async {
    try {
      final response = await ApiClient.get('/api/mobile-adapter/dashboard');
      if (response.statusCode != 200) {
        errors.add(
          'Dashboard backend belum tersedia (HTTP ${response.statusCode})',
        );
        return null;
      }
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'dashboard',
      );
      if (response.statusCode == 200 &&
          ApiClient.jsonSuccess(body['success'])) {
        final data = body['data'];
        if (data is Map && data['stats'] is Map) {
          return Map<String, dynamic>.from(data['stats'] as Map);
        }
      }
      errors.add(body['message']?.toString() ?? 'Dashboard tidak tersedia');
    } on FormatException {
      errors.add('Respons dashboard dari backend tidak valid.');
    } catch (e) {
      errors.add('Dashboard backend tidak dapat dihubungi.');
    }
    return null;
  }

  Future<Map<String, dynamic>?> _fetchAdminOverview(List<String> errors) async {
    final now = DateTime.now();
    try {
      final response = await ApiClient.get(
        '/api/mobile-adapter/admin/customers/overview?month=${now.month}&year=${now.year}',
      );
      if (response.statusCode != 200) {
        errors.add(
          'Ringkasan admin belum aktif di backend (HTTP ${response.statusCode}).',
        );
        return null;
      }
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'admin/customers/overview',
      );
      if (response.statusCode == 200 &&
          ApiClient.jsonSuccess(body['success'])) {
        final data = body['data'];
        if (data is Map) return Map<String, dynamic>.from(data);
      }
      errors.add(
        body['message']?.toString() ?? 'Ringkasan admin tidak tersedia',
      );
    } on FormatException {
      errors.add('Respons ringkasan admin dari backend tidak valid.');
    } catch (e) {
      errors.add('Ringkasan admin backend tidak dapat dihubungi.');
    }
    return null;
  }

  Future<Map<String, dynamic>?> _fetchNetworkStatus(List<String> errors) async {
    try {
      final response = await ApiClient.get(
        '/api/mobile-adapter/network-status',
      );
      if (response.statusCode != 200) {
        errors.add(
          'Status jaringan belum tersedia di backend (HTTP ${response.statusCode}).',
        );
        return null;
      }
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'network-status',
      );
      if (response.statusCode == 200 &&
          ApiClient.jsonSuccess(body['success'])) {
        return body;
      }
      errors.add(
        body['message']?.toString() ?? 'Status jaringan tidak tersedia',
      );
    } on FormatException {
      errors.add('Respons status jaringan dari backend tidak valid.');
    } catch (e) {
      errors.add('Status jaringan backend tidak dapat dihubungi.');
    }
    return null;
  }

  Future<Map<String, dynamic>?> _fetchMainInterfaceTraffic(
    List<String> errors, {
    Map<String, dynamic>? status,
  }) async {
    try {
      final interfaceParam = Uri.encodeComponent(_trafficInterface);
      final routerId = _mainRouterId(status ?? _networkStatus);
      if (routerId != null) {
        final response = await ApiClient.get(
          '/api/dashboard/interface-traffic?router_id=$routerId&interface=$interfaceParam',
        );
        if (response.statusCode == 200) {
          final body = ApiClient.decodeJsonObject(
            response,
            debugLabel: 'dashboard/interface-traffic',
          );
          final data = body['data'];
          if (ApiClient.jsonSuccess(body['success']) && data is Map) {
            return {
              'interface': data['interface'] ?? _trafficInterface,
              'rx_mbps': _numAt(Map<String, dynamic>.from(data), 'rxMbps'),
              'tx_mbps': _numAt(Map<String, dynamic>.from(data), 'txMbps'),
            };
          }
        }
      }

      final response = await ApiClient.get(
        '/api/dashboard/traffic?interface=$interfaceParam',
      );
      if (response.statusCode != 200) {
        errors.add(
          'Traffic interface utama belum tersedia (HTTP ${response.statusCode}).',
        );
        return null;
      }
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'dashboard/traffic',
      );
      if (ApiClient.jsonSuccess(body['success'])) return body;
      errors.add(
        body['message']?.toString() ?? 'Traffic interface utama gagal',
      );
    } on FormatException {
      errors.add('Respons traffic interface utama dari backend tidak valid.');
    } catch (_) {
      errors.add('Traffic interface utama backend tidak dapat dihubungi.');
    }
    return null;
  }

  String? _mainRouterId(Map<String, dynamic>? status) {
    final routersRaw = status?['routers'];
    if (routersRaw is! List || routersRaw.isEmpty) return null;
    final first = routersRaw.cast<dynamic>().firstWhere((item) {
      if (item is! Map) return false;
      final name = [
        item['name'],
        item['nas_identifier'],
        item['router_name'],
      ].map((value) => value?.toString().toLowerCase() ?? '');
      return name.any(
        (value) => value.contains(_trafficRouterName.toLowerCase()),
      );
    }, orElse: () => routersRaw.first);
    if (first is! Map) return null;
    final id = first['id'] ?? first['router_id'];
    final value = id?.toString().trim();
    return value == null || value.isEmpty ? null : value;
  }

  Future<Map<String, dynamic>?> _fetchAppInfo(List<String> errors) async {
    try {
      final response = await ApiClient.get('/api/mobile-adapter/app-info');
      if (response.statusCode != 200) return null;
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'mobile/app-info',
      );
      if (ApiClient.jsonSuccess(body['success']) && body['data'] is Map) {
        return Map<String, dynamic>.from(body['data'] as Map);
      }
    } catch (_) {
      // App info hanya untuk label header; jangan ganggu dashboard jika gagal.
    }
    return null;
  }

  void _applyAppInfo(Map<String, dynamic>? info) {
    if (info == null) return;
    final tenant = info['tenant_name']?.toString().trim();
    if (tenant != null && tenant.isNotEmpty) _tenantName = tenant;
    final logo = info['logo_filename']?.toString().trim();
    if (logo != null && logo.isNotEmpty) _logoFilename = logo;
    final mainInterface = info['main_interface']?.toString().trim();
    if (mainInterface != null && mainInterface.isNotEmpty) {
      _trafficInterface = mainInterface;
    }
  }

  num _numAt(Map<String, dynamic>? map, String key) {
    final value = map?[key];
    if (value is num) return value;
    return num.tryParse('${value ?? ''}') ?? 0;
  }

  Map<String, dynamic>? _mapAt(Map<String, dynamic>? map, String key) {
    final value = map?[key];
    if (value is Map) return Map<String, dynamic>.from(value);
    return null;
  }

  String _formatMoney(dynamic value) {
    final amount = value is num ? value : num.tryParse('${value ?? ''}') ?? 0;
    return amount <= 0 ? 'Rp 0' : _moneyCompact.format(amount);
  }

  String _formatCount(dynamic value) {
    final amount = value is num ? value : num.tryParse('${value ?? ''}') ?? 0;
    return _countFormat.format(amount.round());
  }

  String _formatTraffic(num value) {
    if (value <= 0) return '-';
    return '${value.toStringAsFixed(2)} Mbps';
  }

  ({num rx, num tx}) _networkTraffic() {
    return _currentTraffic();
  }

  ({num rx, num tx}) _networkTrafficFrom(Map<String, dynamic>? status) {
    final routersRaw = status?['routers'];
    if (routersRaw is! List) return (rx: 0, tx: 0);
    num rx = 0;
    num tx = 0;
    for (final item in routersRaw) {
      if (item is! Map) continue;
      rx += _numAt(Map<String, dynamic>.from(item), 'rx_mbps');
      tx += _numAt(Map<String, dynamic>.from(item), 'tx_mbps');
    }
    return (rx: rx, tx: tx);
  }

  ({num rx, num tx}) _trafficFromMainInterface() {
    final rxMbps = _numAt(_interfaceTraffic, 'rx_mbps');
    final txMbps = _numAt(_interfaceTraffic, 'tx_mbps');
    if (rxMbps > 0 || txMbps > 0) return (rx: rxMbps, tx: txMbps);

    final rxBits = _numAt(_interfaceTraffic, 'rx');
    final txBits = _numAt(_interfaceTraffic, 'tx');
    if (rxBits <= 0 && txBits <= 0) return (rx: 0, tx: 0);
    return (rx: rxBits / 1000000, tx: txBits / 1000000);
  }

  ({num rx, num tx}) _currentTraffic() {
    final interfaceTraffic = _trafficFromMainInterface();
    if (interfaceTraffic.rx > 0 || interfaceTraffic.tx > 0) {
      return interfaceTraffic;
    }
    return _networkTrafficFrom(_networkStatus);
  }

  void _rememberTraffic(({num rx, num tx}) traffic) {
    _trafficHistory.add(
      _TrafficSample(rx: traffic.rx.toDouble(), tx: traffic.tx.toDouble()),
    );
    if (_trafficHistory.length > 24) {
      _trafficHistory.removeRange(0, _trafficHistory.length - 24);
    }
  }

  String _nasName() {
    final routersRaw = _networkStatus?['routers'];
    if (routersRaw is! List || routersRaw.isEmpty) return 'NAS';
    final first = routersRaw.first;
    if (first is! Map) return 'NAS';
    final router = Map<String, dynamic>.from(first);
    final name = router['name']?.toString().trim();
    if (name != null && name.isNotEmpty) return name;
    return router['nas_identifier']?.toString().trim().isNotEmpty == true
        ? router['nas_identifier'].toString()
        : router['nas_ip']?.toString().trim().isNotEmpty == true
        ? router['nas_ip'].toString()
        : 'NAS';
  }

  bool _isNasPingSafe() {
    final routersRaw = _networkStatus?['routers'];
    if (routersRaw is! List || routersRaw.isEmpty) return false;
    final first = routersRaw.first;
    if (first is! Map) return false;
    final status = first['status']?.toString().trim().toLowerCase();
    return status == 'online';
  }

  String _dateLabel() {
    return DateFormat(
      'EEEE, d MMMM yyyy HH:mm:ss',
      'id_ID',
    ).format(_now).toUpperCase();
  }

  String _companyLogoUrl() {
    final logo = (_logoFilename != null && _logoFilename!.trim().isNotEmpty)
        ? _logoFilename!.trim()
        : 'logo.png';
    return Uri.parse(
      ApiClient.apiOrigin,
    ).replace(path: '/public/img/$logo').toString();
  }

  String _trafficInterfaceName() {
    final interface = _interfaceTraffic?['interface']?.toString().trim();
    if (interface != null && interface.isNotEmpty) return interface;
    return _trafficInterface;
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final user = auth.user ?? <String, dynamic>{};
    final displayName = user['name']?.toString().trim().isNotEmpty == true
        ? user['name'].toString()
        : user['username']?.toString().trim().isNotEmpty == true
        ? user['username'].toString()
        : 'Admin';
    final tenantName =
        _tenantName ??
        user['tenant_name']?.toString() ??
        user['company_header']?.toString() ??
        user['company']?.toString() ??
        'Tenant';
    final customers = _mapAt(_adminOverview, 'customers');
    final invoices = _mapAt(_adminOverview, 'invoices');
    final networkSummary = _mapAt(_networkStatus, 'summary');
    final traffic = _networkTraffic();
    final notice = _adminOverview?['notice']?.toString();

    return Scaffold(
      backgroundColor: _bg,
      body: RefreshIndicator(
        color: _primary,
        onRefresh: () => _loadDashboard(refresh: true),
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            Container(
              padding: EdgeInsets.fromLTRB(
                18,
                MediaQuery.paddingOf(context).top + 18,
                18,
                20,
              ),
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [_primary, _primaryDark],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
              ),
              child: Row(
                children: [
                  Container(
                    width: 54,
                    height: 54,
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(18),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.12),
                          blurRadius: 14,
                          offset: const Offset(0, 6),
                        ),
                      ],
                    ),
                    padding: const EdgeInsets.all(8),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Image.network(
                        _companyLogoUrl(),
                        fit: BoxFit.contain,
                        errorBuilder: (context, error, stackTrace) =>
                            const Icon(
                              Icons.business_rounded,
                              color: _primary,
                              size: 30,
                            ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Selamat Datang: $displayName',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 20,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          'AREA: $tenantName',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        Text(
                          _dateLabel(),
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Muat ulang',
                    onPressed: _refreshing
                        ? null
                        : () => _loadDashboard(refresh: true),
                    icon: _refreshing
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(
                            Icons.refresh_rounded,
                            color: Colors.white,
                            size: 30,
                          ),
                  ),
                ],
              ),
            ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 18, 16, 0),
                child: LinearProgressIndicator(
                  color: _primary,
                  backgroundColor: _primarySoft,
                ),
              ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
                child: _DashboardNotice(message: _error!),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 0),
              child: Row(
                children: [
                  Expanded(
                    child: _MetricCard(
                      title: 'PENDAPATAN BULAN',
                      value: _formatMoney(invoices?['paid_amount']),
                      gradientColors: const [
                        Color(0xFF0EA5E9),
                        Color(0xFF2563EB),
                      ],
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: _MetricCard(
                      title: 'PELANGGAN AKTIF',
                      value: _formatCount(_dashboardStats?['active_customers']),
                      growth:
                          'Total ${_formatCount(_dashboardStats?['total_customers'] ?? customers?['total'])}',
                      gradientColors: const [
                        Color(0xFF10B981),
                        Color(0xFF14B8A6),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: GridView.count(
                crossAxisCount: 3,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 14,
                crossAxisSpacing: 12,
                childAspectRatio: 1.08,
                children: [
                  _AdminDrawerMenuItem(
                    label: 'Pelanggan',
                    icon: Icons.groups_rounded,
                    color: const Color(0xFF2367F0),
                    onTap: () {
                      if (widget.onNavigateToTab != null) {
                        widget.onNavigateToTab!(1);
                        return;
                      }
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => const AdminCustomerOverviewScreen(),
                        ),
                      );
                    },
                  ),
                  _AdminDrawerMenuItem(
                    label: 'Jaringan',
                    icon: Icons.router_rounded,
                    color: const Color(0xFF6C5CE7),
                    onTap: () => widget.onNavigateToTab?.call(3),
                  ),
                  _AdminDrawerMenuItem(
                    label: 'Absensi',
                    icon: Icons.fingerprint_rounded,
                    color: const Color(0xFF10B981),
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => const AttendanceScreen(),
                        ),
                      );
                    },
                  ),
                  _AdminDrawerMenuItem(
                    label: 'Keuangan',
                    icon: Icons.payments_rounded,
                    color: const Color(0xFFE49A16),
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => const AdminFinanceScreen(),
                        ),
                      );
                    },
                  ),
                  _AdminDrawerMenuItem(
                    label: 'Tugas',
                    icon: Icons.assignment_turned_in_rounded,
                    color: const Color(0xFFE91E63),
                    onTap: () => widget.onNavigateToTab?.call(2),
                  ),
                  _AdminDrawerMenuItem(
                    label: 'Gudang',
                    icon: Icons.inventory_2_rounded,
                    color: const Color(0xFF5D6675),
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => const AdminWarehouseScreen(),
                        ),
                      );
                    },
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
              child: _TrafficCard(
                title: _nasName(),
                interfaceName: _trafficInterfaceName(),
                isPingSafe: _isNasPingSafe(),
                upstream: _formatTraffic(traffic.tx),
                downstream: _formatTraffic(traffic.rx),
                samples: _trafficHistory,
                statusLabel: _networkStatus == null
                    ? 'DATA BACKEND BELUM TERSEDIA'
                    : 'ONLINE ${_formatCount(networkSummary?['active'])}/${_formatCount(networkSummary?['total'])}',
                hasData: _networkStatus != null,
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      'Notifikasi Realtime',
                      style: TextStyle(
                        color: Color(0xFF222222),
                        fontSize: 17,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  TextButton(
                    onPressed: () {},
                    child: const Text(
                      'View All',
                      style: TextStyle(
                        color: Color(0xFF1B2A52),
                        fontWeight: FontWeight.w700,
                        decoration: TextDecoration.underline,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Column(
                children: [
                  if (notice != null && notice.trim().isNotEmpty)
                    _NotificationTile(
                      icon: Icons.receipt_long_rounded,
                      iconColor: const Color(0xFFE84C4F),
                      title: 'Ringkasan Tagihan',
                      subtitle: notice,
                      time: 'Live',
                    ),
                  if (notice != null && notice.trim().isNotEmpty)
                    const SizedBox(height: 10),
                  if (_networkStatus != null)
                    _NotificationTile(
                      icon: Icons.router_rounded,
                      iconColor: const Color(0xFF2F7DF6),
                      title: 'Status Jaringan',
                      subtitle:
                          'Online ${_formatCount(networkSummary?['active'])} dari ${_formatCount(networkSummary?['total'])} router/secret',
                      badge: 'LIVE',
                      time: 'Now',
                    )
                  else
                    const _EmptyNotificationTile(),
                  const SizedBox(height: 96),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DashboardNotice extends StatelessWidget {
  final String message;

  const _DashboardNotice({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF7ED),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFFED7AA)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(
            Icons.info_outline_rounded,
            color: Color(0xFFF97316),
            size: 20,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(
                color: Color(0xFF9A3412),
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MetricCard extends StatelessWidget {
  final String title;
  final String value;
  final String? growth;
  final List<Color> gradientColors;

  const _MetricCard({
    required this.title,
    required this.value,
    required this.gradientColors,
    this.growth,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 122,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: gradientColors,
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white.withValues(alpha: 0.20)),
        boxShadow: const [
          BoxShadow(
            color: Color(0x1A0F172A),
            blurRadius: 18,
            offset: Offset(0, 8),
            spreadRadius: -8,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              color: Colors.white70,
              fontSize: 12,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.5,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            value,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 22,
              fontWeight: FontWeight.w900,
            ),
          ),
          const Spacer(),
          if (growth != null)
            Row(
              children: [
                const Icon(
                  Icons.trending_up_rounded,
                  color: Colors.white,
                  size: 17,
                ),
                const SizedBox(width: 4),
                Text(
                  growth!,
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w800,
                    fontSize: 13,
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _BlinkingPingStatus extends StatefulWidget {
  final bool isSafe;

  const _BlinkingPingStatus({required this.isSafe});

  @override
  State<_BlinkingPingStatus> createState() => _BlinkingPingStatusState();
}

class _BlinkingPingStatusState extends State<_BlinkingPingStatus>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _opacity;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 850),
    )..repeat(reverse: true);
    _opacity = Tween<double>(
      begin: 0.35,
      end: 1,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.isSafe
        ? const Color(0xFF10B981)
        : const Color(0xFFEF4444);
    final bg = widget.isSafe
        ? const Color(0xFFEAFBF4)
        : const Color(0xFFFFEEF2);
    final label = widget.isSafe ? 'AMAN' : 'DOWN';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.22)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          FadeTransition(
            opacity: _opacity,
            child: CircleAvatar(radius: 4, backgroundColor: color),
          ),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 11,
              fontWeight: FontWeight.w900,
              letterSpacing: 0.4,
            ),
          ),
        ],
      ),
    );
  }
}

class _TrafficCard extends StatelessWidget {
  final String title;
  final String interfaceName;
  final bool isPingSafe;
  final String upstream;
  final String downstream;
  final List<_TrafficSample> samples;
  final String statusLabel;
  final bool hasData;

  const _TrafficCard({
    required this.title,
    required this.interfaceName,
    required this.isPingSafe,
    required this.upstream,
    required this.downstream,
    required this.samples,
    required this.statusLabel,
    required this.hasData,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE1E5EE)),
        boxShadow: const [
          BoxShadow(
            color: Color(0x0A000000),
            blurRadius: 12,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        children: [
          Row(
            children: [
              const Icon(Icons.query_stats_rounded, color: Color(0xFF18335B)),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: Color(0xFF20222C),
                        fontSize: 18,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    Text(
                      interfaceName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: Color(0xFF64748B),
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
              _BlinkingPingStatus(isSafe: isPingSafe),
            ],
          ),
          const SizedBox(height: 14),
          SizedBox(
            height: 148,
            child: Row(
              children: [
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [Color(0xFFEFF6FF), Color(0xFFF8FAFC)],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: const Color(0xFFDCEAFE)),
                    ),
                    child: Stack(
                      children: [
                        Positioned.fill(
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(16),
                            child: CustomPaint(
                              painter: _TrafficChartPainter(samples: samples),
                            ),
                          ),
                        ),
                        Positioned(
                          left: 12,
                          top: 12,
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 5,
                            ),
                            decoration: BoxDecoration(
                              color: Colors.white.withValues(alpha: 0.86),
                              borderRadius: BorderRadius.circular(999),
                              border: Border.all(
                                color: const Color(0xFFE2E8F0),
                              ),
                            ),
                            child: Row(
                              children: [
                                CircleAvatar(
                                  radius: 4,
                                  backgroundColor: hasData
                                      ? const Color(0xFF10B981)
                                      : const Color(0xFF94A3B8),
                                ),
                                const SizedBox(width: 5),
                                Text(
                                  statusLabel,
                                  style: TextStyle(
                                    color: hasData
                                        ? const Color(0xFF0F8F68)
                                        : const Color(0xFF64748B),
                                    fontSize: 10,
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const Positioned(
                          left: 12,
                          bottom: 10,
                          child: Row(
                            children: [
                              _TrafficLegendDot(
                                color: Color(0xFF2563EB),
                                label: 'Download',
                              ),
                              SizedBox(width: 10),
                              _TrafficLegendDot(
                                color: Color(0xFFF97316),
                                label: 'Upload',
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                SizedBox(
                  width: 112,
                  child: Column(
                    children: [
                      Expanded(
                        child: _TrafficMiniCard(
                          title: 'DOWNLOAD',
                          value: downstream,
                          icon: Icons.download_rounded,
                          color: const Color(0xFF2563EB),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Expanded(
                        child: _TrafficMiniCard(
                          title: 'UPLOAD',
                          value: upstream,
                          icon: Icons.upload_rounded,
                          color: const Color(0xFFF97316),
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
    );
  }
}

class _AdminDrawerMenuItem extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color color;
  final VoidCallback onTap;

  const _AdminDrawerMenuItem({
    required this.label,
    required this.icon,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    const radius = Radius.circular(20);
    final borderRadius = BorderRadius.circular(20);

    return Material(
      color: Colors.white,
      borderRadius: borderRadius,
      child: InkWell(
        onTap: onTap,
        borderRadius: borderRadius,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: const BorderRadius.all(radius),
            border: Border.all(color: const Color(0xFFE8EBF2)),
            boxShadow: const [
              BoxShadow(
                color: Color(0x08000000),
                blurRadius: 10,
                offset: Offset(0, 4),
              ),
            ],
          ),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.09),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Icon(icon, color: color, size: 28),
              ),
              const SizedBox(height: 10),
              Text(
                label,
                textAlign: TextAlign.center,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: Color(0xFF222222),
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TrafficMiniCard extends StatelessWidget {
  final String title;
  final String value;
  final IconData icon;
  final Color color;

  const _TrafficMiniCard({
    required this.title,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE7EAF1)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Row(
            children: [
              Icon(icon, size: 13, color: color),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF6A7080),
                    fontSize: 9.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: color,
              fontSize: 14,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;
  final String? badge;
  final String time;

  const _NotificationTile({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    this.badge,
    required this.time,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE4E8F0)),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 20,
            backgroundColor: iconColor.withValues(alpha: 0.12),
            child: Icon(icon, color: iconColor),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: Color(0xFF222222),
                    fontWeight: FontWeight.w900,
                    fontSize: 15,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: Color(0xFF687085),
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (badge != null && badge!.trim().isNotEmpty) ...[
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 7,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: iconColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(7),
                  ),
                  child: Text(
                    badge!,
                    style: TextStyle(
                      color: iconColor,
                      fontSize: 10,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
                const SizedBox(height: 9),
              ],
              Text(
                time,
                style: const TextStyle(color: Color(0xFF6A7080), fontSize: 10),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _EmptyNotificationTile extends StatelessWidget {
  const _EmptyNotificationTile();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE4E8F0)),
      ),
      child: const Row(
        children: [
          CircleAvatar(
            radius: 20,
            backgroundColor: Color(0xFFEAF2FF),
            child: Icon(
              Icons.notifications_none_rounded,
              color: Color(0xFF2563EB),
            ),
          ),
          SizedBox(width: 12),
          Expanded(
            child: Text(
              'Belum ada notifikasi realtime dari backend.',
              style: TextStyle(
                color: Color(0xFF687085),
                fontSize: 13,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TrafficSample {
  final double rx;
  final double tx;

  const _TrafficSample({required this.rx, required this.tx});
}

class _TrafficLegendDot extends StatelessWidget {
  final Color color;
  final String label;

  const _TrafficLegendDot({required this.color, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        CircleAvatar(radius: 4, backgroundColor: color),
        const SizedBox(width: 4),
        Text(
          label,
          style: const TextStyle(
            color: Color(0xFF64748B),
            fontSize: 10,
            fontWeight: FontWeight.w800,
          ),
        ),
      ],
    );
  }
}

class _TrafficChartPainter extends CustomPainter {
  final List<_TrafficSample> samples;

  const _TrafficChartPainter({required this.samples});

  @override
  void paint(Canvas canvas, Size size) {
    final chartRect = Rect.fromLTWH(12, 18, size.width - 24, size.height - 42);
    final gridPaint = Paint()
      ..color = const Color(0xFFCBD5E1).withValues(alpha: 0.42)
      ..strokeWidth = 1;

    for (var i = 0; i < 4; i++) {
      final y = chartRect.top + (chartRect.height / 3) * i;
      canvas.drawLine(
        Offset(chartRect.left, y),
        Offset(chartRect.right, y),
        gridPaint,
      );
    }

    if (samples.isEmpty) {
      final placeholderPaint = Paint()
        ..color = const Color(0xFF94A3B8).withValues(alpha: 0.38)
        ..strokeWidth = 3
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round;
      final path = Path()
        ..moveTo(chartRect.left, chartRect.center.dy)
        ..cubicTo(
          chartRect.left + chartRect.width * 0.22,
          chartRect.top + chartRect.height * 0.30,
          chartRect.left + chartRect.width * 0.45,
          chartRect.bottom,
          chartRect.right,
          chartRect.top + chartRect.height * 0.42,
        );
      canvas.drawPath(path, placeholderPaint);
      return;
    }

    var maxValue = 1.0;
    for (final point in samples) {
      if (point.rx > maxValue) maxValue = point.rx;
      if (point.tx > maxValue) maxValue = point.tx;
    }

    Path buildLine(double Function(_TrafficSample point) selector) {
      final path = Path();
      for (var i = 0; i < samples.length; i++) {
        final x = samples.length == 1
            ? chartRect.left
            : chartRect.left + (chartRect.width / (samples.length - 1)) * i;
        final normalized = (selector(samples[i]) / maxValue).clamp(0.0, 1.0);
        final y = chartRect.bottom - (chartRect.height * normalized);
        if (i == 0) {
          path.moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
      }
      return path;
    }

    Path buildArea(Path linePath) {
      final area = Path.from(linePath)
        ..lineTo(chartRect.right, chartRect.bottom)
        ..lineTo(chartRect.left, chartRect.bottom)
        ..close();
      return area;
    }

    final downloadPath = buildLine((point) => point.rx);
    final uploadPath = buildLine((point) => point.tx);
    final downloadPaint = Paint()
      ..color = const Color(0xFF2563EB)
      ..strokeWidth = 3
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final uploadPaint = Paint()
      ..color = const Color(0xFFF97316)
      ..strokeWidth = 3
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    canvas.drawPath(
      buildArea(downloadPath),
      Paint()
        ..shader = const LinearGradient(
          colors: [Color(0x662563EB), Color(0x002563EB)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        ).createShader(chartRect),
    );
    canvas.drawPath(
      buildArea(uploadPath),
      Paint()
        ..shader = const LinearGradient(
          colors: [Color(0x55F97316), Color(0x00F97316)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        ).createShader(chartRect),
    );
    canvas.drawPath(downloadPath, downloadPaint);
    canvas.drawPath(uploadPath, uploadPaint);

    final last = samples.last;
    final lastX = samples.length == 1 ? chartRect.left : chartRect.right;
    for (final entry in [
      (value: last.rx, color: const Color(0xFF2563EB)),
      (value: last.tx, color: const Color(0xFFF97316)),
    ]) {
      final normalized = (entry.value / maxValue).clamp(0.0, 1.0);
      final y = chartRect.bottom - (chartRect.height * normalized);
      canvas.drawCircle(Offset(lastX, y), 4.5, Paint()..color = Colors.white);
      canvas.drawCircle(Offset(lastX, y), 3, Paint()..color = entry.color);
    }
  }

  @override
  bool shouldRepaint(covariant _TrafficChartPainter oldDelegate) {
    return oldDelegate.samples != samples;
  }
}
