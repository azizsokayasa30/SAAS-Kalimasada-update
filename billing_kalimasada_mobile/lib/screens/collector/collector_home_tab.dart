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
    final c = context.watch<CollectorProvider>();
    final data = c.overview;
    final field = data != null
        ? data['fieldUi'] as Map<String, dynamic>?
        : null;
    final collector = data != null
        ? data['collector'] as Map<String, dynamic>?
        : null;

    if (c.overviewLoading && field == null) {
      return ColoredBox(
        color: FieldCollectorColors.dashboardCanvas,
        child: const Center(
          child: CircularProgressIndicator(
            color: FieldCollectorColors.primaryContainer,
          ),
        ),
      );
    }
    if (c.overviewError != null && field == null) {
      return ColoredBox(
        color: FieldCollectorColors.dashboardCanvas,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(c.overviewError ?? '', textAlign: TextAlign.center),
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
            const SizedBox(height: 18),
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
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'TARGET TAGIHAN BULAN INI',
                                    style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.w700,
                                      letterSpacing: 0.85,
                                      color: FieldCollectorColors
                                          .primaryFixedDim
                                          .withValues(alpha: 0.9),
                                    ),
                                  ),
                                  const SizedBox(height: 6),
                                  Text(
                                    _rupiah(target),
                                    style: const TextStyle(
                                      fontSize: 24,
                                      fontWeight: FontWeight.w800,
                                      color: FieldCollectorColors.onPrimary,
                                      letterSpacing: -0.5,
                                    ),
                                  ),
                                ],
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
            const SizedBox(height: 14),
            _Card(
              color: FieldCollectorColors.dashPeriodTint,
              borderColor: FieldCollectorColors.dashPeriodBorder,
              borderRadius: 16,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Periode target',
                    style: Theme.of(context).textTheme.labelLarge?.copyWith(
                      color: FieldCollectorColors.onSurfaceVariant,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 10),
                  LayoutBuilder(
                    builder: (context, constraints) {
                      const controlH = 48.0;
                      final labelStyle = Theme.of(context).textTheme.labelMedium
                          ?.copyWith(
                            color: FieldCollectorColors.onSurfaceVariant,
                            fontWeight: FontWeight.w600,
                          );
                      final narrow = constraints.maxWidth < 340;
                      final yearMin = DateTime.now().year - 2;
                      final yearMax = DateTime.now().year + 1;
                      final yearItems = [
                        for (var y = yearMin; y <= yearMax; y++)
                          DropdownMenuItem<int>(value: y, child: Text('$y')),
                      ];

                      BoxDecoration fieldDeco() => BoxDecoration(
                        color: FieldCollectorColors.surface,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: FieldCollectorColors.outlineVariant,
                        ),
                      );

                      Widget dropdownBox({required Widget child}) {
                        return SizedBox(
                          height: controlH,
                          child: DecoratedBox(
                            decoration: fieldDeco(),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                              ),
                              child: DropdownButtonHideUnderline(
                                child: Align(
                                  alignment: Alignment.centerLeft,
                                  child: child,
                                ),
                              ),
                            ),
                          ),
                        );
                      }

                      final monthCtrl = dropdownBox(
                        child: DropdownButton<int>(
                          value: _month,
                          isExpanded: true,
                          isDense: true,
                          menuMaxHeight: 280,
                          icon: const Icon(Icons.arrow_drop_down, size: 22),
                          style: Theme.of(context).textTheme.bodyLarge,
                          items: [
                            const DropdownMenuItem<int>(
                              value: 0,
                              child: Text('Satu tahun'),
                            ),
                            for (var m = 1; m <= 12; m++)
                              DropdownMenuItem<int>(
                                value: m,
                                child: Text(_kMonthShortId[m - 1]),
                              ),
                          ],
                          onChanged: (v) {
                            if (v != null) setState(() => _month = v);
                          },
                        ),
                      );
                      final yearCtrl = dropdownBox(
                        child: DropdownButton<int>(
                          value: _year,
                          isExpanded: true,
                          isDense: true,
                          menuMaxHeight: 280,
                          icon: const Icon(Icons.arrow_drop_down, size: 22),
                          style: Theme.of(context).textTheme.bodyLarge,
                          items: yearItems,
                          onChanged: (v) {
                            if (v != null) setState(() => _year = v);
                          },
                        ),
                      );
                      final applyStyle = FilledButton.styleFrom(
                        backgroundColor:
                            FieldCollectorColors.periodApplyBackground,
                        foregroundColor:
                            FieldCollectorColors.periodApplyForeground,
                        elevation: 0,
                        shadowColor: Colors.transparent,
                        padding: const EdgeInsets.symmetric(horizontal: 14),
                        minimumSize: const Size(0, controlH),
                        maximumSize: const Size(double.infinity, controlH),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      );
                      final applyBtn = SizedBox(
                        height: controlH,
                        child: FilledButton(
                          style: applyStyle,
                          onPressed: () async {
                            await context
                                .read<CollectorProvider>()
                                .setPeriodAndRefresh(
                                  month: _month,
                                  year: _year,
                                );
                          },
                          child: const Text('Terapkan'),
                        ),
                      );

                      Widget labeledColumn(String label, Widget control) {
                        return Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(label, style: labelStyle),
                            const SizedBox(height: 6),
                            control,
                          ],
                        );
                      }

                      if (narrow) {
                        return Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            labeledColumn('Bulan', monthCtrl),
                            const SizedBox(height: 10),
                            labeledColumn('Tahun', yearCtrl),
                            const SizedBox(height: 10),
                            applyBtn,
                          ],
                        );
                      }
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                flex: 2,
                                child: Text('Bulan', style: labelStyle),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                flex: 2,
                                child: Text('Tahun', style: labelStyle),
                              ),
                              const SizedBox(width: 8),
                              SizedBox(
                                width: 102,
                                child: Text('\u00A0', style: labelStyle),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(flex: 2, child: monthCtrl),
                              const SizedBox(width: 8),
                              Expanded(flex: 2, child: yearCtrl),
                              const SizedBox(width: 8),
                              SizedBox(width: 102, child: applyBtn),
                            ],
                          ),
                        ],
                      );
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 6),
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Ringkasan',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                  color: FieldCollectorColors.onSurface,
                  letterSpacing: -0.2,
                ),
              ),
            ),
            const SizedBox(height: 10),
            _summaryGrid(
              context,
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

  Widget _summaryGrid(
    BuildContext context,
    int total,
    int baru,
    int blm,
    int lunas,
    int isolir,
    int nonaktif,
    void Function(String status)? onOpenCustomersList,
  ) {
    const statH = 56.0;
    const pad = EdgeInsets.symmetric(horizontal: 14, vertical: 12);

    Widget statTile({
      required Color bg,
      required Color iconBg,
      required Color iconFg,
      required Color valueColor,
      required IconData icon,
      required String label,
      required String value,
      required String filterStatus,
    }) {
      final card = _Card(
        color: bg,
        padding: pad,
        borderRadius: 16,
        borderColor: Colors.white.withValues(alpha: 0.65),
        shadows: const [
          BoxShadow(
            color: Color(0x12000000),
            blurRadius: 12,
            offset: Offset(0, 5),
          ),
        ],
        child: SizedBox(
          height: statH,
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: iconBg,
                  borderRadius: BorderRadius.circular(14),
                  boxShadow: [
                    BoxShadow(
                      color: iconBg.withValues(alpha: 0.35),
                      blurRadius: 8,
                      offset: const Offset(0, 3),
                    ),
                  ],
                ),
                child: Icon(icon, color: iconFg, size: 24),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 14,
                    height: 1.15,
                    color: FieldCollectorColors.onSurface.withValues(
                      alpha: 0.88,
                    ),
                  ),
                ),
              ),
              Text(
                value,
                style: TextStyle(
                  fontWeight: FontWeight.w900,
                  fontSize: 20,
                  height: 1,
                  color: valueColor,
                  letterSpacing: -0.4,
                ),
              ),
            ],
          ),
        ),
      );
      if (onOpenCustomersList == null) return card;
      return Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () {
            collectorDbg('Dashboard: tap "$label" → filter="$filterStatus"');
            onOpenCustomersList(filterStatus);
          },
          borderRadius: BorderRadius.circular(16),
          child: card,
        ),
      );
    }

    // Kiri: Total → Baru → Nonaktif | Kanan: Lunas → Belum lunas → Isolir
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            children: [
              statTile(
                bg: FieldCollectorColors.statTotalBg,
                iconBg: FieldCollectorColors.statTotalIcon,
                iconFg: Colors.white,
                valueColor: FieldCollectorColors.statTotalIcon,
                icon: Icons.groups_2_rounded,
                label: 'Total',
                value: '$total',
                filterStatus: 'total',
              ),
              const SizedBox(height: 10),
              statTile(
                bg: FieldCollectorColors.statBaruBg,
                iconBg: FieldCollectorColors.statBaruIcon,
                iconFg: Colors.white,
                valueColor: FieldCollectorColors.statBaruIcon,
                icon: Icons.person_add_alt_1_rounded,
                label: 'Baru',
                value: '$baru',
                filterStatus: 'baru',
              ),
              const SizedBox(height: 10),
              statTile(
                bg: FieldCollectorColors.statNonaktifBg,
                iconBg: FieldCollectorColors.statNonaktifIcon,
                iconFg: Colors.white,
                valueColor: FieldCollectorColors.statNonaktifIcon,
                icon: Icons.person_off_rounded,
                label: 'Nonaktif',
                value: '$nonaktif',
                filterStatus: 'nonaktif',
              ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            children: [
              statTile(
                bg: FieldCollectorColors.statLunasBg,
                iconBg: FieldCollectorColors.statLunasIcon,
                iconFg: Colors.white,
                valueColor: FieldCollectorColors.statLunasIcon,
                icon: Icons.verified_rounded,
                label: 'Lunas',
                value: '$lunas',
                filterStatus: 'paid',
              ),
              const SizedBox(height: 10),
              statTile(
                bg: FieldCollectorColors.statBelumBg,
                iconBg: FieldCollectorColors.statBelumIcon,
                iconFg: Colors.white,
                valueColor: FieldCollectorColors.statBelumIcon,
                icon: Icons.pending_actions_rounded,
                label: 'Belum lunas',
                value: '$blm',
                filterStatus: 'unpaid',
              ),
              const SizedBox(height: 10),
              statTile(
                bg: FieldCollectorColors.statIsolirBg,
                iconBg: FieldCollectorColors.statIsolirIcon,
                iconFg: Colors.white,
                valueColor: FieldCollectorColors.statIsolirIcon,
                icon: Icons.wifi_off_rounded,
                label: 'Isolir',
                value: '$isolir',
                filterStatus: 'isolir',
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({
    required this.child,
    this.color,
    this.padding,
    this.borderRadius = 16,
    this.borderColor,
    this.gradient,
    this.shadows,
  });

  final Widget child;
  final Color? color;
  final EdgeInsetsGeometry? padding;
  final double borderRadius;
  final Color? borderColor;
  final Gradient? gradient;
  final List<BoxShadow>? shadows;

  @override
  Widget build(BuildContext context) {
    final useGradient = gradient != null;
    final bg = useGradient ? null : (color ?? FieldCollectorColors.surface);
    final bool softSurface = !useGradient && color == null;
    final border = useGradient
        ? null
        : Border.all(
            color: borderColor ?? FieldCollectorColors.outlineVariant,
            width: borderColor != null ? 1.2 : 1,
          );

    return Container(
      width: double.infinity,
      padding: padding ?? const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: gradient,
        color: bg,
        borderRadius: BorderRadius.circular(borderRadius),
        border: border,
        boxShadow:
            shadows ??
            (softSurface
                ? const [
                    BoxShadow(
                      color: Color(0x12000000),
                      blurRadius: 12,
                      offset: Offset(0, 4),
                    ),
                  ]
                : null),
      ),
      child: child,
    );
  }
}
