import 'dart:async';

import 'package:flutter/material.dart';

import '../services/api_client.dart';

/// Trafik PPPoE satu pelanggan: kecepatan saat ini + pemakaian selama sesi.
/// Hanya dipakai di layar detail pelanggan (bukan daftar) agar router tidak terbebani.
class PppoeTrafficCard extends StatefulWidget {
  const PppoeTrafficCard({
    super.key,
    required this.endpoint,
    this.framed = true,
  });

  /// Endpoint mobile-adapter, mis. `/api/mobile-adapter/customers/12/traffic`.
  final String endpoint;

  /// `false` bila kartu sudah dibungkus section card milik layar induk.
  final bool framed;

  @override
  State<PppoeTrafficCard> createState() => _PppoeTrafficCardState();
}

class _PppoeTrafficCardState extends State<PppoeTrafficCard> {
  static const _pollInterval = Duration(seconds: 3);
  static const _liveDuration = Duration(minutes: 2);

  static const _downloadColor = Color(0xFF2563EB);
  static const _uploadColor = Color(0xFFF97316);
  static const _textMain = Color(0xFF19163F);
  static const _textMuted = Color(0xFF474551);
  static const _outline = Color(0xFFC7D7FE);
  static const _surfaceTint = Color(0xFF2E9DEB);

  Timer? _timer;
  DateTime? _liveStartedAt;
  bool _loading = true;
  bool _fetching = false;
  String? _error;
  Map<String, dynamic>? _data;

  bool get _live => _timer != null;

  @override
  void initState() {
    super.initState();
    _startLive(rebuild: false);
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _startLive({bool rebuild = true}) {
    _timer?.cancel();
    _liveStartedAt = DateTime.now();
    _fetch();
    _timer = Timer.periodic(_pollInterval, (_) {
      final started = _liveStartedAt;
      if (started != null &&
          DateTime.now().difference(started) >= _liveDuration) {
        _stopLive();
        return;
      }
      _fetch();
    });
    if (rebuild && mounted) setState(() {});
  }

  void _stopLive() {
    _timer?.cancel();
    _timer = null;
    if (mounted) setState(() {});
  }

  Future<void> _fetch() async {
    if (_fetching) return;
    _fetching = true;
    try {
      final res = await ApiClient.get(widget.endpoint);
      final body = ApiClient.decodeJsonObject(res, debugLabel: 'traffic');
      if (!mounted) return;
      if (res.statusCode == 200 &&
          ApiClient.jsonSuccess(body['success']) &&
          body['data'] is Map) {
        final data = Map<String, dynamic>.from(body['data'] as Map);
        final online = data['online'] == true;
        setState(() {
          _data = data;
          _error = null;
          _loading = false;
        });
        if (!online) _stopLive();
      } else {
        setState(() {
          _loading = false;
          _error = body['message']?.toString() ?? 'Gagal memuat trafik';
        });
        _stopLive();
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Gagal memuat trafik';
      });
      _stopLive();
    } finally {
      _fetching = false;
    }
  }

  static double _num(dynamic v) {
    if (v is num) return v.toDouble();
    return double.tryParse(v?.toString() ?? '') ?? 0;
  }

  static String _formatRate(double bps) {
    if (bps >= 1e9) return '${(bps / 1e9).toStringAsFixed(2)} Gbps';
    if (bps >= 1e6) return '${(bps / 1e6).toStringAsFixed(2)} Mbps';
    if (bps >= 1e3) return '${(bps / 1e3).toStringAsFixed(0)} Kbps';
    return '${bps.toStringAsFixed(0)} bps';
  }

  static String _formatBytes(double b) {
    if (b >= 1e12) return '${(b / 1e12).toStringAsFixed(2)} TB';
    if (b >= 1e9) return '${(b / 1e9).toStringAsFixed(2)} GB';
    if (b >= 1e6) return '${(b / 1e6).toStringAsFixed(1)} MB';
    if (b >= 1e3) return '${(b / 1e3).toStringAsFixed(0)} KB';
    return '${b.toStringAsFixed(0)} B';
  }

  @override
  Widget build(BuildContext context) {
    final content = _buildContent();
    if (!widget.framed) return content;
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _outline),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.swap_vert, color: _surfaceTint),
              const SizedBox(width: 8),
              const Expanded(
                child: Text(
                  'Trafik PPPoE',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: _textMain,
                  ),
                ),
              ),
              _liveBadge(),
            ],
          ),
          const Divider(height: 16),
          content,
        ],
      ),
    );
  }

  Widget _liveBadge() {
    final online = _data?['online'] == true;
    if (!online) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: _live ? const Color(0xFFD3F5D6) : const Color(0xFFE7E8E9),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        _live ? 'LIVE' : 'JEDA',
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w800,
          color: _live ? const Color(0xFF0D5A16) : _textMuted,
        ),
      ),
    );
  }

  Widget _buildContent() {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 12),
        child: Center(
          child: SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    if (_error != null) {
      return _messageWithAction(_error!, 'Coba lagi', _startLive);
    }
    final data = _data ?? const {};
    if (data['online'] != true) {
      final login = data['login']?.toString() ?? '';
      return _messageWithAction(
        login.isEmpty
            ? 'Login PPPoE belum diatur.'
            : 'Tidak ada sesi PPPoE aktif ($login).',
        'Cek lagi',
        _startLive,
      );
    }

    final rate = data['rate'] is Map ? data['rate'] as Map : const {};
    final download = _num(data['download_bytes']);
    final upload = _num(data['upload_bytes']);
    final total = _num(data['total_bytes']);
    final avgDaily = _num(data['avg_daily_bytes']);
    final uptime = data['uptime']?.toString() ?? '-';
    final started = data['session_started_at']?.toString() ?? '';
    final router = data['router_name']?.toString() ?? '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'TRAFIK BERJALAN',
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.bold,
            color: _textMuted,
            letterSpacing: 1.1,
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: _rateTile(
                Icons.arrow_downward,
                'Download',
                _formatRate(_num(rate['download_bps'])),
                _downloadColor,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _rateTile(
                Icons.arrow_upward,
                'Upload',
                _formatRate(_num(rate['upload_bps'])),
                _uploadColor,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        const Text(
          'TERPAKAI SELAMA SESI',
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.bold,
            color: _textMuted,
            letterSpacing: 1.1,
          ),
        ),
        const SizedBox(height: 6),
        _usageRow('Download', _formatBytes(download), _downloadColor),
        _usageRow('Upload', _formatBytes(upload), _uploadColor),
        _usageRow('Total', _formatBytes(total), _textMain, bold: true),
        _usageRow('Rata-rata per hari', _formatBytes(avgDaily), _textMain),
        const Divider(height: 16),
        _usageRow('Uptime sesi', uptime, const Color(0xFF16A34A)),
        if (started.isNotEmpty) _usageRow('Sesi dimulai', started, _textMain),
        if (router.isNotEmpty) _usageRow('Router / NAS', router, _textMain),
        if (!_live)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: _startLive,
                icon: const Icon(Icons.play_arrow, size: 18),
                label: const Text('Lanjutkan live'),
              ),
            ),
          ),
      ],
    );
  }

  Widget _rateTile(IconData icon, String label, String value, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: const TextStyle(fontSize: 11, color: _textMuted),
                ),
                Text(
                  value,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: color,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _usageRow(
    String label,
    String value,
    Color color, {
    bool bold = false,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: const TextStyle(fontSize: 13, color: _textMuted),
            ),
          ),
          Text(
            value,
            style: TextStyle(
              fontSize: 13,
              fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
              color: color,
            ),
          ),
        ],
      ),
    );
  }

  Widget _messageWithAction(String message, String action, VoidCallback onTap) {
    return Row(
      children: [
        Expanded(
          child: Text(
            message,
            style: const TextStyle(
              fontSize: 13,
              color: _textMuted,
              height: 1.35,
            ),
          ),
        ),
        TextButton(onPressed: onTap, child: Text(action)),
      ],
    );
  }
}
