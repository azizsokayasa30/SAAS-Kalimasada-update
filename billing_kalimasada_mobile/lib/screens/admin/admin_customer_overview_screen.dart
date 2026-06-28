import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../services/api_client.dart';
import '../add_new_customer_screen.dart';
import '../customer_list_screen.dart';

const _customerTextStrong = Color(0xFF1E293B);
const _customerTextMuted = Color(0xFF64748B);
const _customerTextAccent = Color(0xFF2563EB);

class AdminCustomerOverviewScreen extends StatefulWidget {
  const AdminCustomerOverviewScreen({super.key});

  @override
  State<AdminCustomerOverviewScreen> createState() =>
      _AdminCustomerOverviewScreenState();
}

class _AdminCustomerOverviewScreenState
    extends State<AdminCustomerOverviewScreen> {
  static const _navy = Color(0xFF2563EB);
  static const _bg = Colors.white;
  static const _blue = Color(0xFF2E9DEB);
  static const _orange = Color(0xFFFF8A3D);
  static const _green = Color(0xFF62E642);
  static const _red = Color(0xFFE84C4F);
  static const _yellow = Color(0xFFE9B21B);
  static const _monthNames = [
    'Januari',
    'Februari',
    'Maret',
    'April',
    'Mei',
    'Juni',
    'Juli',
    'Agustus',
    'September',
    'Oktober',
    'November',
    'Desember',
  ];

  final _money = NumberFormat.currency(
    locale: 'id_ID',
    symbol: 'Rp. ',
    decimalDigits: 0,
  );
  Map<String, dynamic>? _data;
  bool _loading = true;
  String? _error;

  late int _month;
  late int _year;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _month = now.month;
    _year = now.year;
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await _fetchAdminOverview();
      setState(() {
        _data = data;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error =
            'Ringkasan pelanggan belum tersedia dari server. Silakan restart/deploy server billing lalu muat ulang.';
        _loading = false;
      });
    }
  }

  Future<Map<String, dynamic>> _fetchAdminOverview() async {
    try {
      final monthParam = _month == 0 ? 'all' : _month.toString();
      final response = await ApiClient.get(
        '/api/mobile-adapter/admin/customers/overview?month=$monthParam&year=$_year',
      );
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'admin/customers/overview',
      );
      if (response.statusCode == 200 &&
          ApiClient.jsonSuccess(body['success'])) {
        final raw = body['data'];
        if (raw is Map) return Map<String, dynamic>.from(raw);
      }
    } on FormatException {
      // Server yang belum direstart biasanya mengembalikan HTML 404 untuk endpoint baru.
    }

    return _fetchLegacyDashboardFallback();
  }

  Future<Map<String, dynamic>> _fetchLegacyDashboardFallback() async {
    final response = await ApiClient.get('/api/mobile-adapter/dashboard');
    final body = ApiClient.decodeJsonObject(
      response,
      debugLabel: 'admin/customers/fallback-dashboard',
    );
    if (response.statusCode != 200 || !ApiClient.jsonSuccess(body['success'])) {
      throw const FormatException('fallback dashboard tidak tersedia');
    }

    final inner = body['data'];
    final stats = inner is Map ? inner['stats'] : null;
    final m = stats is Map ? stats : const {};
    int numVal(dynamic v) {
      if (v is num) return v.round();
      return int.tryParse(v?.toString() ?? '') ?? 0;
    }

    final total = numVal(m['total_customers']);
    final suspended = numVal(m['suspended_customers']);
    final isolated = numVal(m['isolated_customers']);
    return {
      'period': {'month': _month, 'year': _year, 'month_name': _monthName},
      'notice':
          'Server belum memuat endpoint ringkasan baru. Menampilkan data dasar pelanggan.',
      'customers': {
        'total': total,
        'total_amount': 0,
        'active': numVal(m['active_customers']),
        'active_amount': 0,
        'new_this_month': 0,
        'new_this_month_amount': 0,
        'isolir_transactions': suspended,
        'isolir_cuti': isolated,
        'stopped': 0,
      },
      'invoices': {
        'unpaid_count': 0,
        'unpaid_amount': 0,
        'paid_count': 0,
        'paid_amount': 0,
      },
      'transactions': {
        'cash_count': 0,
        'cash_amount': 0,
        'online_count': 0,
        'online_amount': 0,
      },
      'late': {'overdue_count': 0, 'arrears_count': 0},
    };
  }

  int _intAt(String group, String key) {
    final section = _data?[group];
    final raw = section is Map ? section[key] : null;
    if (raw is num) return raw.round();
    return int.tryParse(raw?.toString() ?? '') ?? 0;
  }

  String _rupiahAt(String group, String key) =>
      _money.format(_intAt(group, key));

  String get _monthName {
    final period = _data?['period'];
    final name = period is Map ? period['month_name']?.toString() : null;
    if (name != null && name.isNotEmpty) return name;
    if (_month == 0) return 'Satu tahun';
    return _monthNames[_month - 1];
  }

  Future<void> _selectMonth(int? month) async {
    if (month == null || month == _month) return;
    setState(() => _month = month);
    await _load();
  }

  Future<void> _selectYear(int? year) async {
    if (year == null || year == _year) return;
    setState(() => _year = year);
    await _load();
  }

  void _openCustomers(String title, String adminFilter) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => CustomerListScreen(
          title: title,
          adminFilter: adminFilter,
          filterMonth: _month,
          filterYear: _year,
        ),
      ),
    );
  }

  void _openAllCustomers() {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => CustomerListScreen(
          title: 'Total Pelanggan $_monthName $_year',
          adminFilter: 'all',
          filterMonth: _month,
          filterYear: _year,
        ),
      ),
    );
  }

  Future<void> _openAddCustomer() async {
    await Navigator.push(
      context,
      MaterialPageRoute(builder: (context) => const AddNewCustomerScreen()),
    );
    if (mounted) await _load();
  }

  Widget _periodPill({
    required Widget child,
    EdgeInsets padding = const EdgeInsets.symmetric(horizontal: 14),
  }) {
    return Container(
      height: 42,
      padding: padding,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Center(child: child),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _navy,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text(
          'Pelanggan',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 22),
        ),
        centerTitle: true,
        actions: [
          TextButton.icon(
            onPressed: () {},
            icon: const Icon(Icons.info, color: Colors.orangeAccent),
            label: const Text('Info', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        color: _navy,
        child: _loading && _data == null
            ? const Center(child: CircularProgressIndicator(color: _navy))
            : _error != null && _data == null
            ? ListView(
                padding: const EdgeInsets.all(24),
                children: [
                  Text(
                    _error!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: _red),
                  ),
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: _load,
                    child: const Text('Muat ulang'),
                  ),
                ],
              )
            : _overviewBody(),
      ),
    );
  }

  Widget _overviewBody() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(10, 12, 10, 110),
      children: [
        Container(
          margin: const EdgeInsets.only(bottom: 16),
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.all(Radius.circular(18)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 16, 10, 8),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text(
                        'Filter Periode',
                        style: TextStyle(
                          color: _customerTextMuted,
                          fontSize: 14,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _periodPill(
                          child: DropdownButtonHideUnderline(
                            child: DropdownButton<int>(
                              value: _month,
                              dropdownColor: Colors.white,
                              borderRadius: BorderRadius.circular(18),
                              icon: const Icon(
                                Icons.expand_more,
                                color: _customerTextStrong,
                                size: 18,
                              ),
                              style: const TextStyle(
                                color: _customerTextStrong,
                                fontSize: 15,
                                fontWeight: FontWeight.w700,
                              ),
                              items: [
                                const DropdownMenuItem(
                                  value: 0,
                                  child: Text('Satu tahun'),
                                ),
                                for (var i = 0; i < _monthNames.length; i++)
                                  DropdownMenuItem(
                                    value: i + 1,
                                    child: Text(_monthNames[i]),
                                  ),
                              ],
                              onChanged: _loading ? null : _selectMonth,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        _periodPill(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: DropdownButtonHideUnderline(
                            child: DropdownButton<int>(
                              value: _year,
                              dropdownColor: Colors.white,
                              borderRadius: BorderRadius.circular(18),
                              icon: const Icon(
                                Icons.expand_more,
                                color: _customerTextStrong,
                                size: 18,
                              ),
                              style: const TextStyle(
                                color: _customerTextStrong,
                                fontSize: 15,
                                fontWeight: FontWeight.w700,
                              ),
                              items: [
                                for (
                                  var year = DateTime.now().year - 5;
                                  year <= DateTime.now().year + 1;
                                  year++
                                )
                                  DropdownMenuItem(
                                    value: year,
                                    child: Text('$year'),
                                  ),
                              ],
                              onChanged: _loading ? null : _selectYear,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
                child: _TotalCustomerCard(
                  value: '${_intAt('customers', 'total')}',
                  amount: _rupiahAt('customers', 'total_amount'),
                  onTap: _openAllCustomers,
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(6, 8, 6, 16),
                child: Column(
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: _MetricTile(
                            label: 'Pelanggan Aktif',
                            value: '${_intAt('customers', 'active')}',
                            amount: _rupiahAt('customers', 'active_amount'),
                            icon: Icons.verified_user_outlined,
                            iconColor: _orange,
                            onTap: () =>
                                _openCustomers('Pelanggan Aktif', 'active'),
                          ),
                        ),
                        Expanded(
                          child: _MetricTile(
                            label: 'Pelanggan Baru',
                            value: '${_intAt('customers', 'new_this_month')}',
                            amount: _rupiahAt(
                              'customers',
                              'new_this_month_amount',
                            ),
                            icon: Icons.person_add_alt_1,
                            iconColor: _blue,
                            onTap: () => _openCustomers(
                              'Pelanggan Baru $_monthName $_year',
                              'new',
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: _MetricTile(
                            label: 'Belum Bayar',
                            value: '${_intAt('invoices', 'unpaid_count')}',
                            amount: _rupiahAt('invoices', 'unpaid_amount'),
                            icon: Icons.receipt_long,
                            iconColor: Colors.grey,
                            onTap: () => _openCustomers(
                              'Belum Bayar $_monthName $_year',
                              'unpaid',
                            ),
                          ),
                        ),
                        Expanded(
                          child: _MetricTile(
                            label: 'Lunas Bayar',
                            value: '${_intAt('invoices', 'paid_count')}',
                            amount: _rupiahAt('invoices', 'paid_amount'),
                            icon: Icons.task_alt,
                            iconColor: _green,
                            onTap: () => _openCustomers(
                              'Lunas Bayar $_monthName $_year',
                              'paid',
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Center(
                      child: Text(
                        'Transaksi Bayar Bulan $_monthName $_year',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          color: _customerTextAccent,
                          fontSize: 16,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: _MetricTile(
                            label: 'Transaksi Cash',
                            value: '${_intAt('transactions', 'cash_count')}',
                            amount: _rupiahAt('transactions', 'cash_amount'),
                            icon: Icons.payments,
                            iconColor: Colors.green,
                            onTap: () => _openCustomers(
                              'Transaksi Cash $_monthName $_year',
                              'cash',
                            ),
                          ),
                        ),
                        Expanded(
                          child: _MetricTile(
                            label: 'Transaksi Online',
                            value: '${_intAt('transactions', 'online_count')}',
                            amount: _rupiahAt('transactions', 'online_amount'),
                            icon: Icons.account_balance_wallet,
                            iconColor: Colors.orange,
                            onTap: () => _openCustomers(
                              'Transaksi Online $_monthName $_year',
                              'online',
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: _SmallStatusTile(
                            label: 'Isolir',
                            value:
                                '${_intAt('customers', 'isolir_transactions')}',
                            onTap: () =>
                                _openCustomers('Pelanggan Isolir', 'isolir'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    FilledButton(
                      onPressed: _openAddCustomer,
                      style: FilledButton.styleFrom(
                        backgroundColor: _navy,
                        foregroundColor: Colors.white,
                        minimumSize: const Size.fromHeight(54),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(22),
                        ),
                      ),
                      child: const Text(
                        'TAMBAH PELANGGAN',
                        style: TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(18),
          ),
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              const Text(
                'Keterlambatan Bulan ini',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: _customerTextMuted,
                  fontSize: 15,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: _LateTile(
                      color: _yellow,
                      value: '${_intAt('late', 'overdue_count')}',
                      label: 'Pemb. Telat',
                      icon: Icons.event_busy,
                      onTap: () =>
                          _openCustomers('Pembayaran Telat', 'overdue'),
                    ),
                  ),
                  Expanded(
                    child: _LateTile(
                      color: _red,
                      value: '${_intAt('late', 'arrears_count')}',
                      label: 'Nunggak',
                      icon: Icons.warning_amber_rounded,
                      onTap: () =>
                          _openCustomers('Pelanggan Nunggak', 'arrears'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _MetricTile extends StatelessWidget {
  final String label;
  final String value;
  final String amount;
  final IconData icon;
  final Color iconColor;
  final VoidCallback? onTap;

  const _MetricTile({
    required this.label,
    required this.value,
    required this.amount,
    required this.icon,
    required this.iconColor,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: Container(
        height: 130,
        margin: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: const Color(0xFFE2E8F0)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 2),
            SizedBox(
              height: 32,
              child: Center(
                child: Text(
                  label,
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _customerTextMuted,
                    fontSize: 15,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 4),
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: iconColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(icon, color: iconColor, size: 25),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    value,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: _customerTextStrong,
                      fontSize: 27,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const Spacer(),
            SizedBox(
              height: 18,
              child: Text(
                amount,
                textAlign: TextAlign.left,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: _customerTextStrong,
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TotalCustomerCard extends StatelessWidget {
  final String value;
  final String amount;
  final VoidCallback onTap;

  const _TotalCustomerCard({
    required this.value,
    required this.amount,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: const Color(0xFFE2E8F0)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Row(
          children: [
            Container(
              width: 50,
              height: 50,
              decoration: BoxDecoration(
                color: const Color(0xFF2E9DEB).withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(14),
              ),
              child: const Icon(
                Icons.groups_rounded,
                color: Color(0xFF2E9DEB),
                size: 30,
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Total Pelanggan',
                    style: TextStyle(
                      color: _customerTextMuted,
                      fontSize: 15,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  Text(
                    value,
                    style: const TextStyle(
                      color: _customerTextStrong,
                      fontSize: 32,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    amount,
                    textAlign: TextAlign.left,
                    style: const TextStyle(
                      color: _customerTextStrong,
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: _customerTextMuted),
          ],
        ),
      ),
    );
  }
}

class _SmallStatusTile extends StatelessWidget {
  final String label;
  final String value;
  final VoidCallback? onTap;

  const _SmallStatusTile({
    required this.label,
    required this.value,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Text(
              label,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: _customerTextMuted,
                fontSize: 14,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: const Color(0xFFE84C4F).withValues(alpha: 0.11),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Icon(
                    Icons.block,
                    color: Color(0xFFE84C4F),
                    size: 27,
                  ),
                ),
                const SizedBox(width: 7),
                Text(
                  value,
                  style: const TextStyle(
                    fontSize: 26,
                    color: _customerTextStrong,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LateTile extends StatelessWidget {
  final Color color;
  final String value;
  final String label;
  final IconData icon;
  final VoidCallback? onTap;

  const _LateTile({
    required this.color,
    required this.value,
    required this.label,
    required this.icon,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: color, size: 26),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Text(
                  value,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: color,
                    fontSize: 31,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  label,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: _customerTextStrong,
                    fontSize: 14,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
