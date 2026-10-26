import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../services/api_client.dart';
import '../customer_detail_screen.dart';
import 'area_manager_collect_history_screen.dart';
import 'area_manager_receive_payment_screen.dart';
import 'area_manager_theme.dart';

/// Tagih pelanggan di wilayah Manager Area (pembayaran langsung, tanpa komisi).
class AreaManagerCollectScreen extends StatefulWidget {
  const AreaManagerCollectScreen({super.key});

  @override
  State<AreaManagerCollectScreen> createState() =>
      _AreaManagerCollectScreenState();
}

class _AreaManagerCollectScreenState extends State<AreaManagerCollectScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _bg = Color(0xFFF6F7FA);
  static const _textMain = Color(0xFF0F172A);
  static const _textMuted = Color(0xFF64748B);
  static const _pageSize = 30;
  static const _monthShort = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'Mei',
    'Jun',
    'Jul',
    'Agu',
    'Sep',
    'Okt',
    'Nov',
    'Des',
  ];

  final _searchCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  final _money = NumberFormat.currency(
    locale: 'id_ID',
    symbol: 'Rp ',
    decimalDigits: 0,
  );

  Timer? _debounce;
  bool _unpaidOnly = true;

  /// `null` = semua bulan (tanpa filter periode).
  int? _month = DateTime.now().month;
  int _year = DateTime.now().year;
  bool _loading = true;
  bool _loadingMore = false;
  bool _hasMore = false;
  int _page = 1;
  String? _error;
  Map<String, dynamic> _summary = const {};
  final List<Map<String, dynamic>> _items = [];

  @override
  void initState() {
    super.initState();
    _scrollCtrl.addListener(_onScroll);
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_hasMore || _loadingMore || _loading) return;
    if (_scrollCtrl.position.pixels >
        _scrollCtrl.position.maxScrollExtent - 300) {
      _load(more: true);
    }
  }

  void _onSearchChanged(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 450), () => _load());
  }

  Future<void> _load({bool more = false}) async {
    if (more) {
      setState(() => _loadingMore = true);
    } else {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    final page = more ? _page + 1 : 1;
    final query = Uri(
      queryParameters: {
        'page': '$page',
        'limit': '$_pageSize',
        'filter': _unpaidOnly ? 'unpaid' : 'all',
        if (_month != null) ...{'month': '$_month', 'year': '$_year'},
        if (_searchCtrl.text.trim().isNotEmpty)
          'search': _searchCtrl.text.trim(),
      },
    ).query;
    try {
      final r = await ApiClient.get(
        '/api/mobile-adapter/area-manager/collect/customers?$query',
      );
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'area-manager/collect/customers',
      );
      if (!mounted) return;
      if (r.statusCode == 200 && ApiClient.jsonSuccess(body['success'])) {
        final rows = (body['data'] as List? ?? const [])
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        final pagination = body['pagination'] is Map
            ? Map<String, dynamic>.from(body['pagination'] as Map)
            : const <String, dynamic>{};
        setState(() {
          if (!more) _items.clear();
          _items.addAll(rows);
          _page = page;
          _hasMore = pagination['has_more'] == true;
          if (body['summary'] is Map) {
            _summary = Map<String, dynamic>.from(body['summary'] as Map);
          }
        });
      } else {
        setState(() {
          _error = body['message']?.toString() ?? 'Gagal memuat pelanggan';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Gagal memuat pelanggan: $e');
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
          _loadingMore = false;
        });
      }
    }
  }

  num _num(dynamic v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;

  String _dueLabel(dynamic raw) {
    final d = DateTime.tryParse('${raw ?? ''}');
    if (d == null) return '';
    final today = DateTime.now();
    final days = DateTime(
      today.year,
      today.month,
      today.day,
    ).difference(DateTime(d.year, d.month, d.day)).inDays;
    final date = DateFormat('d MMM yyyy', 'id_ID').format(d);
    if (days > 0) return 'Jatuh tempo $date · lewat $days hari';
    return 'Jatuh tempo $date';
  }

  Future<void> _openPayment(Map<String, dynamic> customer) async {
    final id = _num(customer['id']).toInt();
    if (id <= 0) return;
    final paid = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => AreaManagerReceivePaymentScreen(
          customerId: id,
          customerSnapshot: customer,
        ),
      ),
    );
    if (paid == true && mounted) _load();
  }

  Future<void> _showCustomerActions(Map<String, dynamic> c) async {
    final subtitle = [
      c['area']?.toString() ?? '',
      c['package_name']?.toString() ?? '',
    ].where((s) => s.trim().isNotEmpty).join(' · ');
    final openDetail = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Theme(
        data: areaManagerTheme,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  c['name']?.toString() ?? 'Pelanggan',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                    color: _textMain,
                  ),
                ),
                if (subtitle.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      subtitle,
                      style: const TextStyle(fontSize: 12, color: _textMuted),
                    ),
                  ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: () => Navigator.pop(ctx, true),
                  icon: const Icon(Icons.person_search_rounded),
                  label: const Text(
                    'Lihat detail pelanggan',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  style: FilledButton.styleFrom(
                    backgroundColor: _primary,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    if (openDetail == true && mounted) await _openCustomerDetail(c);
  }

  /// Item daftar tagih hanya ringkasan; detail pelanggan butuh record lengkap
  /// (IP, paket, koordinat, dst.) dari endpoint daftar pelanggan.
  Future<Map<String, dynamic>> _fetchFullCustomer(
    Map<String, dynamic> c,
  ) async {
    final id = _num(c['id']).toInt();
    final searchKeys = <String>{
      for (final k in const ['customer_id', 'pppoe_username', 'phone', 'name'])
        if ((c[k]?.toString().trim() ?? '').isNotEmpty) c[k].toString().trim(),
    };
    for (final key in searchKeys) {
      try {
        final r = await ApiClient.get(
          '/api/mobile-adapter/customers?page=1&limit=20'
          '&search=${Uri.encodeQueryComponent(key)}',
        );
        final body = ApiClient.decodeJsonObject(
          r,
          debugLabel: 'customers/search-for-detail',
        );
        if (r.statusCode != 200 || !ApiClient.jsonSuccess(body['success'])) {
          continue;
        }
        for (final row in (body['data'] as List? ?? const []).whereType<Map>()) {
          if (_num(row['id']).toInt() == id) {
            return {...c, ...Map<String, dynamic>.from(row)};
          }
        }
      } catch (_) {}
    }
    return c;
  }

  Future<void> _openCustomerDetail(Map<String, dynamic> c) async {
    final navigator = Navigator.of(context);
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const Center(
        child: CircularProgressIndicator(color: Colors.white),
      ),
    );
    final full = await _fetchFullCustomer(c);
    if (!mounted) return;
    navigator.pop();
    await navigator.push(
      MaterialPageRoute(builder: (_) => CustomerDetailScreen(customer: full)),
    );
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: areaManagerTheme,
      child: _buildScaffold(context),
    );
  }

  Widget _buildScaffold(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _primary,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text(
          'Tagih Pelanggan',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
        ),
        actions: [
          IconButton(
            tooltip: 'Riwayat penerimaan',
            icon: const Icon(Icons.receipt_long_rounded),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => const AreaManagerCollectHistoryScreen(),
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          Container(
            color: _primary,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              children: [
                TextField(
                  controller: _searchCtrl,
                  onChanged: _onSearchChanged,
                  textInputAction: TextInputAction.search,
                  decoration: InputDecoration(
                    hintText: 'Cari nama, HP, ID, PPPoE, alamat',
                    prefixIcon: const Icon(Icons.search_rounded),
                    filled: true,
                    fillColor: Colors.white,
                    isDense: true,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: [
                            _filterChip('Belum bayar', true),
                            const SizedBox(width: 8),
                            _filterChip('Semua pelanggan', false),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    _pill(
                      label: _periodLabel,
                      selected: _month != null,
                      icon: Icons.calendar_month_rounded,
                      onTap: _pickPeriod,
                    ),
                  ],
                ),
              ],
            ),
          ),
          _summaryCard(),
          Expanded(child: _list()),
        ],
      ),
    );
  }

  String get _periodLabel =>
      _month == null ? 'Semua bulan' : '${_monthShort[_month! - 1]} $_year';

  Widget _filterChip(String label, bool unpaid) {
    final selected = _unpaidOnly == unpaid;
    return _pill(
      label: label,
      selected: selected,
      onTap: () {
        if (selected) return;
        setState(() => _unpaidOnly = unpaid);
        _load();
      },
    );
  }

  Widget _pill({
    required String label,
    required bool selected,
    required VoidCallback onTap,
    IconData? icon,
  }) {
    final fg = selected ? _primary : Colors.white;
    return Material(
      color: selected ? Colors.white : Colors.white.withValues(alpha: 0.18),
      shape: StadiumBorder(
        side: BorderSide(
          color: selected
              ? Colors.white
              : Colors.white.withValues(alpha: 0.55),
        ),
      ),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 14, color: fg),
                const SizedBox(width: 4),
              ],
              Text(
                label,
                style: TextStyle(
                  color: fg,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _pickPeriod() async {
    var year = _year;
    final picked = await showModalBottomSheet<({int? month, int year})>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Theme(
        data: areaManagerTheme,
        child: StatefulBuilder(
          builder: (ctx, setSheet) => SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    'Periode tagihan',
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                      color: _textMain,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      IconButton(
                        onPressed: () => setSheet(() => year--),
                        icon: const Icon(Icons.chevron_left_rounded),
                      ),
                      Expanded(
                        child: Text(
                          '$year',
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w800,
                            color: _textMain,
                          ),
                        ),
                      ),
                      IconButton(
                        onPressed: () => setSheet(() => year++),
                        icon: const Icon(Icons.chevron_right_rounded),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  GridView.count(
                    crossAxisCount: 4,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    mainAxisSpacing: 8,
                    crossAxisSpacing: 8,
                    childAspectRatio: 2.2,
                    children: [
                      for (var m = 1; m <= 12; m++)
                        _monthCell(
                          _monthShort[m - 1],
                          selected: _month == m && _year == year,
                          onTap: () =>
                              Navigator.pop(ctx, (month: m, year: year)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      onPressed: () =>
                          Navigator.pop(ctx, (month: null, year: year)),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: _primary,
                        side: BorderSide(
                          color: _month == null
                              ? _primary
                              : const Color(0xFFE2E8F0),
                        ),
                        padding: const EdgeInsets.symmetric(vertical: 12),
                      ),
                      child: const Text(
                        'Semua bulan',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    if (picked == null || !mounted) return;
    final unchanged = picked.month == _month &&
        (picked.month == null || picked.year == _year);
    if (unchanged) return;
    setState(() {
      _month = picked.month;
      _year = picked.year;
    });
    _load();
  }

  Widget _monthCell(
    String label, {
    required bool selected,
    required VoidCallback onTap,
  }) {
    return Material(
      color: selected ? _primary : const Color(0xFFF1F5F9),
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Center(
          child: Text(
            label,
            style: TextStyle(
              fontWeight: FontWeight.w700,
              color: selected ? Colors.white : _textMain,
            ),
          ),
        ),
      ),
    );
  }

  Widget _summaryCard() {
    final count = _num(_summary['total_customers']).toInt();
    final invoices = _num(_summary['total_invoices']).toInt();
    final amount = _num(_summary['total_amount']);
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 14, 16, 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Row(
        children: [
          Expanded(
            child: _summaryValue(
              _unpaidOnly ? 'Pelanggan belum bayar' : 'Pelanggan',
              '$count',
            ),
          ),
          Container(width: 1, height: 36, color: const Color(0xFFE2E8F0)),
          Expanded(
            child: _summaryValue(
              'Tagihan belum lunas ($invoices)',
              _money.format(amount),
            ),
          ),
        ],
      ),
    );
  }

  Widget _summaryValue(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 11, color: _textMuted)),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: const TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w900,
                color: _textMain,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _list() {
    if (_loading && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator(color: _primary));
    }
    if (_error != null && _items.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: _load,
                style: FilledButton.styleFrom(backgroundColor: _primary),
                child: const Text('Coba lagi'),
              ),
            ],
          ),
        ),
      );
    }
    return RefreshIndicator(
      color: _primary,
      onRefresh: _load,
      child: _items.isEmpty
          ? ListView(
              children: [
                const SizedBox(height: 80),
                Icon(
                  _unpaidOnly
                      ? Icons.task_alt_rounded
                      : Icons.person_search_rounded,
                  size: 56,
                  color: const Color(0xFF94A3B8),
                ),
                const SizedBox(height: 12),
                Text(
                  !_unpaidOnly
                      ? 'Pelanggan tidak ditemukan.'
                      : _month != null
                      ? 'Tidak ada tagihan belum lunas untuk $_periodLabel.'
                      : 'Semua pelanggan di wilayah Anda sudah lunas.',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: _textMuted),
                ),
              ],
            )
          : ListView.separated(
              controller: _scrollCtrl,
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 24),
              itemCount: _items.length + (_hasMore ? 1 : 0),
              separatorBuilder: (_, _) => const SizedBox(height: 10),
              itemBuilder: (context, index) {
                if (index >= _items.length) {
                  return const Padding(
                    padding: EdgeInsets.all(12),
                    child: Center(
                      child: CircularProgressIndicator(color: _primary),
                    ),
                  );
                }
                return _customerTile(_items[index]);
              },
            ),
    );
  }

  Widget _customerTile(Map<String, dynamic> c) {
    final unpaidCount = _num(c['unpaid_count']).toInt();
    final unpaidTotal = _num(c['unpaid_total']);
    final hasDebt = unpaidCount > 0;
    final status = (c['status'] ?? '').toString().toLowerCase();
    final isolir = status == 'suspended' || status == 'isolir';
    final subtitle = [
      c['area']?.toString() ?? '',
      c['package_name']?.toString() ?? '',
    ].where((s) => s.trim().isNotEmpty).join(' · ');
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: hasDebt ? () => _openPayment(c) : null,
        onLongPress: () => _showCustomerActions(c),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFE2E8F0)),
          ),
          child: Row(
            children: [
              CircleAvatar(
                radius: 22,
                backgroundColor: hasDebt
                    ? const Color(0xFFFFF1F2)
                    : const Color(0xFFECFDF5),
                child: Icon(
                  hasDebt ? Icons.receipt_rounded : Icons.check_rounded,
                  color: hasDebt
                      ? const Color(0xFFE11D48)
                      : const Color(0xFF059669),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            c['name']?.toString() ?? 'Pelanggan',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 15,
                              color: _textMain,
                            ),
                          ),
                        ),
                        if (isolir)
                          Container(
                            margin: const EdgeInsets.only(left: 6),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 7,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: const Color(0xFFFFF7ED),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: const Text(
                              'Isolir',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w800,
                                color: Color(0xFFC2410C),
                              ),
                            ),
                          ),
                      ],
                    ),
                    if (subtitle.isNotEmpty)
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: _textMuted),
                      ),
                    if (hasDebt && _dueLabel(c['oldest_due_date']).isNotEmpty)
                      Text(
                        _dueLabel(c['oldest_due_date']),
                        style: const TextStyle(
                          fontSize: 11,
                          color: Color(0xFFB45309),
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    hasDebt ? _money.format(unpaidTotal) : 'Lunas',
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      color: hasDebt
                          ? const Color(0xFFE11D48)
                          : const Color(0xFF059669),
                    ),
                  ),
                  if (hasDebt)
                    Text(
                      '$unpaidCount tagihan',
                      style: const TextStyle(fontSize: 11, color: _textMuted),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
