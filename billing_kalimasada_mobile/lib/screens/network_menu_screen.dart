import 'package:flutter/material.dart';

import '../services/api_client.dart';
import 'network_map_screen.dart';
import 'network_status_screen.dart';

class NetworkMenuScreen extends StatefulWidget {
  const NetworkMenuScreen({super.key});

  @override
  State<NetworkMenuScreen> createState() => _NetworkMenuScreenState();
}

class _NetworkMenuScreenState extends State<NetworkMenuScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _primaryDark = Color(0xFF1D4ED8);
  static const _bg = Color(0xFFF6F7FA);
  static const _text = Color(0xFF0F172A);
  static const _subtle = Color(0xFF64748B);

  bool _loading = true;
  int _routerOnline = 0;
  int _routerTotal = 0;
  int _oltOnline = 0;
  int _oltTotal = 0;

  @override
  void initState() {
    super.initState();
    _loadSummary();
  }

  int _toInt(dynamic value) {
    if (value is num) return value.toInt();
    return int.tryParse('${value ?? ''}') ?? 0;
  }

  Future<void> _loadSummary() async {
    setState(() => _loading = true);
    try {
      final response = await ApiClient.get(
        '/api/mobile-adapter/network-status',
      );
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'network-status',
      );
      final summary = body['summary'] is Map
          ? Map<String, dynamic>.from(body['summary'] as Map)
          : <String, dynamic>{};
      final routers = body['routers'] is List
          ? List<dynamic>.from(body['routers'] as List)
          : const <dynamic>[];
      final olts = body['olts'] is List
          ? List<dynamic>.from(body['olts'] as List)
          : const <dynamic>[];

      if (!mounted) return;
      setState(() {
        _routerOnline = routers.isNotEmpty
            ? routers.where(_isOnlineRow).length
            : _toInt(summary['active']);
        _routerTotal = routers.isNotEmpty
            ? routers.length
            : _toInt(summary['total']);
        _oltOnline = olts.where(_isOnlineRow).length;
        _oltTotal = olts.length;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _routerOnline = 0;
        _routerTotal = 0;
        _oltOnline = 0;
        _oltTotal = 0;
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  bool _isOnlineRow(dynamic row) {
    if (row is! Map) return false;
    final value = row['status'] ?? row['state'] ?? row['online'];
    if (value == true || value == 1) return true;
    final text = value?.toString().trim().toLowerCase();
    return text == 'online' || text == 'up' || text == 'active';
  }

  void _open(Widget screen) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      body: RefreshIndicator(
        color: _primary,
        onRefresh: _loadSummary,
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            Container(
              padding: EdgeInsets.fromLTRB(
                18,
                MediaQuery.paddingOf(context).top + 18,
                18,
                24,
              ),
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [_primary, _primaryDark],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
              ),
              child: const Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Jaringan',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 26,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  SizedBox(height: 6),
                  Text(
                    'Pilih modul monitoring jaringan',
                    style: TextStyle(
                      color: Colors.white70,
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
            if (_loading)
              const LinearProgressIndicator(
                color: _primary,
                backgroundColor: Color(0xFFEAF2FF),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 110),
              child: Column(
                children: [
                  _NetworkMenuCard(
                    title: 'Server Mikrotik',
                    subtitle: 'Daftar NAS, PPPoE, trafik, dan status router',
                    icon: Icons.router_rounded,
                    color: const Color(0xFF6C5CE7),
                    statusLabel: _routerTotal == 0
                        ? 'Menunggu data'
                        : 'Online $_routerOnline/$_routerTotal',
                    onTap: () => _open(const NetworkStatusScreen()),
                  ),
                  const SizedBox(height: 14),
                  _NetworkMenuCard(
                    title: 'OLT',
                    subtitle: 'Monitoring card OLT dan status uplink/PON',
                    icon: Icons.settings_input_component_rounded,
                    color: const Color(0xFF0EA5E9),
                    statusLabel: _oltTotal == 0
                        ? 'Belum ada data'
                        : 'Online $_oltOnline/$_oltTotal',
                    onTap: () => _open(const NetworkOltScreen()),
                  ),
                  const SizedBox(height: 14),
                  _NetworkMenuCard(
                    title: 'Mapping',
                    subtitle: 'Mapview ODP, pelanggan, kabel, dan backbone',
                    icon: Icons.map_rounded,
                    color: const Color(0xFF10B981),
                    statusLabel: 'Mapview',
                    onTap: () => _open(const NetworkMapScreen()),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class NetworkOltScreen extends StatefulWidget {
  const NetworkOltScreen({super.key});

  @override
  State<NetworkOltScreen> createState() => _NetworkOltScreenState();
}

class _NetworkOltScreenState extends State<NetworkOltScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _bg = Color(0xFFF6F7FA);
  static const _text = Color(0xFF0F172A);
  static const _subtle = Color(0xFF64748B);

  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _olts = [];

  @override
  void initState() {
    super.initState();
    _loadOlts();
  }

  int _toInt(dynamic value) {
    if (value is num) return value.toInt();
    return int.tryParse('${value ?? ''}') ?? 0;
  }

  Future<void> _loadOlts() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get(
        '/api/mobile-adapter/network-status',
      );
      final body = ApiClient.decodeJsonObject(
        response,
        debugLabel: 'network-status',
      );
      final raw = body['olts'];
      final olts = raw is List
          ? raw
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() => _olts = olts);
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'Status OLT belum tersedia dari backend.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  bool _isOnline(Map<String, dynamic> olt) {
    final value = olt['status'] ?? olt['state'] ?? olt['online'];
    if (value == true || value == 1) return true;
    final text = value?.toString().trim().toLowerCase();
    return text == 'online' || text == 'up' || text == 'active';
  }

  String _label(Map<String, dynamic> olt, List<String> keys, String fallback) {
    for (final key in keys) {
      final value = olt[key]?.toString().trim();
      if (value != null && value.isNotEmpty) return value;
    }
    return fallback;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _primary,
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: const Text('OLT', style: TextStyle(fontWeight: FontWeight.w800)),
        actions: [
          IconButton(
            tooltip: 'Muat ulang',
            onPressed: _loading ? null : _loadOlts,
            icon: _loading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: RefreshIndicator(
        color: _primary,
        onRefresh: _loadOlts,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
          children: [
            if (_error != null) _InfoCard(message: _error!),
            if (_error != null) const SizedBox(height: 12),
            if (_loading && _olts.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(
                  child: CircularProgressIndicator(color: _primary),
                ),
              )
            else if (_olts.isEmpty)
              const _InfoCard(
                message:
                    'Belum ada data OLT yang dikirim backend. Data akan tampil otomatis jika payload network-status berisi daftar olts.',
              )
            else
              ..._olts.map(_oltCard),
          ],
        ),
      ),
    );
  }

  Widget _oltCard(Map<String, dynamic> olt) {
    final name = _label(olt, const ['name', 'label', 'hostname'], 'OLT');
    final host = _label(olt, const ['host', 'ip', 'ip_address'], '-');
    final model = _label(olt, const ['model', 'type', 'vendor'], 'OLT');
    final ponOnline = _toInt(olt['pon_online'] ?? olt['online_ports']);
    final ponTotal = _toInt(olt['pon_total'] ?? olt['total_ports']);
    final onuOnline = _toInt(olt['onu_online'] ?? olt['active_onu']);
    final onuTotal = _toInt(olt['onu_total'] ?? olt['total_onu']);
    final online = _isOnline(olt);
    final statusColor = online
        ? const Color(0xFF10B981)
        : const Color(0xFFDC2626);

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: online ? const Color(0xFFE2E8F0) : const Color(0xFFFCA5A5),
        ),
        boxShadow: const [
          BoxShadow(
            color: Color(0x140F172A),
            blurRadius: 18,
            offset: Offset(0, 8),
            spreadRadius: -10,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: const Color(0xFFEAF2FF),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: const Icon(
                  Icons.settings_input_component_rounded,
                  color: _primary,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      style: const TextStyle(
                        color: _text,
                        fontSize: 17,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '$model - $host',
                      style: const TextStyle(
                        color: _subtle,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
              _StatusPill(
                label: online ? 'ONLINE' : 'OFFLINE',
                color: statusColor,
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: _OltStat(
                  label: 'PON Aktif',
                  value: ponTotal == 0 ? '-' : '$ponOnline/$ponTotal',
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _OltStat(
                  label: 'ONU Aktif',
                  value: onuTotal == 0 ? '-' : '$onuOnline/$onuTotal',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _NetworkMenuCard extends StatelessWidget {
  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  final String statusLabel;
  final VoidCallback onTap;

  const _NetworkMenuCard({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
    required this.statusLabel,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(22),
      child: InkWell(
        borderRadius: BorderRadius.circular(22),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(22),
            border: Border.all(color: const Color(0xFFE2E8F0)),
            boxShadow: const [
              BoxShadow(
                color: Color(0x140F172A),
                blurRadius: 22,
                offset: Offset(0, 10),
                spreadRadius: -12,
              ),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 58,
                height: 58,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Icon(icon, color: color, size: 30),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            title,
                            style: const TextStyle(
                              color: _NetworkMenuScreenState._text,
                              fontSize: 18,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                        ),
                        _StatusPill(label: statusLabel, color: color),
                      ],
                    ),
                    const SizedBox(height: 5),
                    Text(
                      subtitle,
                      style: const TextStyle(
                        color: _NetworkMenuScreenState._subtle,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        height: 1.35,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(Icons.chevron_right_rounded, color: color, size: 28),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 10,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }
}

class _OltStat extends StatelessWidget {
  final String label;
  final String value;

  const _OltStat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(
              color: _NetworkOltScreenState._subtle,
              fontSize: 11,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            value,
            style: const TextStyle(
              color: _NetworkOltScreenState._text,
              fontSize: 18,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  final String message;

  const _InfoCard({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Text(
        message,
        style: const TextStyle(
          color: _NetworkOltScreenState._subtle,
          fontWeight: FontWeight.w700,
          height: 1.35,
        ),
      ),
    );
  }
}
