import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../store/collector_provider.dart';
import '../../store/collector_notification_provider.dart';
import '../../theme/collector_colors.dart';
import '../../utils/collector_debug_log.dart';
import 'collector_notifications_screen.dart';
import 'collector_customer_detail_sheet.dart';
import 'collector_payment_status_badge.dart';

String _rupiah(num? v) {
  final n = (v ?? 0).round();
  return 'Rp ${NumberFormat.decimalPattern('id_ID').format(n)}';
}

num? _coerceNum(dynamic v) {
  if (v == null) return null;
  if (v is num) return v;
  if (v is String) return num.tryParse(v);
  return num.tryParse(v.toString());
}

/// Halaman Pelanggan kolektor (Field Collector) — layout mengikuti desain Stitch.
class CollectorCustomersScreen extends StatefulWidget {
  const CollectorCustomersScreen({
    super.key,
    required this.onSync,
    this.initialStatus = '',
    this.syncStamp = 0,
  });

  final Future<void> Function() onSync;
  /// Filter chip awal (dari dashboard: `unpaid`, `paid`, `isolir`, atau kosong = semua).
  final String initialStatus;
  /// Naikkan dari parent agar filter & fetch diselaraskan saat tap kartu ringkasan.
  final int syncStamp;

  @override
  State<CollectorCustomersScreen> createState() => _CollectorCustomersScreenState();
}

class _CollectorCustomersScreenState extends State<CollectorCustomersScreen> {
  final _search = TextEditingController();
  String _status = '';
  /// Kosong = semua wilayah; nilai = string persis seperti `collector_areas.area` di server.
  String _areaFilter = '';
  bool _syncing = false;
  int _loadGeneration = 0;

  Future<void> _loadCustomers({String? statusOverride}) async {
    final gen = ++_loadGeneration;
    final status = statusOverride ?? _status;
    collectorDbg('Pelanggan: load gen=$gen status="$status" area="$_areaFilter" stamp=${widget.syncStamp}');
    final col = context.read<CollectorProvider>();
    await col.fetchCollectorAreas();
    if (!mounted || gen != _loadGeneration) {
      collectorDbg('Pelanggan: load gen=$gen dibatalkan (stamp/filter berubah)');
      return;
    }
    await col.fetchCustomers(status: status, q: _search.text, area: _areaFilter);
    if (!mounted || gen != _loadGeneration) return;
    collectorDbg('Pelanggan: load gen=$gen selesai → ${col.customers.length} baris');
  }

  @override
  void initState() {
    super.initState();
    _status = widget.initialStatus;
    collectorDbg('Pelanggan: initState status="$_status" stamp=${widget.syncStamp}');
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _loadCustomers();
    });
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant CollectorCustomersScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.syncStamp != widget.syncStamp) {
      collectorDbg(
        'Pelanggan: didUpdateWidget stamp ${oldWidget.syncStamp}→${widget.syncStamp} '
        'status "${oldWidget.initialStatus}"→"${widget.initialStatus}"',
      );
      setState(() => _status = widget.initialStatus);
      _loadCustomers(statusOverride: widget.initialStatus);
    }
  }

  Future<void> _reload() async {
    await _loadCustomers();
  }

  void _setFilter(String s) {
    collectorDbg('Pelanggan: chip filter → "$s"');
    setState(() => _status = s);
    _loadCustomers(statusOverride: s);
  }

  void _applyAreaFilter(String area) {
    collectorDbg('Pelanggan: filter area → "$area"');
    setState(() => _areaFilter = area);
    _loadCustomers();
  }

  void _openAreaFilterSheet() {
    final col = context.read<CollectorProvider>();
    final areas = col.collectorAreas;
    const primary = Color(0xFF001F3F);

    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) {
        return SafeArea(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Padding(
                  padding: EdgeInsets.fromLTRB(20, 4, 20, 8),
                  child: Text(
                    'Filter wilayah',
                    style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: primary),
                  ),
                ),
                ListTile(
                  leading: const Icon(Icons.public_rounded),
                  title: const Text('Semua wilayah'),
                  trailing: _areaFilter.isEmpty ? const Icon(Icons.check, color: primary) : null,
                  onTap: () {
                    Navigator.pop(ctx);
                    _applyAreaFilter('');
                  },
                ),
                ...areas.map((r) {
                  final a = r['area']?.toString() ?? '';
                  if (a.isEmpty) return const SizedBox.shrink();
                  final sel = _areaFilter == a;
                  return ListTile(
                    leading: const Icon(Icons.place_outlined),
                    title: Text(a),
                    trailing: sel ? const Icon(Icons.check, color: primary) : null,
                    onTap: () {
                      Navigator.pop(ctx);
                      _applyAreaFilter(a);
                    },
                  );
                }),
                if (areas.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                    child: Text(
                      'Wilayah penugasan belum diatur di admin. Semua pelanggan dalam pool kolektor tetap ditampilkan.',
                      style: TextStyle(fontSize: 13, height: 1.4, color: Colors.grey.shade700),
                    ),
                  ),
                const SizedBox(height: 8),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _doSync() async {
    if (_syncing) return;
    setState(() => _syncing = true);
    try {
      await widget.onSync();
      await _reload();
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<CollectorProvider>();
    final unread = context.watch<CollectorNotificationProvider>().unreadCount;
    const primary = Color(0xFF001F3F);
    const bg = FieldCollectorColors.dashboardCanvas;

    return Scaffold(
      backgroundColor: bg,
      appBar: AppBar(
        backgroundColor: Colors.white,
        foregroundColor: primary,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        centerTitle: true,
        leadingWidth: 152,
        leading: Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(left: 6),
            child: Material(
              color: FieldCollectorColors.statTotalBg,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(999),
                side: BorderSide(color: FieldCollectorColors.statTotalIcon.withValues(alpha: 0.28)),
              ),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: _openAreaFilterSheet,
                borderRadius: BorderRadius.circular(999),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.filter_alt_rounded, size: 18, color: FieldCollectorColors.statTotalIcon),
                      const SizedBox(width: 6),
                      Text(
                        'Filter area',
                        style: TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 14,
                          height: 1.1,
                          color: primary,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        title: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Pelanggan',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: primary),
            ),
            if (_areaFilter.isNotEmpty)
              Text(
                _areaFilter,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: primary.withValues(alpha: 0.72),
                ),
              ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Notifikasi',
            iconSize: 32,
            padding: const EdgeInsets.all(10),
            constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
            onPressed: () async {
              final nav = Navigator.of(context);
              final notifProv = context.read<CollectorNotificationProvider>();
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
        bottom: const PreferredSize(preferredSize: Size.fromHeight(1), child: Divider(height: 1)),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _search,
                    decoration: InputDecoration(
                      hintText: 'Cari nama atau ID…',
                      prefixIcon: const Icon(Icons.search, color: FieldCollectorColors.onSurfaceVariant),
                      filled: true,
                      fillColor: const Color(0xFFE7E8E9),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(999)),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(999),
                        borderSide: const BorderSide(color: FieldCollectorColors.outlineVariant),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(999),
                        borderSide: const BorderSide(color: Color(0xFF001F3F), width: 1.5),
                      ),
                      contentPadding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
                    ),
                    onSubmitted: (_) => _reload(),
                  ),
                ),
                const SizedBox(width: 8),
                Material(
                  color: FieldCollectorColors.primaryContainer,
                  borderRadius: BorderRadius.circular(999),
                  child: InkWell(
                    onTap: _reload,
                    borderRadius: BorderRadius.circular(999),
                    child: const Padding(
                      padding: EdgeInsets.all(12),
                      child: Icon(Icons.search, color: Colors.white),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 40,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                _FilterChip(label: 'Semua', value: '', current: _status, onTap: _setFilter),
                _FilterChip(label: 'Belum Bayar', value: 'unpaid', current: _status, onTap: _setFilter),
                _FilterChip(label: 'Lunas', value: 'paid', current: _status, onTap: _setFilter),
                _FilterChip(label: 'Isolir', value: 'isolir', current: _status, onTap: _setFilter),
                _FilterChip(label: 'Baru', value: 'baru', current: _status, onTap: _setFilter),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: c.customersLoading && c.customers.isEmpty
                ? const Center(child: CircularProgressIndicator(color: FieldCollectorColors.primaryContainer))
                : c.customersError != null && c.customers.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(c.customersError ?? '', textAlign: TextAlign.center),
                              TextButton(onPressed: _reload, child: const Text('Coba lagi')),
                            ],
                          ),
                        ),
                      )
                    : RefreshIndicator(
                        color: FieldCollectorColors.primaryContainer,
                        onRefresh: _doSync,
                        child: !c.customersLoading && c.customers.isEmpty && c.customersError == null
                            ? ListView(
                                physics: const AlwaysScrollableScrollPhysics(),
                                children: [
                                  SizedBox(
                                    height: MediaQuery.sizeOf(context).height * 0.35,
                                    child: Center(
                                      child: Text(
                                        'Belum ada pelanggan untuk filter ini.',
                                        style: TextStyle(color: Colors.grey.shade700),
                                      ),
                                    ),
                                  ),
                                ],
                              )
                            : ListView.builder(
                                physics: const AlwaysScrollableScrollPhysics(),
                                padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                                itemCount: c.customers.length,
                                itemBuilder: (context, i) {
                                  final raw = c.customers[i];
                                  if (raw is! Map) return const SizedBox.shrink();
                                  final row = Map<String, dynamic>.from(raw);
                                  return Padding(
                                    padding: const EdgeInsets.only(bottom: 12),
                                    child: _CustomerCard(
                                      row: row,
                                      onOpenDetail: () => showCollectorCustomerDetailSheet(
                                        context,
                                        row: row,
                                        onRefreshCustomers: _reload,
                                      ),
                                    ),
                                  );
                                },
                              ),
                      ),
          ),
        ],
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.label,
    required this.value,
    required this.current,
    required this.onTap,
  });

  final String label;
  final String value;
  final String current;
  final void Function(String) onTap;

  @override
  Widget build(BuildContext context) {
    final sel = current == value;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Material(
        color: sel ? FieldCollectorColors.primaryContainer : Colors.white,
        elevation: sel ? 0 : 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(999),
          side: BorderSide(color: sel ? FieldCollectorColors.primaryContainer : FieldCollectorColors.outlineVariant),
        ),
        child: InkWell(
          onTap: () => onTap(value),
          borderRadius: BorderRadius.circular(999),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Text(
              label,
              style: TextStyle(
                color: sel ? Colors.white : FieldCollectorColors.onSurface,
                fontWeight: FontWeight.w600,
                fontSize: 12,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _CustomerCard extends StatelessWidget {
  const _CustomerCard({
    required this.row,
    required this.onOpenDetail,
  });

  final Map<String, dynamic> row;
  final VoidCallback onOpenDetail;

  @override
  Widget build(BuildContext context) {
    final name = row['name']?.toString() ?? '';
    final addr = row['address']?.toString() ?? '';
    final ps = row['payment_status']?.toString() ?? '';
    final st = row['status']?.toString().toLowerCase() ?? '';
    final price = _coerceNum(row['package_price'])?.round() ?? 0;
    final custId = row['customer_id']?.toString();
    final username = row['username']?.toString() ?? '';
    final idLine = custId != null && custId.isNotEmpty
        ? 'ID: $custId'
        : (username.isNotEmpty ? 'ID: $username' : 'ID: ${row['id']}');

    final isIsolir = st == 'suspended';
    final areaStr = (row['area']?.toString() ?? '').trim();
    final areaDisplay = areaStr.isEmpty ? '—' : areaStr;

    final badgeStyle = collectorPaymentBadgeFor(isIsolirAccount: isIsolir, paymentStatus: ps);
    final amountColor = collectorPaymentAmountHeadlineColor(isIsolirAccount: isIsolir, paymentStatus: ps);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onOpenDetail,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          width: double.infinity,
          decoration: BoxDecoration(
            color: FieldCollectorColors.dashPriorityBg,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFFFE0B2), width: 1.2),
            boxShadow: const [
              BoxShadow(color: Color(0x10000000), blurRadius: 10, offset: Offset(0, 4)),
            ],
          ),
          child: Container(
            decoration: const BoxDecoration(
              border: Border(
                left: BorderSide(width: 5, color: FieldCollectorColors.dashPriorityRail),
              ),
            ),
            padding: const EdgeInsets.fromLTRB(12, 14, 14, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            name,
                            style: const TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 16,
                              color: FieldCollectorColors.onSurface,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            idLine,
                            style: TextStyle(
                              fontSize: 12,
                              height: 1.3,
                              color: FieldCollectorColors.onSurfaceVariant.withValues(alpha: 0.95),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        badgeStyle.buildPill(),
                        const SizedBox(height: 6),
                        Text(
                          'Area',
                          style: TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.4,
                            color: FieldCollectorColors.onSurfaceVariant.withValues(alpha: 0.9),
                          ),
                        ),
                        const SizedBox(height: 2),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 150),
                          child: Text(
                            areaDisplay,
                            textAlign: TextAlign.end,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: FieldCollectorColors.onSurface,
                              height: 1.25,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      Icons.home_work_rounded,
                      size: 17,
                      color: FieldCollectorColors.onSurfaceVariant.withValues(alpha: 0.9),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        addr.isEmpty ? '—' : addr,
                        style: TextStyle(
                          fontSize: 13,
                          height: 1.35,
                          color: FieldCollectorColors.onSurfaceVariant.withValues(alpha: 0.95),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    Expanded(
                      child: Text(
                        _rupiah(price),
                        style: TextStyle(
                          fontWeight: FontWeight.w900,
                          fontSize: 17,
                          color: amountColor,
                        ),
                      ),
                    ),
                    Icon(Icons.chevron_right_rounded, size: 22, color: FieldCollectorColors.statTotalIcon),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
