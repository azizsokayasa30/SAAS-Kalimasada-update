import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../services/api_client.dart';

class NetworkStatusScreen extends StatefulWidget {
  const NetworkStatusScreen({super.key});

  @override
  State<NetworkStatusScreen> createState() => _NetworkStatusScreenState();
}

class _NetworkStatusScreenState extends State<NetworkStatusScreen>
    with WidgetsBindingObserver, SingleTickerProviderStateMixin {
  static const Color _primary = Color(0xFF15803D);
  static const Color _surface = Color(0xFFF8F9FF);
  static const Color _outline = Color(0xFFCBC3D5);
  static const Color _text = Color(0xFF0B1C30);
  static const Color _subtleText = Color(0xFF494453);
  static const _trafficInterface = 'sfp-sfpplus1';

  Timer? _timer;
  late final AnimationController _blinkController;
  bool _pollingActive = false;
  bool _requestInFlight = false;
  bool _loading = true;
  bool _refreshing = false;
  String? _error;
  int _active = 0;
  int _offline = 0;
  int _total = 0;
  DateTime? _lastUpdatedAt;
  Map<String, dynamic>? _interfaceTraffic;
  List<Map<String, dynamic>> _routers = [];
  final Map<String, List<_TrafficPoint>> _trafficHistory = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _blinkController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 850),
      lowerBound: 0.35,
      upperBound: 1,
    )..repeat(reverse: true);
    _fetchNetworkStatus();
    _startPolling();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _stopPolling();
    _blinkController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _startPolling();
      _fetchNetworkStatus(silent: true);
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      _stopPolling();
    }
  }

  void _startPolling() {
    _timer?.cancel();
    _pollingActive = true;
    _timer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _fetchNetworkStatus(silent: true),
    );
  }

  void _stopPolling() {
    _timer?.cancel();
    _timer = null;
    _pollingActive = false;
  }

  int _toInt(dynamic value) {
    if (value is num) return value.toInt();
    return int.tryParse('${value ?? ''}') ?? 0;
  }

  num _numAt(Map<String, dynamic>? map, String key) {
    final value = map?[key];
    if (value is num) return value;
    return num.tryParse('${value ?? ''}') ?? 0;
  }

  ({double rx, double tx}) _trafficFromMainInterface() {
    final rxBits = _numAt(_interfaceTraffic, 'rx');
    final txBits = _numAt(_interfaceTraffic, 'tx');
    if (rxBits <= 0 && txBits <= 0) return (rx: 0, tx: 0);
    return (rx: rxBits / 1000000, tx: txBits / 1000000);
  }

  ({double rx, double tx}) _trafficFromRouter(Map<String, dynamic> router) {
    final rx = router['rx_mbps'] is num
        ? (router['rx_mbps'] as num).toDouble()
        : double.tryParse('${router['rx_mbps'] ?? ''}') ?? 0;
    final tx = router['tx_mbps'] is num
        ? (router['tx_mbps'] as num).toDouble()
        : double.tryParse('${router['tx_mbps'] ?? ''}') ?? 0;
    return (rx: rx, tx: tx);
  }

  ({double rx, double tx}) _trafficForRouter(
    Map<String, dynamic> router, {
    required bool useMainInterface,
  }) {
    final interfaceTraffic = _trafficFromMainInterface();
    if (useMainInterface &&
        (interfaceTraffic.rx > 0 || interfaceTraffic.tx > 0)) {
      return interfaceTraffic;
    }
    return _trafficFromRouter(router);
  }

  Future<Map<String, dynamic>?> _fetchMainInterfaceTraffic() async {
    try {
      final response = await ApiClient.get(
        '/api/dashboard/traffic?interface=$_trafficInterface',
      );
      if (response.statusCode != 200) return null;
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'dashboard/traffic',
      );
      return ApiClient.jsonSuccess(body['success']) ? body : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> _fetchNetworkStatus({bool silent = false}) async {
    if (_requestInFlight) return;
    _requestInFlight = true;
    if (!silent && mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    } else if (silent && mounted) {
      setState(() => _refreshing = true);
    }
    try {
      final response = await ApiClient.get(
        '/api/mobile-adapter/network-status',
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['success'] == true) {
          final interfaceTraffic = await _fetchMainInterfaceTraffic();
          final summary = (data['summary'] is Map)
              ? Map<String, dynamic>.from(data['summary'] as Map)
              : <String, dynamic>{};
          final routersRaw = data['routers'];
          final routers = (routersRaw is List)
              ? routersRaw
                    .whereType<Map>()
                    .map((e) => Map<String, dynamic>.from(e))
                    .toList()
              : <Map<String, dynamic>>[];
          if (!mounted) return;
          if (interfaceTraffic != null) _interfaceTraffic = interfaceTraffic;
          for (var i = 0; i < routers.length; i++) {
            final r = routers[i];
            final rid = '${r['id'] ?? r['name'] ?? 'router'}';
            final traffic = _trafficForRouter(r, useMainInterface: i == 0);
            final list = _trafficHistory.putIfAbsent(
              rid,
              () => <_TrafficPoint>[],
            );
            list.add(
              _TrafficPoint(rx: traffic.rx, tx: traffic.tx, at: DateTime.now()),
            );
            if (list.length > 36) {
              list.removeRange(0, list.length - 36);
            }
          }
          setState(() {
            _active = _toInt(summary['active']);
            _offline = _toInt(summary['offline']);
            _total = _toInt(summary['total']);
            _routers = routers;
            if (interfaceTraffic != null) _interfaceTraffic = interfaceTraffic;
            _lastUpdatedAt = DateTime.now();
            _error = null;
          });
        } else {
          if (!mounted) return;
          setState(() {
            _error =
                data['message']?.toString() ?? 'Gagal memuat status jaringan';
          });
        }
      } else {
        if (!mounted) return;
        setState(() => _error = 'Server ${response.statusCode}');
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Gagal memuat status jaringan: $e');
    } finally {
      _requestInFlight = false;
      if (mounted) {
        setState(() {
          _loading = false;
          _refreshing = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _surface,
      appBar: AppBar(
        backgroundColor: const Color(0xFF2563EB),
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text(
          'Server Mikrotik',
          style: TextStyle(
            color: Colors.white,
            fontSize: 22,
            fontWeight: FontWeight.w700,
          ),
        ),
        actions: [
          IconButton(
            icon: _refreshing
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.settings, color: Colors.white),
            onPressed: _loading ? null : () => _fetchNetworkStatus(),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(color: Colors.white24, height: 1),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: _loading
            ? const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(
                  child: CircularProgressIndicator(color: _primary),
                ),
              )
            : _error != null
            ? _errorCard(_error!)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 6,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(99),
                          border: Border.all(color: _outline),
                        ),
                        child: Row(
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: _pollingActive
                                    ? const Color(0xFF10B981)
                                    : const Color(0xFFBA1A1A),
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              _pollingActive ? 'LIVE (5s)' : 'PAUSED',
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                color: _pollingActive
                                    ? const Color(0xFF137333)
                                    : const Color(0xFF8A1212),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 6,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(99),
                          border: Border.all(color: _outline),
                        ),
                        child: Text(
                          _lastUpdatedAt == null
                              ? 'Belum ada update'
                              : 'Update: ${_fmtTime(_lastUpdatedAt!)}',
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: _subtleText,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  _bentoSummary(),
                  const SizedBox(height: 16),
                  const Text(
                    'Daftar NAS / Router',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      color: _text,
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (_routers.isEmpty) _emptyCard(),
                  ..._routers.map(_routerCard),
                  const SizedBox(height: 24),
                ],
              ),
      ),
    );
  }

  String _fmtTime(DateTime dt) {
    final hh = dt.hour.toString().padLeft(2, '0');
    final mm = dt.minute.toString().padLeft(2, '0');
    final ss = dt.second.toString().padLeft(2, '0');
    return '$hh:$mm:$ss';
  }

  Widget _bentoSummary() {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: const Color(0xFFEFF4FF),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: _outline),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Global PPPoE',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: _subtleText,
                      ),
                    ),
                    SizedBox(height: 4),
                    const Text(
                      'Status Semua Router',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                        color: _primary,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Total user PPPoE: $_total',
                      style: const TextStyle(
                        fontSize: 12,
                        color: _subtleText,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(99),
                  border: Border.all(color: _outline),
                ),
                child: const Row(
                  children: [
                    Icon(Icons.speed, size: 16, color: Color(0xFF683D00)),
                    SizedBox(width: 6),
                    Text(
                      'Live',
                      style: TextStyle(
                        color: Color(0xFF683D00),
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: _miniCard(
                label: 'Aktif',
                value: '$_active',
                valueColor: _primary,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _miniCard(
                label: 'Nonaktif',
                value: '$_offline',
                valueColor: const Color(0xFFBA1A1A),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _miniCard({
    required String label,
    required String value,
    required Color valueColor,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFE5EEFF),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _outline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: _subtleText,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            style: TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w800,
              color: valueColor,
            ),
          ),
        ],
      ),
    );
  }

  Widget _routerCard(Map<String, dynamic> router) {
    final name = (router['name']?.toString().trim().isNotEmpty == true)
        ? router['name'].toString()
        : 'Router Mikrotik';
    final id = router['id']?.toString() ?? '-';
    final active = _toInt(router['active']);
    final offline = _toInt(router['offline']);
    final total = _toInt(router['total']);
    final status = (router['status'] ?? '').toString().toLowerCase();
    final isOnline = status == 'online';
    final routerIndex = _routers.indexOf(router);
    final traffic = _trafficForRouter(
      router,
      useMainInterface: routerIndex <= 0,
    );
    final rxMbps = traffic.rx;
    final txMbps = traffic.tx;
    final dotColor = isOnline
        ? const Color(0xFF10B981)
        : const Color(0xFFBA1A1A);
    final statusLabel = isOnline ? 'ONLINE' : 'OFFLINE';
    final samples = _trafficHistory[id] ?? const <_TrafficPoint>[];

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: isOnline
              ? _outline
              : const Color(0xFFBA1A1A).withValues(alpha: 0.25),
        ),
      ),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                        color: _text,
                      ),
                    ),
                    Text(
                      'ID: $id',
                      style: const TextStyle(fontSize: 12, color: _subtleText),
                    ),
                  ],
                ),
              ),
              FadeTransition(
                opacity: _blinkController,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      statusLabel,
                      style: TextStyle(
                        color: dotColor,
                        fontSize: 11,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 0.4,
                      ),
                    ),
                    const SizedBox(width: 7),
                    Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: dotColor,
                        boxShadow: [
                          BoxShadow(
                            color: dotColor.withValues(alpha: 0.55),
                            blurRadius: 8,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: Row(
                  children: [
                    const Icon(Icons.lan, size: 18, color: _primary),
                    const SizedBox(width: 6),
                    Text(
                      'Aktif: $active',
                      style: const TextStyle(
                        color: _primary,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Row(
                  children: [
                    const Icon(
                      Icons.wifi_off,
                      size: 18,
                      color: Color(0xFFBA1A1A),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'Nonaktif: $offline',
                      style: const TextStyle(
                        color: Color(0xFFBA1A1A),
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
              Text(
                'Total: $total',
                style: const TextStyle(
                  color: _subtleText,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: Row(
                  children: [
                    const Icon(
                      Icons.download_rounded,
                      size: 16,
                      color: _primary,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      '${rxMbps.toStringAsFixed(2)} Mbps',
                      style: const TextStyle(
                        color: _primary,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    const Icon(
                      Icons.upload_rounded,
                      size: 16,
                      color: _subtleText,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      '${txMbps.toStringAsFixed(2)} Mbps',
                      style: const TextStyle(
                        color: _subtleText,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Container(
              height: 72,
              color: const Color(0xFFDCE9FF),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
              child: _MrtgMiniChart(samples: samples),
            ),
          ),
        ],
      ),
    );
  }

  Widget _errorCard(String message) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFFE9E9),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFFFCACA)),
      ),
      child: Text(
        message,
        style: const TextStyle(
          color: Color(0xFF8A1212),
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }

  Widget _emptyCard() {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _outline),
      ),
      child: const Text(
        'Belum ada router Mikrotik aktif yang terbaca di backend.',
        style: TextStyle(color: _subtleText, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _TrafficPoint {
  const _TrafficPoint({required this.rx, required this.tx, required this.at});
  final double rx;
  final double tx;
  final DateTime at;
}

class _MrtgMiniChart extends StatelessWidget {
  const _MrtgMiniChart({required this.samples});
  final List<_TrafficPoint> samples;

  @override
  Widget build(BuildContext context) {
    if (samples.length < 2) {
      return const Center(
        child: Text(
          'Menunggu data trafik...',
          style: TextStyle(fontSize: 11, color: Color(0xFF494453)),
        ),
      );
    }
    return CustomPaint(
      painter: _MrtgMiniChartPainter(samples: samples),
      child: const SizedBox.expand(),
    );
  }
}

class _MrtgMiniChartPainter extends CustomPainter {
  _MrtgMiniChartPainter({required this.samples});
  final List<_TrafficPoint> samples;

  @override
  void paint(Canvas canvas, Size size) {
    final maxVal = samples.fold<double>(
      1,
      (m, s) => [m, s.rx, s.tx].reduce((a, b) => a > b ? a : b),
    );

    final grid = Paint()
      ..color = const Color(0xFFB9C9E6)
      ..strokeWidth = 1;
    for (var i = 1; i <= 3; i++) {
      final y = size.height * i / 4;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }

    Offset pointAt(int i, double v) {
      final x = size.width * i / (samples.length - 1);
      final y = size.height - ((v / maxVal) * (size.height - 2));
      return Offset(x, y.clamp(1, size.height - 1));
    }

    final rxPath = Path();
    final txPath = Path();
    for (var i = 0; i < samples.length; i++) {
      final rp = pointAt(i, samples[i].rx);
      final tp = pointAt(i, samples[i].tx);
      if (i == 0) {
        rxPath.moveTo(rp.dx, rp.dy);
        txPath.moveTo(tp.dx, tp.dy);
      } else {
        rxPath.lineTo(rp.dx, rp.dy);
        txPath.lineTo(tp.dx, tp.dy);
      }
    }

    final rxPaint = Paint()
      ..color = const Color(0xFF2F855A)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final txPaint = Paint()
      ..color = const Color(0xFF2B6CB0)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;

    canvas.drawPath(rxPath, rxPaint);
    canvas.drawPath(txPath, txPaint);
  }

  @override
  bool shouldRepaint(covariant _MrtgMiniChartPainter oldDelegate) =>
      oldDelegate.samples != samples;
}
