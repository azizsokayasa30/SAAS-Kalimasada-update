import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../store/collector_provider.dart';
import '../../theme/collector_colors.dart';

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

/// Nominal yang dibayar pelanggan (tagihan baris − diskon pada baris pembayaran).
int _netPaidDisplay(Map<String, dynamic> p) {
  final gross = (_coerceNum(p['payment_amount']) ?? 0).round();
  final disc = (_coerceNum(p['discount_amount']) ?? 0).round();
  final net = gross - disc;
  return net < 0 ? 0 : net;
}

class CollectorSettlementTab extends StatefulWidget {
  const CollectorSettlementTab({super.key});

  @override
  State<CollectorSettlementTab> createState() => _CollectorSettlementTabState();
}

class _CollectorSettlementTabState extends State<CollectorSettlementTab> with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<CollectorProvider>().fetchSettlement();
    });
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final c = context.watch<CollectorProvider>();
    final data = c.settlement;
    final ui = data != null ? data['setoranUi'] as Map<String, dynamic>? : null;
    final payments = data != null ? List<dynamic>.from(data['payments'] as List? ?? []) : <dynamic>[];

    final total = (ui?['totalHarusSetor'] as num?)?.toInt() ?? 0;
    final sudah = (ui?['sudahSetor'] as num?)?.toInt() ?? 0;
    final belum = (ui?['belumSetor'] as num?)?.toInt() ?? 0;
    final pct = (ui?['setoranProgressPct'] as num?)?.toInt() ?? 0;

    if (c.settlementLoading && ui == null) {
      return const Center(child: CircularProgressIndicator(color: FieldCollectorColors.primaryContainer));
    }
    if (c.settlementError != null && ui == null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(c.settlementError ?? '', textAlign: TextAlign.center),
            TextButton(
              onPressed: () => context.read<CollectorProvider>().fetchSettlement(),
              child: const Text('Coba lagi'),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      color: FieldCollectorColors.primaryContainer,
      onRefresh: () => context.read<CollectorProvider>().fetchSettlement(),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: FieldCollectorColors.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: FieldCollectorColors.outlineVariant),
              boxShadow: const [BoxShadow(color: Color(0x0A000000), blurRadius: 12)],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'TOTAL HARUS DISETOR (NETO BULAN INI)',
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, letterSpacing: 0.5, color: FieldCollectorColors.onSurfaceVariant),
                ),
                const SizedBox(height: 6),
                Text(
                  _rupiah(total),
                  style: const TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w800,
                    color: FieldCollectorColors.primaryContainer,
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text(
                      'Progress setoran',
                      style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: FieldCollectorColors.onSurfaceVariant),
                    ),
                    Text(
                      '$pct%',
                      style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        color: FieldCollectorColors.onSecondaryContainer,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                ClipRRect(
                  borderRadius: BorderRadius.circular(99),
                  child: LinearProgressIndicator(
                    value: pct / 100,
                    minHeight: 8,
                    backgroundColor: const Color(0xFFE1E3E4),
                    // Sama seperti bar "Rasio lunas/tagihan" di tab Profil
                    color: const Color(0xFF66DF75),
                  ),
                ),
                const Divider(height: 28),
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Row(
                            children: [
                              Icon(Icons.arrow_downward, size: 14, color: FieldCollectorColors.onSecondaryContainer),
                              Text(' Sudah disetor', style: TextStyle(fontSize: 10, color: FieldCollectorColors.onSurfaceVariant)),
                            ],
                          ),
                          Text(_rupiah(sudah), style: const TextStyle(fontWeight: FontWeight.w700, color: FieldCollectorColors.onSecondaryContainer)),
                        ],
                      ),
                    ),
                    Container(width: 1, height: 36, color: const Color(0xFFE1E3E4)),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          const Row(
                            mainAxisAlignment: MainAxisAlignment.end,
                            children: [
                              Text('Sisa setoran ', style: TextStyle(fontSize: 10, color: FieldCollectorColors.onSurfaceVariant)),
                              Icon(Icons.priority_high, size: 14, color: Color(0xFFBA1A1A)),
                            ],
                          ),
                          Text(_rupiah(belum), style: const TextStyle(fontWeight: FontWeight.w700, color: Color(0xFFBA1A1A))),
                        ],
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          const Text('Riwayat pembayaran', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
          const SizedBox(height: 8),
          ...payments.map((raw) {
            if (raw is! Map) return const SizedBox.shrink();
            final p = Map<String, dynamic>.from(raw);
            final done = (p['status']?.toString() ?? '') == 'completed';
            final amt = _netPaidDisplay(p);
            final cust = p['customer_name']?.toString() ?? 'Pelanggan';
            final method = (p['payment_method']?.toString() ?? '').toLowerCase();
            final isTransfer = method.contains('transfer');
            final at = p['collected_at']?.toString();
            String when = '—';
            if (at != null) {
              try {
                final d = DateTime.parse(at);
                // Tanpa locale id_ID (perlu initializeDateFormatting) — cukup pola numerik.
                when = DateFormat('dd/MM/yyyy HH:mm').format(d);
              } catch (_) {}
            }
            return Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                leading: CircleAvatar(
                  backgroundColor: done ? FieldCollectorColors.secondaryContainer : const Color(0xFFE7E8E9),
                  child: Icon(done ? Icons.check : Icons.schedule, color: done ? FieldCollectorColors.onSecondaryContainer : FieldCollectorColors.onSurfaceVariant),
                ),
                title: Text(_rupiah(amt), style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text(
                  isTransfer ? '$cust · $when · Transfer ke kantor' : '$cust · $when',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: Text(
                  isTransfer ? 'Kantor' : (done ? 'Selesai' : 'Pending'),
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    color: isTransfer
                        ? FieldCollectorColors.primaryContainer
                        : (done ? FieldCollectorColors.onSecondaryContainer : FieldCollectorColors.onSurfaceVariant),
                  ),
                ),
              ),
            );
          }),
        ],
      ),
    );
  }
}
