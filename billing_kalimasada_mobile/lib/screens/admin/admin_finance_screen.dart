import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../services/api_client.dart';

class AdminFinanceScreen extends StatefulWidget {
  const AdminFinanceScreen({super.key});

  @override
  State<AdminFinanceScreen> createState() => _AdminFinanceScreenState();
}

class _AdminFinanceScreenState extends State<AdminFinanceScreen> {
  static const _navy = Color(0xFF1D4ED8);
  static const _bg = Color(0xFFF4F6FA);
  static const _orange = Color(0xFFE49A16);
  static const _green = Color(0xFF10B981);
  static const _red = Color(0xFFE84C4F);
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
    symbol: 'Rp ',
    decimalDigits: 0,
  );
  final _count = NumberFormat.decimalPattern('id_ID');
  final _date = DateFormat('yyyy-MM-dd');

  Map<String, dynamic>? _data;
  bool _loading = true;
  String? _error;
  int _selectedMenu = 0;
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
      final monthParam = _month == 0 ? 'all' : _month.toString();
      final response = await ApiClient.get(
        '/api/mobile-adapter/admin/finance/overview?month=$monthParam&year=$_year',
      );
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'admin/finance/overview',
      );
      if (response.statusCode != 200 ||
          !ApiClient.jsonSuccess(body['success'])) {
        throw FormatException(
          body['message']?.toString() ?? 'Gagal memuat keuangan',
        );
      }
      final raw = body['data'];
      if (raw is! Map) throw const FormatException('Data keuangan tidak valid');
      setState(() {
        _data = Map<String, dynamic>.from(raw);
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error =
            'Menu keuangan belum tersedia dari server. Restart/deploy backend lalu muat ulang.';
        _loading = false;
      });
    }
  }

  Map<String, dynamic> _map(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return const {};
  }

  List<Map<String, dynamic>> _list(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  num _num(dynamic value) {
    if (value is num) return value;
    return num.tryParse(value?.toString() ?? '') ?? 0;
  }

  List<String> _paymentMethods() {
    final options = _map(_data?['options']);
    final raw = options['payment_methods'];
    if (raw is List) {
      final values = raw
          .map((item) => item.toString())
          .where((v) => v.isNotEmpty)
          .toList();
      if (values.isNotEmpty) return values;
    }
    return const ['Cash', 'Transfer Bank', 'E-Wallet', 'Kartu Kredit'];
  }

  List<Map<String, dynamic>> _financeCategories(String key) {
    final options = _map(_data?['options']);
    return _list(options[key]);
  }

  List<String> _financeCategoryNames(String key) {
    return _financeCategories(key)
        .map((item) => item['name']?.toString() ?? '')
        .where((name) => name.isNotEmpty)
        .toList();
  }

  List<String> _expenseAccountsFor(String category) {
    final match = _financeCategories(
      'expense_categories',
    ).where((item) => item['name'] == category).toList();
    if (match.isEmpty) return const [];
    final raw = match.first['subcategories'];
    if (raw is List) {
      return raw
          .map((item) => item.toString())
          .where((item) => item.isNotEmpty)
          .toList();
    }
    return const [];
  }

  String _rupiah(dynamic value) => _money.format(_num(value));
  String _number(dynamic value) => _count.format(_num(value));

  String _shortDate(dynamic value) {
    final raw = value?.toString() ?? '';
    if (raw.length >= 10) return raw.substring(0, 10);
    return raw.isEmpty ? '-' : raw;
  }

  Future<void> _postAction(
    String endpoint,
    Map<String, dynamic> body,
    String successMessage,
  ) async {
    final response = await ApiClient.post(endpoint, body);
    final decoded = ApiClient.decodeJsonObject(response, debugLabel: endpoint);
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        !ApiClient.jsonSuccess(decoded['success'])) {
      throw Exception(decoded['message']?.toString() ?? 'Aksi gagal');
    }
    if (!mounted) return;
    Navigator.of(context).pop();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(decoded['message']?.toString() ?? successMessage)),
    );
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _navy,
        foregroundColor: Colors.white,
        title: const Text(
          'Keuangan',
          style: TextStyle(fontWeight: FontWeight.w800),
        ),
        actions: [
          IconButton(
            tooltip: 'Muat ulang',
            onPressed: _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return _ErrorState(message: _error!, onRetry: _load);
    }
    return _tabList(_selectedContent());
  }

  List<Widget> _selectedContent() {
    switch (_selectedMenu) {
      case 1:
        return _buildRemittanceTab();
      case 2:
        return _buildIncomeTab();
      case 3:
        return _buildExpensesTab();
      case 4:
        return _buildReportTab();
      case 0:
      default:
        return _buildPaymentsTab();
    }
  }

  Widget _tabList(List<Widget> children) {
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
        children: [
          _periodHeader(),
          const SizedBox(height: 14),
          _financeSubMenu(),
          const SizedBox(height: 14),
          ...children,
        ],
      ),
    );
  }

  Widget _financeSubMenu() {
    return Column(
      children: [
        _FinanceMenuButton(
          title: 'Riwayat pembayaran',
          icon: Icons.receipt_long_rounded,
          color: _navy,
          selected: _selectedMenu == 0,
          onTap: () => setState(() => _selectedMenu = 0),
        ),
        const SizedBox(height: 6),
        _FinanceMenuButton(
          title: 'Setoran kolektor',
          icon: Icons.assignment_returned_rounded,
          color: _orange,
          selected: _selectedMenu == 1,
          onTap: () => setState(() => _selectedMenu = 1),
        ),
        const SizedBox(height: 6),
        _FinanceMenuButton(
          title: 'Buku pemasukan',
          icon: Icons.trending_up_rounded,
          color: _green,
          selected: _selectedMenu == 2,
          onTap: () => setState(() => _selectedMenu = 2),
        ),
        const SizedBox(height: 6),
        _FinanceMenuButton(
          title: 'Buku pengeluaran',
          icon: Icons.trending_down_rounded,
          color: _red,
          selected: _selectedMenu == 3,
          onTap: () => setState(() => _selectedMenu = 3),
        ),
        const SizedBox(height: 6),
        _FinanceMenuButton(
          title: 'Laporan keuangan',
          icon: Icons.assessment_rounded,
          color: _navy,
          selected: _selectedMenu == 4,
          onTap: () => setState(() => _selectedMenu = 4),
        ),
      ],
    );
  }

  Widget _periodHeader() {
    final nowYear = DateTime.now().year;
    final years = List<int>.generate(9, (index) => nowYear - 4 + index);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Filter periode',
            style: TextStyle(
              color: Color(0xFF0F172A),
              fontSize: 16,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                flex: 2,
                child: _PeriodDropdown<int>(
                  label: 'Bulan',
                  value: _month,
                  items: [
                    const DropdownMenuItem<int>(
                      value: 0,
                      child: Text('Satu tahun'),
                    ),
                    for (var i = 1; i <= 12; i++)
                      DropdownMenuItem<int>(
                        value: i,
                        child: Text(_monthNames[i - 1]),
                      ),
                  ],
                  onChanged: (value) async {
                    if (value == null || value == _month) return;
                    setState(() => _month = value);
                    await _load();
                  },
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _PeriodDropdown<int>(
                  label: 'Tahun',
                  value: _year,
                  items: [
                    for (final year in years)
                      DropdownMenuItem<int>(
                        value: year,
                        child: Text(year.toString()),
                      ),
                  ],
                  onChanged: (value) async {
                    if (value == null || value == _year) return;
                    setState(() => _year = value);
                    await _load();
                  },
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  List<Widget> _buildPaymentsTab() {
    final payments = _map(_data?['payments']);
    final summary = _map(payments['summary']);
    final items = _list(payments['items']);
    return [
      _CompactSummaryRow(
        children: [
          _CompactStatTile(
            'Tagihan',
            _rupiah(summary['total_tagihan']),
            Icons.request_quote_rounded,
            _orange,
          ),
          _CompactStatTile(
            'Diskon',
            _rupiah(summary['total_discount']),
            Icons.local_offer_rounded,
            _green,
          ),
          _CompactStatTile(
            'Bersih',
            _rupiah(summary['total_net']),
            Icons.account_balance_wallet_rounded,
            _red,
          ),
        ],
      ),
      const SizedBox(height: 14),
      _SectionCard(
        title: 'Riwayat Pembayaran',
        subtitle: '${items.length} transaksi terbaru',
        child: items.isEmpty
            ? const _EmptyState(text: 'Belum ada pembayaran pada periode ini.')
            : Column(
                children: [for (final item in items) _paymentHistoryRow(item)],
              ),
      ),
    ];
  }

  Widget _paymentHistoryRow(Map<String, dynamic> item) {
    final invoice = item['invoice_number']?.toString() ?? '-';
    final method = item['payment_method']?.toString() ?? '-';
    final collector = item['collector_name']?.toString().trim() ?? '';
    final discount = _num(item['discount_amount']);
    final detail = [
      if (collector.isNotEmpty) 'Kolektor: $collector',
      if (discount > 0) 'Diskon ${_rupiah(discount)}',
    ].join(' • ');
    return _PaymentHistoryRow(
      customerName: item['customer_name']?.toString() ?? 'Tanpa pelanggan',
      amount: _rupiah(item['jumlah_setelah_diskon'] ?? item['amount']),
      meta: '$invoice • $method • ${_shortDate(item['payment_date'])}',
      detail: detail,
    );
  }

  List<Widget> _buildRemittanceTab() {
    final remittance = _map(_data?['remittance']);
    final summary = _map(remittance['summary']);
    final collectors = _list(remittance['collectors']);
    final receipts = _list(remittance['receipts']);
    int sumCollectorCount(String key) => collectors.fold<int>(
      0,
      (sum, collector) => sum + _num(collector[key]).round(),
    );
    final totalTagihanCount = sumCollectorCount('count_tagihan_area');
    final lunasCount = sumCollectorCount('count_lunas_area');
    final belumLunasCount = sumCollectorCount('total_belum_lunas_count');
    final commissionCount = sumCollectorCount('total_payments');
    return [
      _FullWidthSummaryPill(
        title: 'Total tagihan kolektor',
        countLabel: '${_number(totalTagihanCount)} tagihan',
        value: _rupiah(summary['total_tagihan']),
        icon: Icons.map_rounded,
        color: _navy,
      ),
      const SizedBox(height: 10),
      _CompactSummaryRow(
        children: [
          _CompactStatTile(
            'Lunas Area',
            _rupiah(summary['total_lunas']),
            Icons.check_circle_rounded,
            _green,
            countLabel: '${_number(lunasCount)} lunas',
          ),
          _CompactStatTile(
            'Belum Lunas',
            _rupiah(summary['total_belum_lunas']),
            Icons.pending_actions_rounded,
            _orange,
            countLabel: '${_number(belumLunasCount)} belum',
          ),
          _CompactStatTile(
            'Komisi',
            _rupiah(summary['total_komisi']),
            Icons.payments_rounded,
            _red,
            countLabel: '${_number(commissionCount)} trx',
          ),
        ],
      ),
      const SizedBox(height: 14),
      _SectionCard(
        title: 'Setoran Kolektor',
        subtitle: 'Kolektor dengan sisa belum setor',
        child: collectors.isEmpty
            ? const _EmptyState(text: 'Belum ada kolektor aktif.')
            : Column(
                children: [
                  for (final collector in collectors)
                    _FinanceRow(
                      title: collector['name']?.toString() ?? 'Kolektor',
                      subtitle:
                          'Sudah setor ${_rupiah(collector['sudah_setor'])} • ${_number(collector['pending_payments_count'])} pembayaran',
                      trailing: _rupiah(collector['pending_amount']),
                      action: _num(collector['pending_amount']) > 0
                          ? TextButton(
                              onPressed: () => _openRemittanceSheet(collector),
                              child: const Text('Terima'),
                            )
                          : null,
                    ),
                ],
              ),
      ),
      const SizedBox(height: 14),
      _SectionCard(
        title: 'Riwayat Terima Setoran',
        subtitle: '${receipts.length} penerimaan terakhir',
        child: receipts.isEmpty
            ? const _EmptyState(text: 'Belum ada riwayat setoran.')
            : Column(
                children: [
                  for (final item in receipts)
                    _FinanceRow(
                      title: item['collector_name']?.toString() ?? 'Kolektor',
                      subtitle:
                          '${item['payment_method'] ?? '-'} • ${_shortDate(item['received_at'])}',
                      trailing: _rupiah(item['amount']),
                    ),
                ],
              ),
      ),
    ];
  }

  List<Widget> _buildIncomeTab() {
    final report = _map(_data?['financial_report']);
    final summary = _map(report['summary']);
    final items = _list(
      report['transactions'],
    ).where((item) => item['type'] == 'income').toList();
    final fallbackTotal = items.fold<num>(
      0,
      (sum, item) => sum + _num(item['amount']),
    );
    return [
      _ActionHeader(
        title: 'Pemasukan',
        value: _rupiah(summary['totalIncome'] ?? fallbackTotal),
        buttonLabel: 'Tambah Pemasukan',
        onPressed: _openIncomeSheet,
      ),
      const SizedBox(height: 14),
      _SectionCard(
        title: 'Daftar Pemasukan',
        subtitle: '${items.length} catatan pada periode ini',
        child: items.isEmpty
            ? const _EmptyState(text: 'Belum ada pemasukan pada periode ini.')
            : Column(
                children: [for (final item in items) _incomeHistoryRow(item)],
              ),
      ),
    ];
  }

  Widget _incomeHistoryRow(Map<String, dynamic> item) {
    final invoice = item['invoice_number']?.toString().trim() ?? '';
    final method = item['payment_method']?.toString().trim() ?? '';
    final gateway = item['gateway_name']?.toString().trim() ?? '';
    final description = item['description']?.toString().trim() ?? '';
    final customer = item['customer_name']?.toString().trim() ?? '';
    final phone = item['customer_phone']?.toString().trim() ?? '';
    final collector = item['collector_name']?.toString().trim() ?? '';
    final source = invoice.isNotEmpty
        ? 'Billing pelanggan'
        : gateway.toLowerCase().startsWith('pendapatan -')
        ? 'Manual'
        : gateway.isNotEmpty
        ? gateway
        : 'Pemasukan';
    final title = customer.isNotEmpty
        ? customer
        : description.isNotEmpty
        ? description
        : gateway.isNotEmpty
        ? gateway
        : 'Pemasukan';
    final metaParts = [
      source,
      if (invoice.isNotEmpty) invoice,
      if (method.isNotEmpty) method,
      _shortDate(item['date']),
    ];
    final detailParts = [
      if (phone.isNotEmpty) phone,
      if (collector.isNotEmpty) 'Kolektor: $collector',
      if (description.isNotEmpty && description != title) description,
    ];
    return _IncomeHistoryRow(
      title: title,
      amount: _rupiah(item['amount']),
      meta: metaParts.join(' • '),
      detail: detailParts.join(' • '),
    );
  }

  List<Widget> _buildExpensesTab() {
    final expenses = _map(_data?['expenses']);
    final items = _list(expenses['items']);
    return [
      _ActionHeader(
        title: 'Pengeluaran',
        value: _rupiah(expenses['total']),
        buttonLabel: 'Tambah Pengeluaran',
        onPressed: _openExpenseSheet,
      ),
      const SizedBox(height: 14),
      _SectionCard(
        title: 'Daftar Pengeluaran',
        subtitle: '${items.length} catatan pada periode ini',
        child: items.isEmpty
            ? const _EmptyState(text: 'Belum ada pengeluaran.')
            : Column(
                children: [
                  for (final item in items)
                    _FinanceRow(
                      title:
                          item['account_expenses']?.toString().isNotEmpty ==
                              true
                          ? item['account_expenses'].toString()
                          : item['category']?.toString() ?? 'Pengeluaran',
                      subtitle:
                          '${item['category'] ?? '-'} • ${_shortDate(item['expense_date'])}',
                      trailing: _rupiah(item['amount']),
                    ),
                ],
              ),
      ),
    ];
  }

  List<Widget> _buildReportTab() {
    final report = _map(_data?['financial_report']);
    final summary = _map(report['summary']);
    final items = _list(report['transactions']);
    return [
      _SummaryGrid(
        children: [
          _StatTile(
            'Pemasukan',
            _rupiah(summary['totalIncome']),
            Icons.trending_up_rounded,
            _green,
          ),
          _StatTile(
            'Pengeluaran',
            _rupiah(summary['totalExpense']),
            Icons.trending_down_rounded,
            _red,
          ),
          _StatTile(
            'Komisi',
            _rupiah(summary['totalCommission']),
            Icons.percent_rounded,
            _orange,
          ),
          _StatTile(
            'Laba Bersih',
            _rupiah(summary['netProfit']),
            Icons.account_balance_wallet_rounded,
            _navy,
          ),
        ],
      ),
      const SizedBox(height: 14),
      _SectionCard(
        title: 'Laporan Keuangan',
        subtitle: '${items.length} transaksi gabungan terbaru',
        child: items.isEmpty
            ? const _EmptyState(text: 'Belum ada transaksi laporan.')
            : Column(
                children: [
                  for (final item in items)
                    _FinanceRow(
                      title:
                          item['gateway_name']?.toString() ??
                          item['description']?.toString() ??
                          item['type']?.toString() ??
                          'Transaksi',
                      subtitle:
                          '${item['type'] == 'expense' ? 'Pengeluaran' : 'Pemasukan'} • ${_shortDate(item['date'])}',
                      trailing: _rupiah(item['amount']),
                    ),
                ],
              ),
      ),
    ];
  }

  void _openRemittanceSheet(Map<String, dynamic> collector) {
    final amount = TextEditingController(
      text: _num(collector['pending_amount']).round().toString(),
    );
    final method = TextEditingController(text: 'cash');
    final notes = TextEditingController();
    final date = TextEditingController(text: _date.format(DateTime.now()));
    _showFinanceSheet(
      title: 'Terima Setoran',
      children: [
        Text(
          collector['name']?.toString() ?? 'Kolektor',
          style: const TextStyle(
            color: Color(0xFF0F172A),
            fontSize: 18,
            fontWeight: FontWeight.w900,
          ),
        ),
        const SizedBox(height: 12),
        _Field(
          controller: amount,
          label: 'Jumlah setoran',
          keyboardType: TextInputType.number,
        ),
        _Field(controller: method, label: 'Metode pembayaran'),
        _Field(controller: date, label: 'Tanggal'),
        _Field(controller: notes, label: 'Catatan', maxLines: 2),
      ],
      onSubmit: () => _postAction(
        '/api/mobile-adapter/admin/finance/remittance',
        {
          'collector_id': collector['id'],
          'amount': amount.text,
          'payment_method': method.text,
          'remittance_date': date.text,
          'notes': notes.text,
        },
        'Setoran berhasil diterima',
      ),
    );
  }

  void _openIncomeSheet() {
    final description = TextEditingController();
    final amount = TextEditingController();
    final incomeCategories = _financeCategoryNames('income_categories');
    final methods = _paymentMethods();
    final category = TextEditingController(
      text: incomeCategories.isNotEmpty ? incomeCategories.first : '',
    );
    final method = TextEditingController(
      text: methods.isNotEmpty ? methods.first : '',
    );
    final date = TextEditingController(text: _date.format(DateTime.now()));
    final notes = TextEditingController();
    _showFinanceSheet(
      title: 'Tambah Pemasukan',
      children: [
        _Field(controller: description, label: 'Deskripsi'),
        _Field(
          controller: amount,
          label: 'Jumlah',
          keyboardType: TextInputType.number,
        ),
        _DropdownField(
          controller: category,
          label: 'Kategori',
          options: incomeCategories,
        ),
        _DatePickerField(controller: date, label: 'Tanggal pemasukan'),
        _DropdownField(
          controller: method,
          label: 'Metode pembayaran',
          options: methods,
          allowEmpty: true,
        ),
        _Field(controller: notes, label: 'Catatan', maxLines: 2),
      ],
      onSubmit: () => _postAction(
        '/api/mobile-adapter/admin/finance/income',
        {
          'description': description.text,
          'amount': amount.text,
          'category': category.text,
          'income_date': date.text,
          'payment_method': method.text,
          'notes': notes.text,
        },
        'Pemasukan berhasil ditambahkan',
      ),
    );
  }

  void _openExpenseSheet() {
    final account = TextEditingController();
    final amount = TextEditingController();
    final expenseCategories = _financeCategoryNames('expense_categories');
    final methods = _paymentMethods();
    final category = TextEditingController(
      text: expenseCategories.isNotEmpty ? expenseCategories.first : '',
    );
    final method = TextEditingController(
      text: methods.isNotEmpty ? methods.first : '',
    );
    final date = TextEditingController(text: _date.format(DateTime.now()));
    final notes = TextEditingController();
    _showFinanceSheet(
      title: 'Tambah Pengeluaran',
      children: [
        StatefulBuilder(
          builder: (context, setLocalState) {
            final accountOptions = _expenseAccountsFor(category.text);
            if (account.text.isEmpty && accountOptions.isNotEmpty) {
              account.text = accountOptions.first;
            } else if (account.text.isNotEmpty &&
                accountOptions.isNotEmpty &&
                !accountOptions.contains(account.text)) {
              account.text = accountOptions.first;
            }
            return Column(
              children: [
                _DropdownField(
                  controller: category,
                  label: 'Kategori expenses',
                  options: expenseCategories,
                  onChanged: (_) {
                    account.clear();
                    setLocalState(() {});
                  },
                ),
                _DropdownField(
                  controller: account,
                  label: 'Account expenses',
                  options: accountOptions,
                ),
              ],
            );
          },
        ),
        _Field(
          controller: amount,
          label: 'Jumlah',
          keyboardType: TextInputType.number,
        ),
        _DatePickerField(controller: date, label: 'Tanggal pengeluaran'),
        _DropdownField(
          controller: method,
          label: 'Metode pembayaran',
          options: methods,
          allowEmpty: true,
        ),
        _Field(controller: notes, label: 'Catatan', maxLines: 2),
      ],
      onSubmit: () => _postAction(
        '/api/mobile-adapter/admin/finance/expenses',
        {
          'account_expenses': account.text,
          'amount': amount.text,
          'category': category.text,
          'expense_date': date.text,
          'payment_method': method.text,
          'notes': notes.text,
        },
        'Pengeluaran berhasil ditambahkan',
      ),
    );
  }

  void _showFinanceSheet({
    required String title,
    required List<Widget> children,
    required Future<void> Function() onSubmit,
  }) {
    var submitting = false;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            Future<void> submit() async {
              if (submitting) return;
              setModalState(() => submitting = true);
              try {
                await onSubmit();
              } catch (e) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        e.toString().replaceFirst('Exception: ', ''),
                      ),
                    ),
                  );
                }
                setModalState(() => submitting = false);
              }
            }

            return Padding(
              padding: EdgeInsets.only(
                left: 18,
                right: 18,
                top: 18,
                bottom: MediaQuery.of(context).viewInsets.bottom + 18,
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        color: Color(0xFF0F172A),
                        fontSize: 20,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 16),
                    ...children,
                    const SizedBox(height: 12),
                    ElevatedButton.icon(
                      onPressed: submitting ? null : submit,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF10B981),
                        foregroundColor: Colors.white,
                        disabledBackgroundColor: const Color(0xFFCBD5E1),
                        disabledForegroundColor: Colors.white,
                        minimumSize: const Size.fromHeight(46),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                      ),
                      icon: submitting
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.save_rounded),
                      label: Text(submitting ? 'Menyimpan...' : 'Simpan'),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }
}

class _SummaryGrid extends StatelessWidget {
  final List<Widget> children;

  const _SummaryGrid({required this.children});

  @override
  Widget build(BuildContext context) {
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 12,
      crossAxisSpacing: 12,
      childAspectRatio: 1.55,
      children: children,
    );
  }
}

class _CompactSummaryRow extends StatelessWidget {
  final List<Widget> children;

  const _CompactSummaryRow({required this.children});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < children.length; i++) ...[
          Expanded(child: children[i]),
          if (i != children.length - 1) const SizedBox(width: 8),
        ],
      ],
    );
  }
}

class _FullWidthSummaryPill extends StatelessWidget {
  final String title;
  final String? countLabel;
  final String value;
  final IconData icon;
  final Color color;

  const _FullWidthSummaryPill({
    required this.title,
    this.countLabel,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withValues(alpha: 0.28)),
        boxShadow: [
          BoxShadow(
            color: color.withValues(alpha: 0.08),
            blurRadius: 12,
            offset: const Offset(0, 5),
          ),
        ],
      ),
      child: Stack(
        children: [
          Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, color: color, size: 21),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _SummaryTitle(title: title),
                    const SizedBox(height: 2),
                    Text(
                      value,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: Color(0xFF0F172A),
                        fontSize: 18,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (countLabel != null && countLabel!.isNotEmpty)
            Positioned(
              right: 0,
              top: 0,
              child: _CountBadge(label: countLabel!),
            ),
        ],
      ),
    );
  }
}

class _CompactStatTile extends StatelessWidget {
  final String title;
  final String value;
  final IconData icon;
  final Color color;
  final String? countLabel;

  const _CompactStatTile(
    this.title,
    this.value,
    this.icon,
    this.color, {
    this.countLabel,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Stack(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: color, size: 18),
              const SizedBox(height: 8),
              Text(
                value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: Color(0xFF0F172A),
                  fontSize: 12,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 2),
              _SummaryTitle(title: title, compact: true),
            ],
          ),
          if (countLabel != null && countLabel!.isNotEmpty)
            Positioned(
              right: 0,
              top: 0,
              child: _CountBadge(label: countLabel!, compact: true),
            ),
        ],
      ),
    );
  }
}

class _SummaryTitle extends StatelessWidget {
  final String title;
  final bool compact;

  const _SummaryTitle({required this.title, this.compact = false});

  @override
  Widget build(BuildContext context) {
    return Text(
      title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        color: const Color(0xFF64748B),
        fontSize: compact ? 10.5 : 12,
        fontWeight: FontWeight.w800,
      ),
    );
  }
}

class _CountBadge extends StatelessWidget {
  final String label;
  final bool compact;

  const _CountBadge({required this.label, this.compact = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(maxWidth: compact ? 58 : 120),
      padding: EdgeInsets.symmetric(
        horizontal: compact ? 4 : 6,
        vertical: compact ? 1 : 2,
      ),
      decoration: BoxDecoration(
        color: const Color(0xFFEFF6FF),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: const Color(0xFF2563EB),
          fontSize: compact ? 8.5 : 10,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }
}

class _PeriodDropdown<T> extends StatelessWidget {
  final String label;
  final T value;
  final List<DropdownMenuItem<T>> items;
  final ValueChanged<T?> onChanged;

  const _PeriodDropdown({
    required this.label,
    required this.value,
    required this.items,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return DropdownButtonFormField<T>(
      initialValue: value,
      items: items,
      onChanged: onChanged,
      dropdownColor: Colors.white,
      style: const TextStyle(
        color: Color(0xFF0F172A),
        fontWeight: FontWeight.w800,
      ),
      decoration: InputDecoration(
        labelText: label,
        labelStyle: const TextStyle(
          color: Color(0xFF64748B),
          fontWeight: FontWeight.w700,
        ),
        filled: true,
        fillColor: const Color(0xFFF8FAFC),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 10,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: Color(0xFF1D4ED8), width: 1.4),
        ),
      ),
    );
  }
}

class _FinanceMenuButton extends StatelessWidget {
  final String title;
  final IconData icon;
  final Color color;
  final bool selected;
  final VoidCallback onTap;

  const _FinanceMenuButton({
    required this.title,
    required this.icon,
    required this.color,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: selected ? color : const Color(0xFFE2E8F0),
            width: selected ? 1.2 : 1,
          ),
          boxShadow: selected
              ? [
                  BoxShadow(
                    color: color.withValues(alpha: 0.10),
                    blurRadius: 10,
                    offset: const Offset(0, 4),
                  ),
                ]
              : null,
        ),
        child: Row(
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                color: color.withValues(alpha: selected ? 0.14 : 0.09),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: color, size: 19),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                title,
                style: const TextStyle(
                  color: Color(0xFF0F172A),
                  fontSize: 14,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
            Icon(
              selected
                  ? Icons.check_circle_rounded
                  : Icons.chevron_right_rounded,
              color: selected ? color : const Color(0xFF94A3B8),
              size: 20,
            ),
          ],
        ),
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  final String title;
  final String value;
  final IconData icon;
  final Color color;

  const _StatTile(this.title, this.value, this.icon, this.color);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color),
          const Spacer(),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF0F172A),
              fontSize: 18,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF64748B),
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionHeader extends StatelessWidget {
  final String title;
  final String value;
  final String buttonLabel;
  final VoidCallback onPressed;

  const _ActionHeader({
    required this.title,
    required this.value,
    required this.buttonLabel,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            title,
            style: const TextStyle(
              color: Color(0xFF64748B),
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            value,
            style: const TextStyle(
              color: Color(0xFF0F172A),
              fontSize: 24,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 14),
          ElevatedButton.icon(
            onPressed: onPressed,
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF2563EB),
              foregroundColor: Colors.white,
              disabledBackgroundColor: const Color(0xFFCBD5E1),
              disabledForegroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
            ),
            icon: const Icon(Icons.add_rounded),
            label: Text(buttonLabel),
          ),
        ],
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  final String title;
  final String subtitle;
  final Widget child;

  const _SectionCard({
    required this.title,
    required this.subtitle,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              color: Color(0xFF0F172A),
              fontSize: 17,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            subtitle,
            style: const TextStyle(
              color: Color(0xFF64748B),
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}

class _FinanceRow extends StatelessWidget {
  final String title;
  final String subtitle;
  final String trailing;
  final Widget? action;

  const _FinanceRow({
    required this.title,
    required this.subtitle,
    required this.trailing,
    this.action,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: Color(0xFF0F172A),
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: Color(0xFF64748B),
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                trailing,
                style: const TextStyle(
                  color: Color(0xFF0F172A),
                  fontWeight: FontWeight.w900,
                ),
              ),
              ?action,
            ],
          ),
        ],
      ),
    );
  }
}

class _PaymentHistoryRow extends StatelessWidget {
  final String customerName;
  final String amount;
  final String meta;
  final String detail;

  const _PaymentHistoryRow({
    required this.customerName,
    required this.amount,
    required this.meta,
    required this.detail,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  customerName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF0F172A),
                    fontSize: 13,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  meta,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF64748B),
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (detail.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Color(0xFF475569),
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            amount,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF0F172A),
              fontSize: 12,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }
}

class _IncomeHistoryRow extends StatelessWidget {
  final String title;
  final String amount;
  final String meta;
  final String detail;

  const _IncomeHistoryRow({
    required this.title,
    required this.amount,
    required this.meta,
    required this.detail,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
              color: const Color(0xFFEAFBF4),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(
              Icons.arrow_downward_rounded,
              color: Color(0xFF10B981),
              size: 17,
            ),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF0F172A),
                    fontSize: 13,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  meta,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF64748B),
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (detail.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Color(0xFF475569),
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            amount,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF0F172A),
              fontSize: 12,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }
}

class _DropdownField extends StatefulWidget {
  final TextEditingController controller;
  final String label;
  final List<String> options;
  final bool allowEmpty;
  final ValueChanged<String?>? onChanged;

  const _DropdownField({
    required this.controller,
    required this.label,
    required this.options,
    this.allowEmpty = false,
    this.onChanged,
  });

  @override
  State<_DropdownField> createState() => _DropdownFieldState();
}

class _DropdownFieldState extends State<_DropdownField> {
  @override
  Widget build(BuildContext context) {
    final options = [
      if (widget.allowEmpty) '',
      ...widget.options.where((item) => item.trim().isNotEmpty),
    ];
    final distinct = <String>{};
    final uniqueOptions = options.where((item) => distinct.add(item)).toList();
    final currentValue = uniqueOptions.contains(widget.controller.text)
        ? widget.controller.text
        : uniqueOptions.isNotEmpty
        ? uniqueOptions.first
        : null;
    if (currentValue != null && widget.controller.text != currentValue) {
      widget.controller.text = currentValue;
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: DropdownButtonFormField<String>(
        initialValue: currentValue,
        items: uniqueOptions
            .map(
              (item) => DropdownMenuItem<String>(
                value: item,
                child: Text(item.isEmpty ? 'Pilih ${widget.label}' : item),
              ),
            )
            .toList(),
        onChanged: uniqueOptions.isEmpty
            ? null
            : (value) {
                widget.controller.text = value ?? '';
                widget.onChanged?.call(value);
                setState(() {});
              },
        dropdownColor: Colors.white,
        style: const TextStyle(
          color: Color(0xFF0F172A),
          fontWeight: FontWeight.w700,
        ),
        decoration: _financeInputDecoration(widget.label),
      ),
    );
  }
}

class _DatePickerField extends StatelessWidget {
  final TextEditingController controller;
  final String label;

  const _DatePickerField({required this.controller, required this.label});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        controller: controller,
        readOnly: true,
        style: const TextStyle(
          color: Color(0xFF0F172A),
          fontWeight: FontWeight.w700,
        ),
        decoration: _financeInputDecoration(
          label,
          suffixIcon: const Icon(Icons.calendar_month_rounded),
        ),
        onTap: () async {
          final initial = DateTime.tryParse(controller.text) ?? DateTime.now();
          final picked = await showDatePicker(
            context: context,
            initialDate: initial,
            firstDate: DateTime(2020),
            lastDate: DateTime(DateTime.now().year + 5, 12, 31),
            builder: (context, child) {
              return Theme(
                data: Theme.of(context).copyWith(
                  colorScheme: const ColorScheme.light(
                    primary: Color(0xFF2563EB),
                    onPrimary: Colors.white,
                    onSurface: Color(0xFF0F172A),
                  ),
                ),
                child: child!,
              );
            },
          );
          if (picked != null) {
            controller.text = DateFormat('yyyy-MM-dd').format(picked);
          }
        },
      ),
    );
  }
}

class _Field extends StatelessWidget {
  final TextEditingController controller;
  final String label;
  final TextInputType? keyboardType;
  final int maxLines;

  const _Field({
    required this.controller,
    required this.label,
    this.keyboardType,
    this.maxLines = 1,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        controller: controller,
        keyboardType: keyboardType,
        maxLines: maxLines,
        style: const TextStyle(
          color: Color(0xFF0F172A),
          fontWeight: FontWeight.w700,
        ),
        cursorColor: const Color(0xFF2563EB),
        decoration: _financeInputDecoration(label),
      ),
    );
  }
}

InputDecoration _financeInputDecoration(String label, {Widget? suffixIcon}) {
  return InputDecoration(
    labelText: label,
    labelStyle: const TextStyle(
      color: Color(0xFF64748B),
      fontWeight: FontWeight.w700,
    ),
    floatingLabelStyle: const TextStyle(
      color: Color(0xFF2563EB),
      fontWeight: FontWeight.w800,
    ),
    filled: true,
    fillColor: const Color(0xFFF8FAFC),
    suffixIcon: suffixIcon,
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: Color(0xFF2563EB), width: 1.4),
    ),
    disabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
    ),
  );
}

class _EmptyState extends StatelessWidget {
  final String text;

  const _EmptyState({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 18),
      child: Center(
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: Color(0xFF64748B),
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.error_outline_rounded,
              size: 42,
              color: Color(0xFFE84C4F),
            ),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh_rounded),
              label: const Text('Muat Ulang'),
            ),
          ],
        ),
      ),
    );
  }
}
