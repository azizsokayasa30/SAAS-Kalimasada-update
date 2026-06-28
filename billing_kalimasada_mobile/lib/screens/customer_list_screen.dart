import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../store/customer_provider.dart';
import '../store/task_provider.dart';
import 'customer_detail_screen.dart';

class CustomerListScreen extends StatefulWidget {
  final String? initialFilter;
  final String? adminFilter;
  final int? filterMonth;
  final int? filterYear;
  final String? title;

  const CustomerListScreen({
    super.key,
    this.initialFilter,
    this.adminFilter,
    this.filterMonth,
    this.filterYear,
    this.title,
  });

  @override
  State<CustomerListScreen> createState() => _CustomerListScreenState();
}

class _CustomerListScreenState extends State<CustomerListScreen>
    with SingleTickerProviderStateMixin {
  final ScrollController _scrollController = ScrollController();
  final TextEditingController _searchController = TextEditingController();
  String _areaFilter = '';
  String? _statusFilter;

  // Clean white customer list theme.
  final Color _bgBackground = const Color(0xFFFFFFFF);
  final Color _bgSurfaceContainerLowest = const Color(0xFFFFFFFF);
  final Color _bgSurfaceContainer = const Color(0xFFF8FAFC);
  final Color _bgSurfaceContainerHigh = const Color(0xFFF1F5F9);

  final Color _primaryColor = const Color(0xFF2563EB);
  final Color _primaryContainerColor = const Color(0xFF2563EB);
  final Color _secondaryColor = const Color(0xFF64748B);
  final Color _errorColor = const Color(0xFFBA1A1A);

  final Color _textOnBackground = const Color(0xFF19163F);
  final Color _textOnSurfaceVariant = const Color(0xFF474551);
  final Color _textOnPrimary = const Color(0xFFFFFFFF);
  final Color _outlineVariant = const Color(0xFFE2E8F0);
  final Color _outline = const Color(0xFF94A3B8);
  final _money = NumberFormat.currency(
    locale: 'id_ID',
    symbol: 'Rp. ',
    decimalDigits: 0,
  );
  late final AnimationController _connectionBlinkController;
  late final Animation<double> _connectionBlinkOpacity;

  @override
  void initState() {
    super.initState();
    _statusFilter = widget.initialFilter;
    _connectionBlinkController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 850),
    )..repeat(reverse: true);
    _connectionBlinkOpacity = Tween<double>(begin: 0.45, end: 1).animate(
      CurvedAnimation(
        parent: _connectionBlinkController,
        curve: Curves.easeInOut,
      ),
    );
    _scrollController.addListener(_onScrollNearEnd);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.read<CustomerProvider>().fetchCustomers(
        refresh: true,
        status: _statusFilter,
        adminFilter: _effectiveAdminFilter,
        area: _areaFilter,
        month: widget.filterMonth,
        year: widget.filterYear,
      );
      context.read<CustomerProvider>().fetchDashboardStats();
    });
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScrollNearEnd);
    _connectionBlinkController.dispose();
    _scrollController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  void _onScrollNearEnd() {
    if (!mounted) return;
    if (!_scrollController.hasClients) return;
    final pos = _scrollController.position;
    if (!pos.hasViewportDimension) return;
    if (pos.maxScrollExtent <= 0) return;
    if (pos.pixels < pos.maxScrollExtent - 200) return;
    final p = context.read<CustomerProvider>();
    if (!p.hasMore || p.loading) return;
    p.fetchCustomers(
      search: _searchController.text,
      status: _statusFilter,
      adminFilter: _effectiveAdminFilter,
      area: _areaFilter,
      month: widget.filterMonth,
      year: widget.filterYear,
    );
  }

  void _onSearch() {
    context.read<CustomerProvider>().fetchCustomers(
      refresh: true,
      search: _searchController.text,
      status: _statusFilter,
      adminFilter: _effectiveAdminFilter,
      area: _areaFilter,
      month: widget.filterMonth,
      year: widget.filterYear,
    );
  }

  void _applyAreaFilter(String area) {
    if (_areaFilter == area) return;
    setState(() => _areaFilter = area);
    context.read<CustomerProvider>().fetchCustomers(
      refresh: true,
      search: _searchController.text,
      status: _statusFilter,
      adminFilter: _effectiveAdminFilter,
      area: area,
      month: widget.filterMonth,
      year: widget.filterYear,
    );
  }

  String? get _effectiveAdminFilter {
    final status = _statusFilter?.trim();
    if (status != null && status.isNotEmpty) return null;
    return widget.adminFilter;
  }

  void _applyStatusFilter(String status) {
    if (_statusFilter == status) return;
    setState(() => _statusFilter = status);
    if (_scrollController.hasClients) {
      _scrollController.jumpTo(0);
    }
    context.read<CustomerProvider>().fetchCustomers(
      refresh: true,
      search: _searchController.text,
      status: status,
      adminFilter: _effectiveAdminFilter,
      area: _areaFilter,
      month: widget.filterMonth,
      year: widget.filterYear,
    );
  }

  List<String> _areaOptionsFrom(List<dynamic> customers) {
    final areas = <String>{};
    for (final raw in customers) {
      if (raw is! Map) continue;
      final area = _customerArea(raw);
      if (area != '-') areas.add(area);
    }
    if (_areaFilter.isNotEmpty) areas.add(_areaFilter);
    final sorted = areas.toList()
      ..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
    return sorted;
  }

  String _customerArea(Map<dynamic, dynamic> customer) {
    return [customer['area'], customer['nama_area']]
        .map((e) => e?.toString().trim() ?? '')
        .firstWhere((e) => e.isNotEmpty, orElse: () => '-');
  }

  Widget _locationFilterMenu(CustomerProvider provider) {
    final areas = _areaOptionsFrom(provider.customers);
    final hasFilter = _areaFilter.isNotEmpty;

    return Padding(
      padding: const EdgeInsets.only(right: 12),
      child: PopupMenuButton<String>(
        tooltip: 'Filter lokasi',
        initialValue: _areaFilter,
        color: Colors.white,
        elevation: 8,
        offset: const Offset(0, 10),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        onSelected: _applyAreaFilter,
        itemBuilder: (context) => [
          PopupMenuItem<String>(
            value: '',
            child: _locationMenuItem(
              icon: Icons.public_rounded,
              label: 'Semua lokasi',
              selected: !hasFilter,
            ),
          ),
          if (areas.isEmpty)
            PopupMenuItem<String>(
              enabled: false,
              value: '__empty__',
              child: Text(
                'Lokasi belum tersedia',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: _textOnSurfaceVariant,
                ),
              ),
            ),
          ...areas.map(
            (area) => PopupMenuItem<String>(
              value: area,
              child: _locationMenuItem(
                icon: Icons.place_outlined,
                label: area,
                selected: _areaFilter == area,
              ),
            ),
          ),
        ],
        child: Container(
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: hasFilter
                ? Colors.white
                : Colors.white.withValues(alpha: 0.18),
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: Colors.white.withValues(alpha: 0.28)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                hasFilter ? Icons.place_rounded : Icons.filter_list_rounded,
                size: 18,
                color: hasFilter ? _primaryContainerColor : _textOnPrimary,
              ),
              if (hasFilter) ...[
                const SizedBox(width: 6),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 82),
                  child: Text(
                    _areaFilter,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      color: _primaryContainerColor,
                    ),
                  ),
                ),
              ],
              const SizedBox(width: 2),
              Icon(
                Icons.keyboard_arrow_down_rounded,
                size: 18,
                color: hasFilter ? _primaryContainerColor : _textOnPrimary,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _locationMenuItem({
    required IconData icon,
    required String label,
    required bool selected,
  }) {
    return Row(
      children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(
            color: selected
                ? _primaryColor.withValues(alpha: 0.12)
                : _bgSurfaceContainer,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Icon(
            icon,
            size: 17,
            color: selected ? _primaryColor : _textOnSurfaceVariant,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 13,
              fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
              color: _textOnBackground,
            ),
          ),
        ),
        if (selected) ...[
          const SizedBox(width: 8),
          Icon(Icons.check_circle_rounded, size: 18, color: _primaryColor),
        ],
      ],
    );
  }

  Widget _scrollableRefreshBody(Widget child) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(
            parent: BouncingScrollPhysics(),
          ),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: child,
          ),
        );
      },
    );
  }

  Widget _buildSkeleton() {
    return ListView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: 5,
      itemBuilder: (context, index) {
        return Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: _bgSurfaceContainerLowest,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: _outlineVariant.withValues(alpha: 0.5)),
          ),
          child: Row(
            children: [
              Container(width: 8, height: 40, color: Colors.grey[300]),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(width: 100, height: 16, color: Colors.grey[300]),
                    const SizedBox(height: 8),
                    Container(width: 200, height: 14, color: Colors.grey[200]),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bgBackground,
      appBar: AppBar(
        backgroundColor: _primaryContainerColor,
        foregroundColor: _textOnPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          widget.title ?? 'Pelanggan',
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 22),
        ),
        actions: [
          Consumer<CustomerProvider>(
            builder: (context, provider, _) => _locationFilterMenu(provider),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
            child: Container(
              height: 36,
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(18),
              ),
              child: TextField(
                controller: _searchController,
                style: TextStyle(color: _textOnBackground),
                decoration: InputDecoration(
                  hintText: 'Cari ID, Nama, atau Alamat...',
                  hintStyle: TextStyle(color: _outline),
                  prefixIcon: Icon(Icons.search, color: _outline),
                  prefixIconConstraints: const BoxConstraints(
                    minWidth: 40,
                    minHeight: 36,
                  ),
                  border: InputBorder.none,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 8,
                  ),
                ),
                onSubmitted: (_) => _onSearch(),
              ),
            ),
          ),
        ),
      ),
      body: Consumer2<CustomerProvider, TaskProvider>(
        builder: (context, provider, taskProvider, child) {
          final stats = provider.stats;
          final openTroubleCustomerIds = <int>{};
          for (final rawTask in taskProvider.tasks) {
            final task = rawTask is Map
                ? Map<String, dynamic>.from(rawTask)
                : <String, dynamic>{};
            final type = (task['type'] ?? '').toString().toUpperCase();
            final status = (task['status'] ?? '').toString().toLowerCase();
            if (type != 'TR' || status == 'closed' || status == 'selesai') {
              continue;
            }
            final rawCustomerId = task['customer_id'];
            final customerId = rawCustomerId is int
                ? rawCustomerId
                : int.tryParse(rawCustomerId?.toString() ?? '');
            if (customerId != null) {
              openTroubleCustomerIds.add(customerId);
            }
          }

          return Column(
            children: [
              // Status Summary
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: _buildStatusSummary(
                        'Aktif',
                        '${stats['active'] ?? 0}',
                        _primaryColor,
                        const Color(0xFFE8F8EF),
                        const Color(0xFF10B981).withValues(alpha: 0.22),
                        selected: _statusFilter == 'active',
                        onTap: () => _applyStatusFilter('active'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _buildStatusSummary(
                        'Nonaktif',
                        '${stats['isolated'] ?? 0}',
                        _errorColor,
                        const Color(0xFFFFDAD6), // error-container
                        _errorColor.withValues(alpha: 0.2),
                        selected: _statusFilter == 'isolated',
                        onTap: () => _applyStatusFilter('isolated'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _buildStatusSummary(
                        'Isolir',
                        '${stats['suspended'] ?? 0}',
                        _secondaryColor,
                        _bgSurfaceContainerHigh,
                        _outlineVariant,
                        selected: _statusFilter == 'suspended',
                        onTap: () => _applyStatusFilter('suspended'),
                      ),
                    ),
                  ],
                ),
              ),

              // Customer List
              Expanded(
                child: RefreshIndicator(
                  color: _primaryContainerColor,
                  displacement: 48,
                  triggerMode: RefreshIndicatorTriggerMode.anywhere,
                  onRefresh: () async {
                    await provider.fetchDashboardStats();
                    await provider.fetchCustomers(
                      refresh: true,
                      search: _searchController.text,
                      status: _statusFilter,
                      adminFilter: _effectiveAdminFilter,
                      area: _areaFilter,
                      month: widget.filterMonth,
                      year: widget.filterYear,
                    );
                  },
                  child: _buildCustomerListBody(
                    context,
                    provider,
                    openTroubleCustomerIds: openTroubleCustomerIds,
                  ),
                ),
              ),
            ],
          );
        },
      ),
      bottomNavigationBar: Consumer<CustomerProvider>(
        builder: (context, provider, _) => SafeArea(
          top: false,
          child: Container(
            color: _bgBackground,
            padding: const EdgeInsets.fromLTRB(0, 4, 0, 8),
            child: _buildBottomTotalCard(provider),
          ),
        ),
      ),
    );
  }

  Widget _buildCustomerListBody(
    BuildContext context,
    CustomerProvider provider, {
    required Set<int> openTroubleCustomerIds,
  }) {
    if (provider.loading && provider.customers.isEmpty) {
      return _scrollableRefreshBody(
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: _buildSkeleton(),
        ),
      );
    }

    if (provider.error != null && provider.customers.isEmpty) {
      return _scrollableRefreshBody(
        Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              provider.error!,
              textAlign: TextAlign.center,
              style: TextStyle(color: _errorColor),
            ),
          ),
        ),
      );
    }

    if (provider.customers.isEmpty) {
      return _scrollableRefreshBody(
        const Center(child: Text('Tidak ada pelanggan ditemukan.')),
      );
    }

    return ListView.builder(
      controller: _scrollController,
      physics: const AlwaysScrollableScrollPhysics(
        parent: BouncingScrollPhysics(),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 20),
      itemCount: provider.customers.length + (provider.hasMore ? 1 : 0),
      itemBuilder: (context, index) {
        if (index == provider.customers.length) {
          return Padding(
            padding: const EdgeInsets.all(16.0),
            child: Center(
              child: CircularProgressIndicator(color: _primaryContainerColor),
            ),
          );
        }

        final customer = provider.customers[index];
        final rawStatus =
            customer['status']?.toString().toLowerCase() ?? 'active';
        final rawCustomerId = customer['id'];
        final customerId = rawCustomerId is int
            ? rawCustomerId
            : int.tryParse(rawCustomerId?.toString() ?? '');
        final hasOpenTroubleTicket =
            customerId != null && openTroubleCustomerIds.contains(customerId);
        // Layar filter Gangguan: pelanggan dari tiket aktif (status DB masih aktif) tetap tampil sebagai gangguan
        final showAsGangguan =
            rawStatus == 'isolated' ||
            hasOpenTroubleTicket ||
            (_statusFilter == 'isolated' && rawStatus != 'suspended');

        // Default to active colors
        Color statusColor = const Color(0xFF10B981); // Emerald
        Color bgColor = _bgSurfaceContainerLowest;
        String statusLabel = 'Aktif';
        IconData statusIcon = Icons.check_circle;

        if (rawStatus == 'suspended') {
          statusColor = _secondaryColor;
          statusLabel = 'Isolir';
          statusIcon = Icons.block;
        } else if (showAsGangguan) {
          statusColor = _errorColor;
          statusLabel = 'Gangguan';
          statusIcon = Icons.error;
        }

        final unpaidCount = _intVal(customer['invoice_unpaid_count']);
        final paidCount = _intVal(customer['invoice_paid_count']);
        final invoiceStatus = unpaidCount > 0
            ? 'Belum Bayar'
            : (paidCount > 0 ? 'Lunas' : 'Belum Ada Tagihan');
        final invoiceAmount = _customerInvoiceAmount(customer);
        final invoiceColor = unpaidCount > 0
            ? _errorColor
            : (paidCount > 0 ? const Color(0xFF10B981) : _outline);
        final packageAmount = _customerPackageAmount(customer);
        final area = [customer['area'], customer['nama_area']]
            .map((e) => e?.toString().trim() ?? '')
            .firstWhere((e) => e.isNotEmpty, orElse: () => '-');
        final isConnectionOnline = _isCustomerOnline(customer);

        return Container(
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: showAsGangguan
                  ? _errorColor.withValues(alpha: 0.3)
                  : _outlineVariant,
            ),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.02),
                blurRadius: 4,
                offset: const Offset(0, 1),
              ),
            ],
          ),
          child: InkWell(
            onTap: () {
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (context) =>
                      CustomerDetailScreen(customer: customer),
                ),
              );
            },
            borderRadius: BorderRadius.circular(8),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 6,
                    height: 94,
                    decoration: BoxDecoration(
                      color: statusColor,
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            _smallChip(
                              'ID: ${customer['customer_id'] ?? '-'}',
                              _textOnSurfaceVariant,
                              _bgSurfaceContainer,
                            ),
                            const SizedBox(width: 6),
                            _statusChip(statusLabel, statusIcon, statusColor),
                          ],
                        ),
                        const SizedBox(height: 5),
                        Text(
                          customer['name']?.toString() ?? '-',
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w700,
                            color: _textOnBackground,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 5),
                        _infoRow(Icons.phone, 'Nomor HP', customer['phone']),
                        const SizedBox(height: 3),
                        _infoRow(Icons.map_outlined, 'Area', area),
                        const SizedBox(height: 6),
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            _invoicePill(invoiceStatus, invoiceColor),
                            _amountPill(
                              _money.format(invoiceAmount),
                              invoiceColor,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 6),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      _connectionBadge(isConnectionOnline),
                      const SizedBox(height: 16),
                      Text(
                        _money.format(packageAmount),
                        textAlign: TextAlign.end,
                        style: TextStyle(
                          color: _textOnBackground,
                          fontSize: 13,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Paket',
                        textAlign: TextAlign.end,
                        style: TextStyle(
                          color: _textOnSurfaceVariant,
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 11),
                      Icon(Icons.chevron_right, size: 20, color: _outline),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildBottomTotalCard(CustomerProvider provider) {
    final loadedAmount = provider.customers.fold<num>(
      0,
      (sum, customer) => sum + _customerPackageAmount(customer),
    );
    final totalAmount = provider.listTotalAmount ?? loadedAmount;
    final count = provider.listTotalCount ?? provider.customers.length;

    return Container(
      margin: const EdgeInsets.fromLTRB(20, 8, 20, 10),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF2563EB), Color(0xFF6C5CE7)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: _primaryColor.withValues(alpha: 0.22),
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.18),
              borderRadius: BorderRadius.circular(14),
            ),
            child: const Icon(
              Icons.summarize_rounded,
              color: Colors.white,
              size: 19,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: _bottomTotalItem(label: 'Jumlah', value: '$count pelanggan'),
          ),
          Container(
            width: 1,
            height: 32,
            color: Colors.white.withValues(alpha: 0.22),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: _bottomTotalItem(
              label: 'Nominal',
              value: _money.format(totalAmount),
              alignEnd: true,
            ),
          ),
        ],
      ),
    );
  }

  Widget _bottomTotalItem({
    required String label,
    required String value,
    bool alignEnd = false,
  }) {
    return Column(
      crossAxisAlignment: alignEnd
          ? CrossAxisAlignment.end
          : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label.toUpperCase(),
          style: TextStyle(
            fontSize: 9,
            fontWeight: FontWeight.w800,
            color: Colors.white.withValues(alpha: 0.72),
            letterSpacing: 0.9,
          ),
        ),
        const SizedBox(height: 3),
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: alignEnd ? TextAlign.end : TextAlign.start,
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w900,
            color: Colors.white,
          ),
        ),
      ],
    );
  }

  Widget _buildStatusSummary(
    String label,
    String value,
    Color valueColor,
    Color bgColor,
    Color borderColor, {
    required bool selected,
    required VoidCallback onTap,
  }) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(vertical: 5),
          decoration: BoxDecoration(
            color: selected ? valueColor.withValues(alpha: 0.14) : bgColor,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: selected
                  ? valueColor.withValues(alpha: 0.55)
                  : borderColor,
              width: selected ? 1.2 : 1,
            ),
            boxShadow: selected
                ? [
                    BoxShadow(
                      color: valueColor.withValues(alpha: 0.14),
                      blurRadius: 10,
                      offset: const Offset(0, 4),
                    ),
                  ]
                : null,
          ),
          child: Column(
            children: [
              Text(
                label.toUpperCase(),
                style: TextStyle(
                  fontSize: 8,
                  fontWeight: FontWeight.bold,
                  color: selected ? valueColor : _textOnSurfaceVariant,
                  letterSpacing: 0.9,
                ),
              ),
              const SizedBox(height: 1),
              Text(
                value,
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: valueColor,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  int _intVal(dynamic value) {
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '') ?? 0;
  }

  num _numVal(dynamic value) {
    if (value is num) return value;
    return num.tryParse(value?.toString() ?? '') ?? 0;
  }

  num _customerInvoiceAmount(dynamic customer) {
    if (customer is! Map) return 0;
    final unpaidCount = _intVal(customer['invoice_unpaid_count']);
    final paidCount = _intVal(customer['invoice_paid_count']);
    if (unpaidCount > 0) return _numVal(customer['invoice_unpaid_amount']);
    if (paidCount > 0) return _numVal(customer['invoice_paid_amount']);
    return 0;
  }

  num _customerPackageAmount(dynamic customer) {
    if (customer is! Map) return 0;
    final direct = _numVal(customer['package_amount']);
    if (direct > 0) return direct;
    final price = _numVal(customer['package_price']);
    if (price <= 0) return 0;
    final taxRate = _numVal(customer['package_tax_rate']);
    return (price * (1 + taxRate / 100)).round();
  }

  bool _isCustomerOnline(dynamic customer) {
    final candidates = [
      customer['pppoe_active'],
      customer['is_online'],
      customer['online'],
      customer['isOnline'],
      customer['connection_online'],
      customer['pppoe_status'],
      customer['connection_status'],
      customer['session_status'],
    ];

    for (final candidate in candidates) {
      final parsed = _boolStatus(candidate);
      if (parsed != null) return parsed;
    }
    return false;
  }

  bool? _boolStatus(dynamic value) {
    if (value == null) return null;
    if (value is bool) return value;
    if (value is num) return value != 0;

    final text = value.toString().trim().toLowerCase();
    if (text.isEmpty) return null;
    if ([
      'true',
      '1',
      'online',
      'active',
      'connected',
      'up',
      'yes',
    ].contains(text)) {
      return true;
    }
    if ([
      'false',
      '0',
      'offline',
      'inactive',
      'disconnected',
      'down',
      'no',
    ].contains(text)) {
      return false;
    }
    return null;
  }

  Widget _connectionBadge(bool isOnline) {
    final color = isOnline ? const Color(0xFF10B981) : _errorColor;
    final bgColor = isOnline
        ? const Color(0xFFE8F8EF)
        : const Color(0xFFFFE8E8);

    return FadeTransition(
      opacity: _connectionBlinkOpacity,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
        decoration: BoxDecoration(
          color: bgColor,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: color.withValues(alpha: 0.35)),
          boxShadow: [
            BoxShadow(
              color: color.withValues(alpha: 0.16),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
            const SizedBox(width: 4),
            Text(
              isOnline ? 'ONLINE' : 'OFFLINE',
              style: TextStyle(
                fontSize: 8.5,
                fontWeight: FontWeight.w900,
                color: color,
                letterSpacing: 0.45,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _smallChip(String label, Color color, Color bgColor) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 9,
          fontWeight: FontWeight.bold,
          color: color,
        ),
      ),
    );
  }

  Widget _statusChip(String label, IconData icon, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 9, color: color),
          const SizedBox(width: 3),
          Text(
            label,
            style: TextStyle(
              fontSize: 9,
              fontWeight: FontWeight.bold,
              color: color,
            ),
          ),
        ],
      ),
    );
  }

  Widget _infoRow(IconData icon, String label, dynamic value) {
    final text = value?.toString().trim();
    return Row(
      children: [
        Icon(icon, size: 13, color: _textOnSurfaceVariant),
        const SizedBox(width: 5),
        Text(
          '$label: ',
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w700,
            color: _textOnSurfaceVariant,
          ),
        ),
        Expanded(
          child: Text(
            text == null || text.isEmpty ? '-' : text,
            style: TextStyle(fontSize: 11, color: _textOnSurfaceVariant),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }

  Widget _invoicePill(String label, Color color) {
    return _smallChip('Tagihan: $label', color, color.withValues(alpha: 0.1));
  }

  Widget _amountPill(String amount, Color color) {
    return _smallChip('Jumlah: $amount', color, color.withValues(alpha: 0.1));
  }
}
