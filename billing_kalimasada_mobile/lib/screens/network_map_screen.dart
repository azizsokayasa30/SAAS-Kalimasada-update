import 'dart:convert';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import '../services/api_client.dart';
import 'odp_detail_screen.dart';
import '../widgets/odp_map_marker.dart';
import 'tag_customer_location_screen.dart';
import 'tag_location_screen.dart';

class NetworkMapScreen extends StatefulWidget {
  const NetworkMapScreen({super.key});

  @override
  State<NetworkMapScreen> createState() => _NetworkMapScreenState();
}

class _NetworkMapScreenState extends State<NetworkMapScreen>
    with SingleTickerProviderStateMixin {
  final MapController _mapController = MapController();
  final LatLng _defaultCenter = const LatLng(-7.404620, 109.724536);
  double _currentZoom = 15.0;
  bool _isMapReady = false;
  LatLng? _currentGpsLocation;
  bool _isLocating = false;

  List<dynamic> _odps = [];
  List<dynamic> _customers = [];
  List<dynamic> _cableRoutes = [];
  List<dynamic> _backbone = [];
  bool _isLoading = true;

  /// Kartu ringkas pelanggan di atas peta (bukan modal).
  Map<String, dynamic>? _selectedMapCustomer;
  late final AnimationController _flowController;

  static const _customerFlowColor = Color(0xFF00E676);
  static const _backboneFlowColor = Color(0xFF40C4FF);
  static const _maxFlowDots = 36;

  /// Filter tampilan marker di peta (semua aktif default).
  bool _showCustomerActive = true;
  bool _showCustomerInactive = true;
  bool _showOdpActive = true;
  bool _showOdpInactive = true;
  bool _showOdpMaintenance = true;
  bool _filterPanelOpen = false;

  static const _customerOfflineColor = Color(0xFFDC3545);

  /// Cache layer — di-rebuild hanya saat data/filter berubah (bukan tiap frame animasi).
  final Map<String, Map> _customerById = {};
  List<Marker> _cachedCustomerMarkers = const [];
  List<Marker> _cachedOdpMarkers = const [];
  List<Polyline> _cachedCablePolylines = const [];
  List<Polyline> _cachedBackbonePolylines = const [];
  List<List<LatLng>> _cachedCableSegments = const [];
  List<List<LatLng>> _cachedBackboneSegments = const [];
  bool _flowAnimEnabled = true;

  @override
  void initState() {
    super.initState();
    _flowController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 3200),
    );
    _fetchNetworkMap();
  }

  @override
  void dispose() {
    _flowController.dispose();
    super.dispose();
  }

  Future<void> _fetchNetworkMap() async {
    setState(() => _isLoading = true);
    try {
      final response = await ApiClient.get('/api/mobile-adapter/network-map');
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (ApiClient.jsonSuccess(data['success'])) {
        final payload = Map<String, dynamic>.from(data['data'] ?? {});
        _odps = List<dynamic>.from(payload['odps'] ?? const []);
        _customers = List<dynamic>.from(payload['customers'] ?? const []);
        _cableRoutes = List<dynamic>.from(payload['cableRoutes'] ?? const []);
        _backbone = List<dynamic>.from(payload['backbone'] ?? const []);
        _selectedMapCustomer = null;
        _rebuildMapCaches();
      }
    } catch (e) {
      print('Error fetching network map: $e');
    } finally {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  void _syncFlowAnimation() {
    final heavy =
        _customers.length + _odps.length + _cableRoutes.length > 140;
    _flowAnimEnabled = !heavy;
    if (_flowAnimEnabled) {
      if (!_flowController.isAnimating) {
        _flowController.repeat();
      }
    } else if (_flowController.isAnimating) {
      _flowController.stop();
      _flowController.value = 0;
    }
  }

  void _rebuildMapCaches() {
    _customerById
      ..clear()
      ..addEntries(
        _customers.whereType<Map>().where((c) => c['id'] != null).map(
              (c) => MapEntry(c['id'].toString(), c),
            ),
      );

    _cachedBackboneSegments = _buildBackboneSegments();
    _cachedBackbonePolylines = _cachedBackboneSegments
        .map(
          (points) => Polyline(
            points: points,
            color: const Color(0xFFFFD400),
            strokeWidth: 3.5,
          ),
        )
        .toList(growable: false);

    final visibleCables = _cableRoutes
        .whereType<Map>()
        .where(_isCableRouteVisible)
        .toList(growable: false);

    final cablePolylines = <Polyline>[];
    final cableSegments = <List<LatLng>>[];
    for (final row in visibleCables) {
      final fromLat = (row['customer_lat'] as num?)?.toDouble();
      final fromLng = (row['customer_lng'] as num?)?.toDouble();
      final toLat = (row['odp_lat'] as num?)?.toDouble();
      final toLng = (row['odp_lng'] as num?)?.toDouble();
      if (fromLat == null ||
          fromLng == null ||
          toLat == null ||
          toLng == null) {
        continue;
      }
      final points = [LatLng(fromLat, fromLng), LatLng(toLat, toLng)];
      final online = _isCableOnlineOnMap(row);
      cablePolylines.add(
        Polyline(
          points: points,
          color: online ? const Color(0xFF28A745) : const Color(0xFFDC3545),
          strokeWidth: 2.5,
        ),
      );
      cableSegments.add([LatLng(toLat, toLng), LatLng(fromLat, fromLng)]);
    }
    _cachedCablePolylines = cablePolylines;
    _cachedCableSegments = cableSegments;

    _cachedCustomerMarkers = _customers
        .whereType<Map>()
        .where(_isCustomerRowVisible)
        .map((c) {
          final lat = (c['latitude'] as num?)?.toDouble();
          final lng = (c['longitude'] as num?)?.toDouble();
          if (lat == null || lng == null) return null;
          final online = _isCustomerOnlineOnMap(c);
          final color =
              online ? const Color(0xFF2196F3) : _customerOfflineColor;
          final row = Map<String, dynamic>.from(c);
          return Marker(
            point: LatLng(lat, lng),
            width: 20,
            height: 20,
            alignment: Alignment.center,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => _onCustomerMarkerTap(row),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: color,
                  shape: BoxShape.circle,
                  border: Border.all(color: Colors.white, width: 1),
                ),
                child: const Icon(
                  Icons.home_rounded,
                  size: 11,
                  color: Colors.white,
                ),
              ),
            ),
          );
        })
        .whereType<Marker>()
        .toList(growable: false);

    _cachedOdpMarkers = _odps
        .whereType<Map>()
        .where(_isOdpRowVisible)
        .map((odp) {
          final status = (odp['status'] ?? 'active').toString();
          final lat = (odp['latitude'] as num?)?.toDouble();
          final lng = (odp['longitude'] as num?)?.toDouble();
          if (lat == null || lng == null) return null;
          final odpId =
              odp['code'] ?? odp['name'] ?? odp['id']?.toString() ?? '';
          return Marker(
            point: LatLng(lat, lng),
            width: 26,
            height: 30,
            alignment: Alignment.topCenter,
            child: GestureDetector(
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (context) =>
                        OdpDetailScreen(odpId: odpId.toString()),
                  ),
                ).then((_) => _fetchNetworkMap());
              },
              child: OdpMapMarker(status: status, size: 24),
            ),
          );
        })
        .whereType<Marker>()
        .toList(growable: false);

    _syncFlowAnimation();
  }

  void _zoomIn() {
    final nextZoom = (_currentZoom + 1).clamp(2.0, 20.0);
    _animateTo(_mapController.camera.center, nextZoom);
  }

  void _zoomOut() {
    final nextZoom = (_currentZoom - 1).clamp(2.0, 20.0);
    _animateTo(_mapController.camera.center, nextZoom);
  }

  void _moveToCurrentLocation() {
    _locateAndCenterToCurrentPosition();
  }

  Future<void> _locateAndCenterToCurrentPosition() async {
    if (_isLocating) return;
    setState(() => _isLocating = true);
    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('GPS belum aktif. Aktifkan lokasi dulu.'),
              backgroundColor: Colors.red,
            ),
          );
        }
        return;
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'Izin lokasi ditolak. Berikan izin lokasi untuk fitur ini.',
              ),
              backgroundColor: Colors.red,
            ),
          );
        }
        return;
      }

      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
        ),
      );
      if (!mounted) return;
      final point = LatLng(pos.latitude, pos.longitude);
      setState(() {
        _currentGpsLocation = point;
      });
      _animateTo(point, 18.0);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Gagal mengambil lokasi GPS saat ini.'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isLocating = false);
    }
  }

  void _onCustomerMarkerTap(Map<String, dynamic> row) {
    setState(() {
      final same =
          _selectedMapCustomer != null &&
          _selectedMapCustomer!['id']?.toString() == row['id']?.toString();
      _selectedMapCustomer = same ? null : row;
    });
  }

  Widget _buildMapCustomerCard(Map<String, dynamic> c) {
    const outline = Color(0xFFC8C4D3);
    const textMain = Color(0xFF19163F);
    const textMuted = Color(0xFF474551);
    const onlineColor = Color(0xFF1B7F3C);
    const onlineMutedColor = Color(0xFF2E7D32);
    const offlineColor = Color(0xFFC62828);

    final name = (c['name'] ?? '-').toString().trim();
    final pppUser = (c['pppoe_username'] ?? c['username'] ?? '')
        .toString()
        .trim();
    final pppUserLine = pppUser.isEmpty ? '—' : pppUser;

    final pa = c['pppoe_active'];
    final bool pppoeOnline =
        pa == true || pa == 1 || (pa is String && pa.toLowerCase() == 'true');
    final uptimeStr = (c['pppoe_uptime_display'] ?? '').toString().trim();

    Widget row(String label, String value) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: textMuted,
                letterSpacing: 0.35,
              ),
            ),
            const SizedBox(height: 4),
            SelectableText(
              value,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: textMain,
                height: 1.3,
              ),
            ),
          ],
        ),
      );
    }

    Widget statusPppoeRow() {
      return Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Status PPPoE',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: textMuted,
                letterSpacing: 0.35,
              ),
            ),
            const SizedBox(height: 4),
            if (pppoeOnline) ...[
              SelectableText(
                'Online',
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w800,
                  color: onlineColor,
                  height: 1.35,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Uptime sesi',
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  color: textMuted.withValues(alpha: 0.9),
                  letterSpacing: 0.2,
                ),
              ),
              const SizedBox(height: 2),
              SelectableText(
                uptimeStr.isEmpty ? '—' : uptimeStr,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: uptimeStr.isEmpty ? textMuted : onlineMutedColor,
                  height: 1.3,
                ),
              ),
            ] else if (pa == false)
              SelectableText(
                'Offline',
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w800,
                  color: offlineColor,
                  height: 1.35,
                ),
              )
            else
              SelectableText(
                'Tidak diketahui (username PPPoE kosong atau data sesi tidak tersedia)',
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: textMain,
                  height: 1.35,
                ),
              ),
          ],
        ),
      );
    }

    return Material(
      color: Colors.transparent,
      elevation: 0,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 260),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: const Color(0xFFFCF8FF),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: outline),
            boxShadow: const [
              BoxShadow(
                color: Color(0x33000000),
                blurRadius: 12,
                offset: Offset(0, 4),
              ),
            ],
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(13),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
                  decoration: const BoxDecoration(
                    color: Color(0xFFF0EBFF),
                    border: Border(
                      bottom: BorderSide(color: outline, width: 1),
                    ),
                  ),
                  child: Row(
                    children: [
                      const Icon(
                        Icons.home_rounded,
                        size: 20,
                        color: Color(0xFF1B0C6B),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          name,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
                            color: Color(0xFF070038),
                          ),
                        ),
                      ),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        tooltip: 'Tutup',
                        onPressed: () =>
                            setState(() => _selectedMapCustomer = null),
                        icon: const Icon(Icons.close_rounded, color: textMuted),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        row('Username PPPoE', pppUserLine),
                        statusPppoeRow(),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// Online/offline di peta = status PPPoE (bukan status billing),
  /// supaya warna rumah dan kabel selalu selaras.
  bool _isCustomerOnlineOnMap(Map row) {
    final pa = row['pppoe_active'];
    if (pa == true || pa == 1) return true;
    if (pa is String) {
      final s = pa.toLowerCase().trim();
      if (s == 'true' || s == '1') return true;
      if (s == 'false' || s == '0') return false;
    }
    if (pa == false || pa == 0) return false;
    if (row['network_down'] == true) return false;
    // PPPoE tidak diketahui: ikut status billing sebagai fallback.
    return (row['status'] ?? 'active').toString().toLowerCase() == 'active';
  }

  bool _isCableOnlineOnMap(Map row) {
    if (row['network_down'] == true) return false;
    final customer = _findCustomerForCable(row);
    if (customer != null) return _isCustomerOnlineOnMap(customer);
    final status = (row['status'] ?? 'connected').toString().toLowerCase();
    return status == 'connected';
  }

  bool _isOdpStatusVisible(String? rawStatus) {
    final status = (rawStatus ?? 'active').toString().toLowerCase();
    if (status == 'inactive') return _showOdpInactive;
    if (status == 'maintenance') return _showOdpMaintenance;
    return _showOdpActive;
  }

  bool _isCustomerRowVisible(Map row) {
    final online = _isCustomerOnlineOnMap(row);
    return online ? _showCustomerActive : _showCustomerInactive;
  }

  bool _isOdpRowVisible(Map row) {
    return _isOdpStatusVisible(row['status']?.toString());
  }

  Map? _findCustomerForCable(Map row) {
    final customerId = row['customer_id']?.toString();
    if (customerId != null && customerId.isNotEmpty) {
      final hit = _customerById[customerId];
      if (hit != null) return hit;
    }
    final lat = (row['customer_lat'] as num?)?.toDouble();
    final lng = (row['customer_lng'] as num?)?.toDouble();
    if (lat == null || lng == null) return null;
    for (final c in _customers.whereType<Map>()) {
      final cLat = (c['latitude'] as num?)?.toDouble();
      final cLng = (c['longitude'] as num?)?.toDouble();
      if (cLat == null || cLng == null) continue;
      if ((cLat - lat).abs() < 0.00001 && (cLng - lng).abs() < 0.00001) {
        return c;
      }
    }
    return null;
  }

  Map? _findOdpForCable(Map row) {
    final odpKey =
        (row['odp_id'] ?? row['odp_code'] ?? row['odp_name'])?.toString();
    if (odpKey != null && odpKey.isNotEmpty) {
      for (final o in _odps.whereType<Map>()) {
        final key = (o['id'] ?? o['code'] ?? o['name'])?.toString();
        if (key == odpKey) return o;
      }
    }
    final lat = (row['odp_lat'] as num?)?.toDouble();
    final lng = (row['odp_lng'] as num?)?.toDouble();
    if (lat == null || lng == null) return null;
    for (final o in _odps.whereType<Map>()) {
      final oLat = (o['latitude'] as num?)?.toDouble();
      final oLng = (o['longitude'] as num?)?.toDouble();
      if (oLat == null || oLng == null) continue;
      if ((oLat - lat).abs() < 0.00001 && (oLng - lng).abs() < 0.00001) {
        return o;
      }
    }
    return null;
  }

  bool _isCableRouteVisible(Map row) {
    final customer = _findCustomerForCable(row);
    final odp = _findOdpForCable(row);
    if (customer != null && !_isCustomerRowVisible(customer)) return false;
    if (odp != null && !_isOdpRowVisible(odp)) return false;
    return true;
  }

  List<List<LatLng>> _buildBackboneSegments() {
    return _backbone
        .whereType<Map>()
        .map((row) {
          final fromLat = (row['from_lat'] as num?)?.toDouble();
          final fromLng = (row['from_lng'] as num?)?.toDouble();
          final toLat = (row['to_lat'] as num?)?.toDouble();
          final toLng = (row['to_lng'] as num?)?.toDouble();
          if (fromLat == null ||
              fromLng == null ||
              toLat == null ||
              toLng == null) {
            return null;
          }
          return [LatLng(fromLat, fromLng), LatLng(toLat, toLng)];
        })
        .whereType<List<LatLng>>()
        .toList();
  }

  LatLng _interpolatePoint(LatLng a, LatLng b, double t) {
    return LatLng(
      a.latitude + ((b.latitude - a.latitude) * t),
      a.longitude + ((b.longitude - a.longitude) * t),
    );
  }

  List<List<LatLng>> _sampleSegments(
    List<List<LatLng>> segments, {
    int maxCount = _maxFlowDots,
  }) {
    if (segments.length <= maxCount) return segments;
    final out = <List<LatLng>>[];
    for (var i = 0; i < maxCount; i++) {
      out.add(segments[(i * segments.length) ~/ maxCount]);
    }
    return out;
  }

  List<CircleMarker> _buildFlowDots(
    List<List<LatLng>> segments, {
    required Color color,
    required double phaseShift,
  }) {
    if (!_flowAnimEnabled || segments.isEmpty) return const [];
    final t = (_flowController.value + phaseShift) % 1.0;
    final sampled = _sampleSegments(segments);
    return sampled.map((segment) {
      final p = _interpolatePoint(segment.first, segment.last, t);
      return CircleMarker(
        point: p,
        radius: 3.4,
        color: color,
        borderColor: Colors.white,
        borderStrokeWidth: 0.8,
      );
    }).toList(growable: false);
  }

  Widget _buildGpsPulseMarker() {
    return AnimatedBuilder(
      animation: _flowController,
      builder: (context, _) {
        final pulse = Curves.easeOut.transform(_flowController.value);
        final ringScale = 1.0 + (pulse * 1.2);
        final ringOpacity = (0.30 * (1 - pulse)).clamp(0.0, 1.0);
        return SizedBox(
          width: 42,
          height: 42,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Transform.scale(
                scale: ringScale,
                child: Container(
                  width: 24,
                  height: 24,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: const Color(
                      0xFF1A73E8,
                    ).withValues(alpha: ringOpacity),
                  ),
                ),
              ),
              Container(
                width: 16,
                height: 16,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: const Color(0xFF1A73E8),
                  border: Border.all(color: Colors.white, width: 2),
                  boxShadow: const [
                    BoxShadow(
                      color: Colors.black26,
                      blurRadius: 4,
                      offset: Offset(0, 1),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _toggleFilter(void Function() update) {
    setState(() {
      update();
      final selected = _selectedMapCustomer;
      if (selected != null && !_isCustomerRowVisible(selected)) {
        _selectedMapCustomer = null;
      }
      _rebuildMapCaches();
    });
  }

  Widget _filterChipIcon({
    required Color color,
    required IconData icon,
    Color iconColor = Colors.white,
    double size = 16,
  }) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 1),
        boxShadow: const [
          BoxShadow(color: Colors.black26, blurRadius: 2, offset: Offset(0, 1)),
        ],
      ),
      child: Icon(icon, size: size * 0.55, color: iconColor),
    );
  }

  Widget _buildFilterToggleRow({
    required bool enabled,
    required Widget icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Opacity(
        opacity: enabled ? 1 : 0.42,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
          child: Row(
            children: [
              Icon(
                enabled ? Icons.check_box : Icons.check_box_outline_blank,
                size: 18,
                color: enabled
                    ? const Color(0xFF2563EB)
                    : const Color(0xFF9E9E9E),
              ),
              const SizedBox(width: 6),
              icon,
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  label,
                  style: TextStyle(
                    fontSize: 11,
                    height: 1.1,
                    fontWeight: FontWeight.w700,
                    color: enabled
                        ? const Color(0xFF19163F)
                        : const Color(0xFF787582),
                    decoration: enabled
                        ? TextDecoration.none
                        : TextDecoration.lineThrough,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  bool get _hasActiveFilter =>
      !_showCustomerActive ||
      !_showCustomerInactive ||
      !_showOdpActive ||
      !_showOdpInactive ||
      !_showOdpMaintenance;

  Widget _buildMapFilterButton() {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () => setState(() => _filterPanelOpen = !_filterPanelOpen),
        borderRadius: BorderRadius.circular(12),
        child: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: _filterPanelOpen || _hasActiveFilter
                ? const Color(0xFF2563EB)
                : const Color(0xFFFCF8FF),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: _filterPanelOpen || _hasActiveFilter
                  ? const Color(0xFF2563EB)
                  : const Color(0xFFC8C4D3),
            ),
            boxShadow: const [
              BoxShadow(
                color: Colors.black26,
                blurRadius: 6,
                offset: Offset(0, 2),
              ),
            ],
          ),
          child: Icon(
            _filterPanelOpen ? Icons.close : Icons.filter_alt_rounded,
            size: 22,
            color: _filterPanelOpen || _hasActiveFilter
                ? Colors.white
                : const Color(0xFF19163F),
          ),
        ),
      ),
    );
  }

  /// Tombol ringkas di tengah kanan; panel muncul hanya saat dibuka.
  Widget _buildMapFilterControl() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (_filterPanelOpen) ...[
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 196),
            child: Container(
              padding: const EdgeInsets.fromLTRB(8, 10, 8, 8),
              decoration: BoxDecoration(
                color: const Color(0xF2FFFFFF),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFFC7D7FE)),
                boxShadow: const [
                  BoxShadow(
                    color: Colors.black26,
                    blurRadius: 10,
                    offset: Offset(0, 3),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 4),
                    child: Text(
                      'Filter perangkat',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                        color: Color(0xFF070038),
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                  _buildFilterToggleRow(
                    enabled: _showCustomerActive,
                    icon: _filterChipIcon(
                      color: const Color(0xFF2196F3),
                      icon: Icons.home_rounded,
                    ),
                    label: 'Pelanggan online',
                    onTap: () => _toggleFilter(
                      () => _showCustomerActive = !_showCustomerActive,
                    ),
                  ),
                  _buildFilterToggleRow(
                    enabled: _showCustomerInactive,
                    icon: _filterChipIcon(
                      color: _customerOfflineColor,
                      icon: Icons.home_rounded,
                    ),
                    label: 'Pelanggan offline',
                    onTap: () => _toggleFilter(
                      () => _showCustomerInactive = !_showCustomerInactive,
                    ),
                  ),
                  _buildFilterToggleRow(
                    enabled: _showOdpActive,
                    icon: _filterChipIcon(
                      color: const Color(0xFFFFC107),
                      icon: Icons.settings_input_antenna_rounded,
                      iconColor: const Color(0xFF5D4037),
                      size: 14,
                    ),
                    label: 'ODP aktif',
                    onTap: () =>
                        _toggleFilter(() => _showOdpActive = !_showOdpActive),
                  ),
                  _buildFilterToggleRow(
                    enabled: _showOdpInactive,
                    icon: _filterChipIcon(
                      color: const Color(0xFFC4C4C4),
                      icon: Icons.settings_input_antenna_rounded,
                      iconColor: const Color(0xFF424242),
                      size: 14,
                    ),
                    label: 'ODP nonaktif',
                    onTap: () => _toggleFilter(
                      () => _showOdpInactive = !_showOdpInactive,
                    ),
                  ),
                  _buildFilterToggleRow(
                    enabled: _showOdpMaintenance,
                    icon: _filterChipIcon(
                      color: const Color(0xFFFFCA28),
                      icon: Icons.settings_input_component_rounded,
                      iconColor: const Color(0xFF5D4037),
                      size: 14,
                    ),
                    label: 'ODP pemeliharaan',
                    onTap: () => _toggleFilter(
                      () => _showOdpMaintenance = !_showOdpMaintenance,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
        ],
        _buildMapFilterButton(),
      ],
    );
  }

  void _animateTo(
    LatLng targetCenter,
    double targetZoom, {
    Duration duration = const Duration(milliseconds: 420),
  }) async {
    if (!_isMapReady) {
      _currentZoom = targetZoom;
      return;
    }

    final startCenter = _mapController.camera.center;
    final startZoom = _mapController.camera.zoom;
    const frameMs = 16;
    final totalMs = duration.inMilliseconds;
    var elapsed = 0;

    while (elapsed < totalMs && mounted) {
      final linearT = (elapsed / totalMs).clamp(0.0, 1.0);
      final t = Curves.easeInOutCubic.transform(linearT);
      final lat =
          startCenter.latitude +
          ((targetCenter.latitude - startCenter.latitude) * t);
      final lng =
          startCenter.longitude +
          ((targetCenter.longitude - startCenter.longitude) * t);
      final zoom = startZoom + ((targetZoom - startZoom) * t);
      _mapController.move(LatLng(lat, lng), zoom);
      await Future<void>.delayed(const Duration(milliseconds: frameMs));
      elapsed += frameMs;
    }

    if (mounted) {
      _mapController.move(targetCenter, targetZoom);
      _currentZoom = targetZoom;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF6F1FF), // surface-container-low
      appBar: AppBar(
        backgroundColor: const Color(0xFF2563EB),
        title: const Text(
          'Pemetaan Jaringan',
          style: TextStyle(
            color: Colors.white,
            fontSize: 28,
            fontWeight: FontWeight.bold,
          ),
        ),
        centerTitle: false,
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white),
            onPressed: _fetchNetworkMap,
          ),
        ],
      ),
      body: Stack(
        children: [
          // Map — marker/polyline dari cache; hanya flow dots yang dianimasikan.
          RepaintBoundary(
            child: FlutterMap(
              mapController: _mapController,
              options: MapOptions(
                initialCenter: _defaultCenter,
                initialZoom: _currentZoom,
                keepAlive: true,
                onMapReady: () {
                  _isMapReady = true;
                },
                onTap: (tapPosition, latLng) {
                  setState(() => _selectedMapCustomer = null);
                },
                onPositionChanged: (position, hasGesture) {
                  if (hasGesture) {
                    _currentZoom = position.zoom;
                  }
                },
              ),
              children: [
                TileLayer(
                  urlTemplate:
                      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                  userAgentPackageName:
                      'com.example.billing_kalimasada_mobile',
                  keepBuffer: 2,
                  panBuffer: 1,
                ),
                PolylineLayer(polylines: _cachedBackbonePolylines),
                PolylineLayer(polylines: _cachedCablePolylines),
                if (_flowAnimEnabled)
                  AnimatedBuilder(
                    animation: _flowController,
                    builder: (context, _) {
                      return CircleLayer(
                        circles: [
                          ..._buildFlowDots(
                            _cachedCableSegments,
                            color: _customerFlowColor,
                            phaseShift: 0.0,
                          ),
                          ..._buildFlowDots(
                            _cachedBackboneSegments,
                            color: _backboneFlowColor,
                            phaseShift: 0.35,
                          ),
                        ],
                      );
                    },
                  ),
                MarkerLayer(markers: _cachedCustomerMarkers),
                if (_currentGpsLocation != null)
                  MarkerLayer(
                    markers: [
                      Marker(
                        point: _currentGpsLocation!,
                        width: 34,
                        height: 34,
                        alignment: Alignment.center,
                        child: _buildGpsPulseMarker(),
                      ),
                    ],
                  ),
                MarkerLayer(markers: _cachedOdpMarkers),
              ],
            ),
          ),

          // Overlays Layer
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Atas: pencarian
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: double.infinity,
                          child: Container(
                            height: 48,
                            decoration: BoxDecoration(
                              color: const Color(0xFFFCF8FF), // surface
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: const Color(0xFFC8C4D3),
                              ),
                              boxShadow: const [
                                BoxShadow(
                                  color: Colors.black12,
                                  blurRadius: 4,
                                  offset: Offset(0, 2),
                                ),
                              ],
                            ),
                            child: Row(
                              children: [
                                const Padding(
                                  padding: EdgeInsets.symmetric(horizontal: 16),
                                  child: Icon(
                                    Icons.search,
                                    color: Color(0xFF474551),
                                  ), // on-surface-variant
                                ),
                                Expanded(
                                  child: Autocomplete<Map<String, dynamic>>(
                                    optionsBuilder:
                                        (TextEditingValue textEditingValue) {
                                          if (textEditingValue.text.isEmpty) {
                                            return const Iterable<
                                              Map<String, dynamic>
                                            >.empty();
                                          }
                                          final allItems =
                                              <Map<String, dynamic>>[
                                                ..._odps.whereType<Map>().map(
                                                  (e) =>
                                                      Map<String, dynamic>.from(
                                                        e,
                                                      )..['__type'] = 'ODP',
                                                ),
                                                ..._customers
                                                    .whereType<Map>()
                                                    .map(
                                                      (e) =>
                                                          Map<
                                                              String,
                                                              dynamic
                                                            >.from(e)
                                                            ..['__type'] =
                                                                'CUSTOMER',
                                                    ),
                                              ];
                                          return allItems.where((item) {
                                            final name = (item['name'] ?? '')
                                                .toString()
                                                .toLowerCase();
                                            final code =
                                                (item['code'] ??
                                                        item['phone'] ??
                                                        '')
                                                    .toString()
                                                    .toLowerCase();
                                            final query = textEditingValue.text
                                                .toLowerCase();
                                            return name.contains(query) ||
                                                code.contains(query);
                                          });
                                        },
                                    displayStringForOption:
                                        (Map<String, dynamic> option) =>
                                            option['name'] ??
                                            option['code'] ??
                                            '',
                                    onSelected:
                                        (Map<String, dynamic> selection) {
                                          if (selection['latitude'] != null &&
                                              selection['longitude'] != null) {
                                            final lat =
                                                (selection['latitude'] as num)
                                                    .toDouble();
                                            final lng =
                                                (selection['longitude'] as num)
                                                    .toDouble();
                                            _animateTo(LatLng(lat, lng), 18.0);
                                          }
                                        },
                                    fieldViewBuilder:
                                        (
                                          context,
                                          textEditingController,
                                          focusNode,
                                          onFieldSubmitted,
                                        ) {
                                          return TextField(
                                            controller: textEditingController,
                                            focusNode: focusNode,
                                            decoration: const InputDecoration(
                                              hintText:
                                                  'Cari ODP atau perangkat',
                                              hintStyle: TextStyle(
                                                color: Color(0xFF787582),
                                              ), // outline
                                              border: InputBorder.none,
                                            ),
                                            style: const TextStyle(
                                              color: Color(0xFF19163F),
                                            ),
                                            onSubmitted: (String value) {
                                              onFieldSubmitted();
                                            },
                                          );
                                        },
                                    optionsViewBuilder:
                                        (
                                          context,
                                          onSelected,
                                          Iterable<Map<String, dynamic>>
                                          options,
                                        ) {
                                          return Align(
                                            alignment: Alignment.topLeft,
                                            child: Padding(
                                              padding: const EdgeInsets.only(
                                                top: 8.0,
                                              ),
                                              child: ClipRRect(
                                                borderRadius:
                                                    BorderRadius.circular(8),
                                                child: BackdropFilter(
                                                  filter: ImageFilter.blur(
                                                    sigmaX: 10,
                                                    sigmaY: 10,
                                                  ),
                                                  child: Material(
                                                    elevation: 4,
                                                    color: Colors.white
                                                        .withValues(alpha: 0.5),
                                                    child: ConstrainedBox(
                                                      constraints:
                                                          BoxConstraints(
                                                            maxHeight: 250,
                                                            maxWidth:
                                                                MediaQuery.of(
                                                                  context,
                                                                ).size.width -
                                                                40 -
                                                                48,
                                                          ),
                                                      child: ListView.builder(
                                                        padding:
                                                            EdgeInsets.zero,
                                                        shrinkWrap: true,
                                                        itemCount:
                                                            options.length,
                                                        itemBuilder: (context, index) {
                                                          final option = options
                                                              .elementAt(index);
                                                          return ListTile(
                                                            leading: const Icon(
                                                              Icons.router,
                                                              color: Color(
                                                                0xFF070038,
                                                              ),
                                                            ),
                                                            title: Text(
                                                              option['name'] ??
                                                                  option['code'] ??
                                                                  '',
                                                              style: const TextStyle(
                                                                fontWeight:
                                                                    FontWeight
                                                                        .bold,
                                                                fontSize: 14,
                                                                color: Colors
                                                                    .black87,
                                                              ),
                                                            ),
                                                            subtitle: Text(
                                                              option['__type'] ==
                                                                      'CUSTOMER'
                                                                  ? 'Pelanggan • ${(option['phone'] ?? '').toString()}'
                                                                  : 'ODP • ${(option['code'] ?? '').toString()}',
                                                              style:
                                                                  const TextStyle(
                                                                    fontSize:
                                                                        12,
                                                                    color: Colors
                                                                        .black54,
                                                                  ),
                                                            ),
                                                            onTap: () {
                                                              onSelected(
                                                                option,
                                                              );
                                                            },
                                                          );
                                                        },
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            ),
                                          );
                                        },
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),

                  // Bottom: Controls, Info Panel, FAB
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      // Map Controls (Zoom & Location)
                      Container(
                        width: 40,
                        decoration: BoxDecoration(
                          color: const Color(0xFFFCF8FF),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFC8C4D3)),
                          boxShadow: const [
                            BoxShadow(
                              color: Colors.black12,
                              blurRadius: 4,
                              offset: Offset(0, 2),
                            ),
                          ],
                        ),
                        child: Column(
                          children: [
                            IconButton(
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(
                                minHeight: 40,
                                minWidth: 40,
                              ),
                              icon: const Icon(Icons.add, size: 20),
                              onPressed: _zoomIn,
                              color: const Color(0xFF19163F),
                            ),
                            Container(
                              height: 1,
                              width: 40,
                              color: const Color(0xFFC8C4D3),
                            ),
                            IconButton(
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(
                                minHeight: 40,
                                minWidth: 40,
                              ),
                              icon: const Icon(Icons.remove, size: 20),
                              onPressed: _zoomOut,
                              color: const Color(0xFF19163F),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 8),
                      Container(
                        width: 40,
                        decoration: BoxDecoration(
                          color: const Color(0xFFFCF8FF),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFC8C4D3)),
                          boxShadow: const [
                            BoxShadow(
                              color: Colors.black12,
                              blurRadius: 4,
                              offset: Offset(0, 2),
                            ),
                          ],
                        ),
                        child: IconButton(
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(
                            minHeight: 40,
                            minWidth: 40,
                          ),
                          icon: _isLocating
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.my_location, size: 20),
                          onPressed: _moveToCurrentLocation,
                          color: const Color(0xFF19163F),
                        ),
                      ),

                      const SizedBox(height: 16),

                      // FAB: Tagging ODP dan pelanggan
                      Align(
                        alignment: Alignment.centerRight,
                        child: Wrap(
                          alignment: WrapAlignment.end,
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            ElevatedButton.icon(
                              onPressed: () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (context) =>
                                        const TagLocationScreen(),
                                  ),
                                ).then((success) {
                                  if (success == true) {
                                    _fetchNetworkMap();
                                  }
                                });
                              },
                              icon: const Icon(
                                Icons.add_location_alt,
                                color: Colors.white,
                              ),
                              label: const Text(
                                'Tag ODP',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFF2563EB),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 14,
                                  vertical: 14,
                                ),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(16),
                                ),
                                elevation: 4,
                              ),
                            ),
                            ElevatedButton.icon(
                              onPressed: () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (context) =>
                                        const TagCustomerLocationScreen(),
                                  ),
                                ).then((success) {
                                  if (success == true) {
                                    _fetchNetworkMap();
                                  }
                                });
                              },
                              icon: const Icon(
                                Icons.person_pin_circle,
                                color: Colors.white,
                              ),
                              label: const Text(
                                'Tag Pelanggan',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFF2563EB),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 14,
                                  vertical: 14,
                                ),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(16),
                                ),
                                elevation: 4,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),

          // Tombol filter ringkas: tengah layar, sebelah kanan
          SafeArea(
            child: Align(
              alignment: Alignment.centerRight,
              child: Padding(
                padding: const EdgeInsets.only(right: 12),
                child: _buildMapFilterControl(),
              ),
            ),
          ),

          if (_selectedMapCustomer != null)
            Positioned(
              left: 16,
              right: 16,
              bottom: 100,
              height: 260,
              child: _buildMapCustomerCard(_selectedMapCustomer!),
            ),

          if (_isLoading) const Center(child: CircularProgressIndicator()),
        ],
      ),
    );
  }
}
