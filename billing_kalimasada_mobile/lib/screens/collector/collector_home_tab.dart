import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../store/auth_provider.dart';
import '../../store/collector_provider.dart';
import '../../theme/collector_colors.dart';
import '../../utils/collector_debug_log.dart';
import '../tag_customer_location_screen.dart';

String _rupiah(num? v) {
  final n = (v ?? 0).round();
  return 'Rp ${NumberFormat.decimalPattern('id_ID').format(n)}';
}

String _tenantName(BuildContext context) {
  const keys = [
    'tenant_name',
    'tenantName',
    'company_header',
    'companyHeader',
    'company',
    'business_name',
    'tenant',
  ];
  final authUser = context.read<AuthProvider>().user;
  for (final key in keys) {
    final value = authUser?[key]?.toString().trim() ?? '';
    if (value.isNotEmpty) return value;
  }
  final slug = ApiClient.apiTenant?.trim();
  if (slug != null && slug.isNotEmpty) {
    return slug[0].toUpperCase() + slug.substring(1);
  }
  return 'Billing Kalimasada';
}

const _kMonthShortId = [
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

const _kMonthLongId = [
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

class CollectorHomeTab extends StatefulWidget {
  const CollectorHomeTab({super.key, this.onOpenCustomersList});

  /// Pindah ke daftar pelanggan; [status] kosong = semua, `unpaid` / `paid` / `isolir`.
  final void Function(String status)? onOpenCustomersList;

  @override
  State<CollectorHomeTab> createState() => _CollectorHomeTabState();
}

class _CollectorHomeTabState extends State<CollectorHomeTab> {
  late int _month;
  late int _year;
  bool _syncedDropdownFromProvider = false;

  @override
  void initState() {
    super.initState();
    final n = DateTime.now();
    _month = n.month;
    _year = n.year;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_syncedDropdownFromProvider) return;
    final p = context.read<CollectorProvider>();
    if (p.overviewMonth != null && p.overviewYear != null) {
      _month = p.overviewMonth!;
      _year = p.overviewYear!;
    }
    _syncedDropdownFromProvider = true;
  }

  @override
  Widget build(BuildContext context) {
    final (data, overviewLoading, overviewError) = context.select(
      (CollectorProvider p) => (p.overview, p.overviewLoading, p.overviewError),
    );
    final field = data != null
        ? data['fieldUi'] as Map<String, dynamic>?
        : null;
    final collector = data != null
        ? data['collector'] as Map<String, dynamic>?
        : null;

    if (overviewLoading && field == null) {
      return ColoredBox(
        color: FieldCollectorColors.dashboardCanvas,
        child: const Center(
          child: CircularProgressIndicator(
            color: FieldCollectorColors.primaryContainer,
          ),
        ),
      );
    }
    if (overviewError != null && field == null) {
      return ColoredBox(
        color: FieldCollectorColors.dashboardCanvas,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(overviewError, textAlign: TextAlign.center),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () => context
                      .read<CollectorProvider>()
                      .setPeriodAndRefresh(month: _month, year: _year),
                  child: const Text('Coba lagi'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final name = collector?['name']?.toString() ?? 'Kolektor';
    final initials = name
        .split(RegExp(r'\s+'))
        .where((e) => e.isNotEmpty)
        .map((e) => e[0])
        .take(2)
        .join()
        .toUpperCase();
    final tenantName = _tenantName(context);
    final displayDate = field?['displayDate']?.toString() ?? '';
    final target = (field?['targetMonth'] as num?)?.toInt() ?? 0;
    final terkumpul = (field?['terkumpul'] as num?)?.toInt() ?? 0;
    final pct = (field?['progressPct'] as num?)?.toInt() ?? 0;
    final sisa = (field?['sisaTarget'] as num?)?.toInt() ?? 0;
    final totalPlg = (field?['totalPelangganAktif'] as num?)?.toInt() ?? 0;
    final baru = (field?['baruCount'] as num?)?.toInt() ?? 0;
    final blm = (field?['belumBayarCount'] as num?)?.toInt() ?? 0;
    final lunas = (field?['lunasCount'] as num?)?.toInt() ?? 0;
    final isolir = (field?['isolirCount'] as num?)?.toInt() ?? 0;
    final nonaktif = (field?['nonaktifCount'] as num?)?.toInt() ?? 0;

    return ColoredBox(
      color: FieldCollectorColors.dashboardCanvas,
      child: RefreshIndicator(
        color: FieldCollectorColors.primaryContainer,
        onRefresh: () => context.read<CollectorProvider>().setPeriodAndRefresh(
          month: _month,
          year: _year,
        ),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 28),
          children: [
            _Card(
              gradient: const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  FieldCollectorColors.dashWelcomeTop,
                  FieldCollectorColors.dashWelcomeBottom,
                ],
              ),
              borderRadius: 20,
              shadows: const [
                BoxShadow(
                  color: Color(0x400F3460),
                  blurRadius: 16,
                  offset: Offset(0, 8),
                ),
              ],
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Halo,',
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(
                                fontWeight: FontWeight.w600,
                                color: FieldCollectorColors.dashWelcomeSubtitle,
                              ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          name,
                          style: Theme.of(context).textTheme.headlineSmall
                              ?.copyWith(
                                fontWeight: FontWeight.w800,
                                color: FieldCollectorColors.dashWelcomeOnAccent,
                                height: 1.15,
                              ),
                        ),
                        const SizedBox(height: 10),
                        _rowIconWelcome(
                          Icons.calendar_today_rounded,
                          displayDate,
                        ),
                        const SizedBox(height: 6),
                        _rowIconWelcome(Icons.apartment_rounded, tenantName),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.all(3),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: Colors.white.withValues(alpha: 0.35),
                      ),
                    ),
                    child: CircleAvatar(
                      radius: 26,
                      backgroundColor: Colors.white.withValues(alpha: 0.2),
                      child: Text(
                        initials.isEmpty ? 'K' : initials,
                        style: const TextStyle(
                          color: FieldCollectorColors.dashWelcomeOnAccent,
                          fontWeight: FontWeight.w800,
                          fontSize: 18,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _periodBar(loading: overviewLoading),
            const SizedBox(height: 14),
            Container(
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    FieldCollectorColors.dashTargetA,
                    FieldCollectorColors.dashTargetB,
                  ],
                ),
                borderRadius: BorderRadius.circular(20),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x4D0D3B66),
                    blurRadius: 18,
                    offset: Offset(0, 10),
                  ),
                ],
              ),
              clipBehavior: Clip.antiAlias,
              child: Stack(
                children: [
                  Positioned(
                    right: -36,
                    top: -48,
                    child: Container(
                      width: 140,
                      height: 140,
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.07),
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                  Positioned(
                    left: -20,
                    bottom: -30,
                    child: Container(
                      width: 100,
                      height: 100,
                      decoration: BoxDecoration(
                        color: FieldCollectorColors.dashTargetProgress
                            .withValues(alpha: 0.12),
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(18, 18, 18, 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'TARGET TAGIHAN ${_periodLabel.toUpperCase()}',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.85,
                            color: FieldCollectorColors.primaryFixedDim
                                .withValues(alpha: 0.9),
                          ),
                        ),
                        const SizedBox(height: 6),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Expanded(
                              child: Text(
                                _rupiah(target),
                                style: const TextStyle(
                                  fontSize: 24,
                                  fontWeight: FontWeight.w800,
                                  color: FieldCollectorColors.onPrimary,
                                  letterSpacing: -0.5,
                                ),
                              ),
                            ),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                Text(
                                  '$pct%',
                                  style: const TextStyle(
                                    fontSize: 22,
                                    fontWeight: FontWeight.w800,
                                    color:
                                        FieldCollectorColors.dashTargetProgress,
                                    height: 1,
                                  ),
                                ),
                                Text(
                                  'Progress',
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w600,
                                    color: FieldCollectorColors.primaryFixedDim
                                        .withValues(alpha: 0.95),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                        const SizedBox(height: 14),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(999),
                          child: LinearProgressIndicator(
                            value: pct / 100,
                            minHeight: 9,
                            backgroundColor:
                                FieldCollectorColors.dashTargetProgressTrack,
                            color: FieldCollectorColors.dashTargetProgress,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'Terkumpul ${_rupiah(terkumpul)}',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                                color: FieldCollectorColors.primaryFixedDim
                                    .withValues(alpha: 0.98),
                              ),
                            ),
                            Text(
                              'Sisa ${_rupiah(sisa)}',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                                color: FieldCollectorColors.primaryFixedDim
                                    .withValues(alpha: 0.98),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 22),
            Text(
              'Ringkasan',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
                color: FieldCollectorColors.onSurface,
                letterSpacing: -0.2,
              ),
            ),
            const SizedBox(height: 10),
            _summaryCard(
              totalPlg,
              baru,
              blm,
              lunas,
              isolir,
              nonaktif,
              widget.onOpenCustomersList,
            ),
            const SizedBox(height: 22),
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Aksi cepat',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                  color: FieldCollectorColors.onSurface,
                  letterSpacing: -0.2,
                ),
              ),
            ),
            const SizedBox(height: 10),
            Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: () {
                  Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (context) => const TagCustomerLocationScreen(),
                    ),
                  );
                },
                borderRadius: BorderRadius.circular(16),
                child: Ink(
                  height: 52,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(16),
                    gradient: const LinearGradient(
                      begin: Alignment.centerLeft,
                      end: Alignment.centerRight,
                      colors: [
                        FieldCollectorColors.dashActionA,
                        FieldCollectorColors.dashActionB,
                      ],
                    ),
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x593949AB),
                        blurRadius: 14,
                        offset: Offset(0, 7),
                      ),
                    ],
                  ),
                  child: const Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.person_pin_circle_rounded,
                        size: 24,
                        color: FieldCollectorColors.dashActionFg,
                      ),
                      SizedBox(width: 10),
                      Text(
                        'Tag lokasi pelanggan',
                        style: TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 15,
                          color: FieldCollectorColors.dashActionFg,
                          letterSpacing: 0.2,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _rowIconWelcome(IconData icon, String text) {
    return Row(
      children: [
        Icon(icon, size: 17, color: FieldCollectorColors.dashWelcomeSubtitle),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w500,
              color: FieldCollectorColors.dashWelcomeSubtitle,
              height: 1.25,
            ),
          ),
        ),
      ],
    );
  }

  String get _periodLabel =>
      _month == 0 ? 'Tahun $_year' : '${_kMonthShortId[_month - 1]} $_year';

  String get _periodLongLabel =>
      _month == 0 ? 'Satu tahun $_year' : '${_kMonthLongId[_month - 1]} $_year';

  int get _yearMin => DateTime.now().year - 2;
  int get _yearMax => DateTime.now().year + 1;

  (int, int)? _shiftedPeriod(int delta) {
    var month = _month;
    var year = _year;
    if (month == 0) {
      year += delta;
    } else {
      month += delta;
      if (month < 1) {
        month = 12;
        year--;
      } else if (month > 12) {
        month = 1;
        year++;
      }
    }
    if (year < _yearMin || year > _yearMax) return null;
    return (month, year);
  }

  Future<void> _applyPeriod(int month, int year) async {
    final provider = context.read<CollectorProvider>();
    setState(() {
      _month = month;
      _year = year;
    });
    await provider.setPeriodAndRefresh(month: month, year: year);
  }

  Widget _periodBar({required bool loading}) {
    Widget arrow(IconData icon, int delta) {
      final target = _shiftedPeriod(delta);
      final enabled = !loading && target != null;
      return IconButton(
        onPressed: enabled ? () => _applyPeriod(target.$1, target.$2) : null,
        icon: Icon(icon),
        iconSize: 24,
        color: FieldCollectorColors.primaryContainer,
        disabledColor: FieldCollectorColors.outlineVariant,
        style: IconButton.styleFrom(
          backgroundColor: FieldCollectorColors.surfaceContainerHigh,
          disabledBackgroundColor: FieldCollectorColors.background,
          fixedSize: const Size(40, 40),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: FieldCollectorColors.surface,
        borderRadius: BorderRadius.circular(16),
        boxShadow: const [
          BoxShadow(
            color: Color(0x0F000000),
            blurRadius: 12,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: Row(
        children: [
          arrow(Icons.chevron_left_rounded, -1),
          Expanded(
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: loading ? null : _pickPeriod,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Column(
                    children: [
                      const Text(
                        'Periode target',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: FieldCollectorColors.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Flexible(
                            child: Text(
                              _periodLongLabel,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w800,
                                color: FieldCollectorColors.onSurface,
                              ),
                            ),
                          ),
                          const SizedBox(width: 4),
                          if (loading)
                            const SizedBox(
                              width: 14,
                              height: 14,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: FieldCollectorColors.primaryContainer,
                              ),
                            )
                          else
                            const Icon(
                              Icons.expand_more_rounded,
                              size: 18,
                              color: FieldCollectorColors.onSurfaceVariant,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          arrow(Icons.chevron_right_rounded, 1),
        ],
      ),
    );
  }

  Future<void> _pickPeriod() async {
    final yearMin = _yearMin;
    final yearMax = _yearMax;
    var year = _year.clamp(yearMin, yearMax);

    final picked = await showModalBottomSheet<(int, int)>(
      context: context,
      backgroundColor: FieldCollectorColors.surface,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheet) {
          Widget option(String text, int month) {
            final selected = month == _month && year == _year;
            return Material(
              color: selected
                  ? FieldCollectorColors.dashTargetA
                  : FieldCollectorColors.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(12),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => Navigator.pop(sheetContext, (month, year)),
                child: SizedBox(
                  height: 44,
                  child: Center(
                    child: Text(
                      text,
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        color: selected
                            ? FieldCollectorColors.onPrimary
                            : FieldCollectorColors.onSurface,
                      ),
                    ),
                  ),
                ),
              ),
            );
          }

          return SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      const Expanded(
                        child: Text(
                          'Periode target',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
                            color: FieldCollectorColors.onSurface,
                          ),
                        ),
                      ),
                      IconButton(
                        onPressed: year > yearMin
                            ? () => setSheet(() => year--)
                            : null,
                        icon: const Icon(Icons.chevron_left_rounded),
                        color: FieldCollectorColors.onSurface,
                        disabledColor: FieldCollectorColors.outlineVariant,
                      ),
                      Text(
                        '$year',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w800,
                          color: FieldCollectorColors.onSurface,
                        ),
                      ),
                      IconButton(
                        onPressed: year < yearMax
                            ? () => setSheet(() => year++)
                            : null,
                        icon: const Icon(Icons.chevron_right_rounded),
                        color: FieldCollectorColors.onSurface,
                        disabledColor: FieldCollectorColors.outlineVariant,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  GridView.count(
                    crossAxisCount: 4,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    mainAxisSpacing: 8,
                    crossAxisSpacing: 8,
                    childAspectRatio: 1.9,
                    children: [
                      for (var m = 1; m <= 12; m++)
                        option(_kMonthShortId[m - 1], m),
                    ],
                  ),
                  const SizedBox(height: 8),
                  option('Satu tahun $year', 0),
                ],
              ),
            ),
          );
        },
      ),
    );

    if (picked == null || !mounted) return;
    await _applyPeriod(picked.$1, picked.$2);
  }

  Widget _summaryCard(
    int total,
    int baru,
    int blm,
    int lunas,
    int isolir,
    int nonaktif,
    void Function(String status)? onOpenCustomersList,
  ) {
    final fmt = NumberFormat.decimalPattern('id_ID');
    final billed = lunas + blm;
    final paidRatio = billed > 0 ? lunas / billed : 0.0;
    final paidPct = (paidRatio * 100).round();
    final tappable = onOpenCustomersList != null;

    VoidCallback? open(String label, String filterStatus) {
      if (!tappable) return null;
      return () {
        collectorDbg('Dashboard: tap "$label" → filter="$filterStatus"');
        onOpenCustomersList(filterStatus);
      };
    }

    const softShadow = [
      BoxShadow(color: Color(0x0F000000), blurRadius: 12, offset: Offset(0, 4)),
    ];

    Widget dot(Color color) => Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );

    Widget statTile({
      required IconData icon,
      required Color accent,
      required String label,
      required int value,
      required String filterStatus,
    }) {
      return DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          boxShadow: const [
            BoxShadow(
              color: Color(0x330F3460),
              blurRadius: 14,
              offset: Offset(0, 6),
            ),
          ],
        ),
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(20),
          child: InkWell(
            borderRadius: BorderRadius.circular(20),
            onTap: open(label, filterStatus),
            child: Ink(
              padding: const EdgeInsets.fromLTRB(14, 14, 12, 14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(20),
                gradient: const LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    FieldCollectorColors.dashWelcomeTop,
                    FieldCollectorColors.dashWelcomeBottom,
                  ],
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                        color: Colors.white.withValues(alpha: 0.22),
                      ),
                    ),
                    child: Icon(icon, size: 28, color: accent),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    fmt.format(value),
                    maxLines: 1,
                    style: const TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w800,
                      height: 1,
                      letterSpacing: -0.3,
                      color: FieldCollectorColors.dashWelcomeOnAccent,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: FieldCollectorColors.dashWelcomeSubtitle,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }

    Widget row(List<Widget> tiles) => Row(
      children: [
        for (var i = 0; i < tiles.length; i++) ...[
          if (i > 0) const SizedBox(width: 10),
          Expanded(child: tiles[i]),
        ],
      ],
    );

    Widget legend(Color color, String text) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        dot(color),
        const SizedBox(width: 5),
        Text(
          text,
          style: const TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w600,
            color: FieldCollectorColors.onSurfaceVariant,
          ),
        ),
      ],
    );

    final paymentCard = Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: FieldCollectorColors.surface,
        borderRadius: BorderRadius.circular(20),
        boxShadow: softShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(14),
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [
                      FieldCollectorColors.statLunasBg,
                      Color.lerp(
                        FieldCollectorColors.statLunasBg,
                        FieldCollectorColors.statLunasIcon,
                        0.18,
                      )!,
                    ],
                  ),
                ),
                child: const Icon(
                  Icons.account_balance_wallet_rounded,
                  size: 24,
                  color: FieldCollectorColors.statLunasIcon,
                ),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Text(
                  'Status pembayaran',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: FieldCollectorColors.onSurfaceVariant,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 4,
                ),
                decoration: BoxDecoration(
                  color: FieldCollectorColors.statLunasBg,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '$paidPct% lunas',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    color: FieldCollectorColors.statLunasIcon,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                fmt.format(lunas),
                style: const TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w900,
                  height: 1,
                  letterSpacing: -0.6,
                  color: FieldCollectorColors.onSurface,
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  'dari ${fmt.format(billed)} pelanggan sudah bayar',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: FieldCollectorColors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: SizedBox(
              height: 10,
              width: double.infinity,
              child: billed == 0
                  ? const ColoredBox(
                      color: FieldCollectorColors.surfaceContainerHigh,
                    )
                  : Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (lunas > 0)
                          Expanded(
                            flex: lunas,
                            child: const ColoredBox(
                              color: FieldCollectorColors.statLunasIcon,
                            ),
                          ),
                        if (lunas > 0 && blm > 0) const SizedBox(width: 3),
                        if (blm > 0)
                          Expanded(
                            flex: blm,
                            child: const ColoredBox(
                              color: FieldCollectorColors.statBelumIcon,
                            ),
                          ),
                      ],
                    ),
            ),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 14,
            runSpacing: 4,
            children: [
              legend(
                FieldCollectorColors.statLunasIcon,
                'Lunas ${fmt.format(lunas)}',
              ),
              legend(
                FieldCollectorColors.statBelumIcon,
                'Belum lunas ${fmt.format(blm)}',
              ),
            ],
          ),
        ],
      ),
    );

    return Column(
      children: [
        paymentCard,
        const SizedBox(height: 10),
        row([
          statTile(
            icon: Icons.groups_2_rounded,
            accent: FieldCollectorColors.statOnBlueTotal,
            label: 'Total',
            value: total,
            filterStatus: 'total',
          ),
          statTile(
            icon: Icons.verified_rounded,
            accent: FieldCollectorColors.statOnBlueLunas,
            label: 'Lunas',
            value: lunas,
            filterStatus: 'paid',
          ),
          statTile(
            icon: Icons.pending_actions_rounded,
            accent: FieldCollectorColors.statOnBlueBelum,
            label: 'Belum lunas',
            value: blm,
            filterStatus: 'unpaid',
          ),
        ]),
        const SizedBox(height: 10),
        row([
          statTile(
            icon: Icons.person_add_alt_1_rounded,
            accent: FieldCollectorColors.statOnBlueBaru,
            label: 'Baru',
            value: baru,
            filterStatus: 'baru',
          ),
          statTile(
            icon: Icons.wifi_off_rounded,
            accent: FieldCollectorColors.statOnBlueIsolir,
            label: 'Isolir',
            value: isolir,
            filterStatus: 'isolir',
          ),
          statTile(
            icon: Icons.person_off_rounded,
            accent: FieldCollectorColors.statOnBlueNonaktif,
            label: 'Nonaktif',
            value: nonaktif,
            filterStatus: 'nonaktif',
          ),
        ]),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({
    required this.child,
    required this.gradient,
    this.borderRadius = 16,
    this.shadows,
  });

  final Widget child;
  final Gradient gradient;
  final double borderRadius;
  final List<BoxShadow>? shadows;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: gradient,
        borderRadius: BorderRadius.circular(borderRadius),
        boxShadow: shadows,
      ),
      child: child,
    );
  }
}
