import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../services/api_client.dart';

/// Riwayat pembayaran yang diterima Manager Area (31 hari terakhir).
class AreaManagerCollectHistoryScreen extends StatefulWidget {
  const AreaManagerCollectHistoryScreen({super.key});

  @override
  State<AreaManagerCollectHistoryScreen> createState() =>
      _AreaManagerCollectHistoryScreenState();
}

class _AreaManagerCollectHistoryScreenState
    extends State<AreaManagerCollectHistoryScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _bg = Color(0xFFF6F7FA);
  static const _textMuted = Color(0xFF64748B);

  final _money = NumberFormat.currency(
    locale: 'id_ID',
    symbol: 'Rp ',
    decimalDigits: 0,
  );

  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _items = [];
  Map<String, dynamic> _totals = const {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  num _num(dynamic v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final r = await ApiClient.get(
        '/api/mobile-adapter/area-manager/collect/history?days=31',
      );
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'area-manager/collect/history',
      );
      if (!mounted) return;
      if (r.statusCode == 200 && ApiClient.jsonSuccess(body['success'])) {
        final data = Map<String, dynamic>.from(body['data'] as Map);
        setState(() {
          _items = (data['items'] as List? ?? const [])
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _totals = data['totals'] is Map
              ? Map<String, dynamic>.from(data['totals'] as Map)
              : const {};
        });
      } else {
        setState(
          () => _error = body['message']?.toString() ?? 'Gagal memuat riwayat',
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Gagal memuat riwayat: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _methodLabel(String? m) {
    final s = (m ?? '').toLowerCase();
    if (s.contains('transfer')) return 'Transfer';
    if (s == 'cash' || s.isEmpty) return 'Tunai';
    return 'Lainnya';
  }

  String _timeLabel(String? local) {
    final d = DateTime.tryParse((local ?? '').replaceFirst(' ', 'T'));
    if (d == null) return local ?? '';
    return DateFormat('d MMM yyyy, HH:mm', 'id_ID').format(d);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _primary,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text(
          'Riwayat Penerimaan',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
        ),
      ),
      body: RefreshIndicator(
        color: _primary,
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: [
            Row(
              children: [
                Expanded(
                  child: _totalCard(
                    'Hari ini',
                    _num(_totals['today_amount']),
                    '${_num(_totals['today_count']).toInt()} pembayaran',
                    const Color(0xFF2563EB),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _totalCard(
                    '31 hari terakhir',
                    _num(_totals['amount']),
                    'Tunai ${_money.format(_num(_totals['cash_amount']))}',
                    const Color(0xFF059669),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            if (_loading && _items.isEmpty)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(
                  child: CircularProgressIndicator(color: _primary),
                ),
              )
            else if (_error != null)
              Padding(
                padding: const EdgeInsets.all(24),
                child: Text(_error!, textAlign: TextAlign.center),
              )
            else if (_items.isEmpty)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Text(
                  'Belum ada pembayaran yang Anda terima.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: _textMuted),
                ),
              )
            else
              for (final p in _items)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _paymentTile(p),
                ),
          ],
        ),
      ),
    );
  }

  Widget _totalCard(String title, num amount, String caption, Color color) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              color: Colors.white70,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              _money.format(amount),
              style: const TextStyle(
                color: Colors.white,
                fontSize: 18,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            caption,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: Colors.white, fontSize: 11),
          ),
        ],
      ),
    );
  }

  Widget _paymentTile(Map<String, dynamic> p) {
    final discount = _num(p['discount_amount']);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  p['customer_name']?.toString() ?? 'Pelanggan',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 14,
                  ),
                ),
                Text(
                  '${p['invoice_number'] ?? '-'} · ${_methodLabel(p['payment_method']?.toString())}',
                  style: const TextStyle(fontSize: 12, color: _textMuted),
                ),
                Text(
                  _timeLabel(p['payment_date_local']?.toString()),
                  style: const TextStyle(fontSize: 11, color: _textMuted),
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                _money.format(_num(p['amount'])),
                style: const TextStyle(
                  fontWeight: FontWeight.w900,
                  color: Color(0xFF059669),
                ),
              ),
              if (discount > 0)
                Text(
                  'Diskon ${_money.format(discount)}',
                  style: const TextStyle(fontSize: 11, color: _textMuted),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
