import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/tag_customer_search_service.dart';
import '../store/auth_provider.dart';
import '../store/customer_provider.dart';
import '../widgets/customer_home_map_marker.dart';

/// Tag lokasi pelanggan (GPS); ODP opsional — menyimpan lewat [CustomerProvider.updateLocation].
class TagCustomerLocationScreen extends StatefulWidget {
  const TagCustomerLocationScreen({super.key});

  @override
  State<TagCustomerLocationScreen> createState() =>
      _TagCustomerLocationScreenState();
}

class _TagCustomerLocationScreenState extends State<TagCustomerLocationScreen>
    with SingleTickerProviderStateMixin {
  final MapController _mapController = MapController();
  final TextEditingController _customerSearchController =
      TextEditingController();

  LatLng? _selectedLocation;
  LatLng? _currentGpsLocation;
  bool _isLoading = false;
  bool _isLocating = false;
  bool _loadingOdps = true;
  String? _odpLoadError;

  List<Map<String, dynamic>> _odpList = [];
  int? _selectedOdpId;

  Map<String, dynamic>? _selectedCustomer;
  List<Map<String, dynamic>> _searchHits = [];
  bool _searching = false;
  Timer? _debounce;
  Map<int, String> _areaById = {};
  Future<void>? _areaNamesFuture;

  late final AnimationController _gpsPulseController;

  static const LatLng _defaultLocation = LatLng(-7.404620, 109.724536);

  @override
  void initState() {
    super.initState();
    _gpsPulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1700),
    )..repeat();
    _loadOdps();
    _areaNamesFuture = _loadAreaNames();
  }

  Future<void> _loadAreaNames() async {
    final map = await TagCustomerSearchService.loadAreaNameMap();
    if (!mounted) return;
    setState(() {
      _areaById = map;
      if (_searchHits.isNotEmpty) {
        _searchHits = _searchHits
            .map((h) => TagCustomerSearchService.enrichRow(h, _areaById))
            .toList();
      }
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _gpsPulseController.dispose();
    _customerSearchController.dispose();
    super.dispose();
  }

  Future<void> _loadOdps() async {
    setState(() {
      _loadingOdps = true;
      _odpLoadError = null;
    });
    try {
      final response = await ApiClient.get('/api/mobile-adapter/odps?all=1');
      if (response.statusCode != 200) {
        throw Exception('HTTP ${response.statusCode}');
      }
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (!ApiClient.jsonSuccess(data['success'])) {
        throw Exception(data['message']?.toString() ?? 'Gagal memuat ODP');
      }
      final raw = data['data'];
      final list = raw is List
          ? raw.map((e) => Map<String, dynamic>.from(e as Map)).toList()
          : <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() {
        _odpList = list;
        _loadingOdps = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingOdps = false;
        _odpLoadError = e.toString();
      });
    }
  }

  void _onCustomerQueryChanged(String q) {
    _debounce?.cancel();
    final trimmed = q.trim();
    if (trimmed.length < 2) {
      setState(() {
        _searchHits = [];
        _searching = false;
        if (_selectedCustomer != null &&
            (_selectedCustomer!['name']?.toString() ?? '') != q) {
          _selectedCustomer = null;
        }
      });
      return;
    }
    if (_selectedCustomer != null) {
      final name = _selectedCustomer!['name']?.toString() ?? '';
      if (q != name) {
        setState(() => _selectedCustomer = null);
      }
    }
    _debounce = Timer(const Duration(milliseconds: 400), () {
      _runCustomerSearch(trimmed);
    });
  }

  Future<void> _runCustomerSearch(String q) async {
    setState(() => _searching = true);
    final role = context.read<AuthProvider>().role ?? '';
    try {
      await (_areaNamesFuture ?? _loadAreaNames());
      final hits = await TagCustomerSearchService.search(
        role: role,
        query: q,
        areaById: _areaById,
      );
      if (!mounted) return;
      setState(() {
        _searchHits = hits;
        _searching = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _searchHits = [];
        _searching = false;
      });
    }
  }

  String _customerAreaLabel(Map<String, dynamic> row) {
    return TagCustomerSearchService.areaLabel(row, _areaById);
  }

  void _pickCustomer(Map<String, dynamic> row) {
    final name = row['name']?.toString() ?? '';
    setState(() {
      _selectedCustomer = row;
      _customerSearchController.text = name;
      _searchHits = [];
    });
    FocusScope.of(context).unfocus();
  }

  void _onMapTap(TapPosition tapPosition, LatLng point) {
    setState(() => _selectedLocation = point);
  }

  Future<void> _moveToCurrentLocation() async {
    if (_isLocating) return;
    setState(() => _isLocating = true);
    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'GPS belum aktif. Aktifkan lokasi perangkat terlebih dahulu.',
            ),
            backgroundColor: Colors.red,
          ),
        );
        return;
      }

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }

      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Izin lokasi ditolak. Izinkan akses lokasi untuk memakai lokasi saya.',
            ),
            backgroundColor: Colors.red,
          ),
        );
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
        ),
      );

      final point = LatLng(position.latitude, position.longitude);
      if (!mounted) return;
      setState(() {
        _currentGpsLocation = point;
        _selectedLocation = point;
      });
      _mapController.move(point, 18.0);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Gagal mengambil lokasi: $e'),
          backgroundColor: Colors.red,
        ),
      );
    } finally {
      if (mounted) setState(() => _isLocating = false);
    }
  }

  Widget _buildGpsPulseMarker() {
    return AnimatedBuilder(
      animation: _gpsPulseController,
      builder: (context, _) {
        final pulse = Curves.easeOut.transform(_gpsPulseController.value);
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

  String _odpLabel(Map<String, dynamic> o) {
    final name = o['name']?.toString() ?? '';
    final code = o['code']?.toString() ?? '';
    if (code.isEmpty) return name;
    return '$name ($code)';
  }

  Future<void> _save() async {
    final cust = _selectedCustomer;
    if (cust == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Pilih pelanggan dari pencarian'),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }
    final id = cust['id'];
    final customerPk = id is int ? id : int.tryParse(id?.toString() ?? '');
    if (customerPk == null || customerPk < 1) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Data pelanggan tidak valid'),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }
    if (_selectedLocation == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Tandai lokasi di peta atau pakai lokasi saya'),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }

    setState(() => _isLoading = true);
    try {
      final ok = await context.read<CustomerProvider>().updateLocation(
        customerPk.toString(),
        _selectedLocation!.latitude,
        _selectedLocation!.longitude,
        odpId: _selectedOdpId,
      );
      if (!mounted) return;
      if (ok) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Lokasi pelanggan berhasil disimpan'),
            backgroundColor: Colors.green,
          ),
        );
        Navigator.pop(context, true);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Gagal menyimpan. Periksa koneksi atau data.'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    const bgBackground = Color(0xFFF8FBFF);
    const textOnSurface = Color(0xFF0F172A);
    const textOnSurfaceVariant = Color(0xFF475569);
    const primary = Color(0xFF2563EB);
    const fieldFill = Color(0xFFEFF6FF);
    const outline = Color(0xFFBFDBFE);

    // App global = dark theme; layar ini desain terang — pakai tema terang lokal agar hint/dropdown/teks input tidak putih.
    final lightScheme = ColorScheme.fromSeed(
      seedColor: primary,
      brightness: Brightness.light,
      surface: Colors.white,
      onSurface: textOnSurface,
      onSurfaceVariant: textOnSurfaceVariant,
    );

    return Theme(
      data: ThemeData(
        useMaterial3: true,
        brightness: Brightness.light,
        colorScheme: lightScheme,
        scaffoldBackgroundColor: bgBackground,
        textSelectionTheme: const TextSelectionThemeData(
          cursorColor: primary,
          selectionColor: Color(0xFFBFDBFE),
          selectionHandleColor: primary,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: fieldFill,
          hintStyle: const TextStyle(color: textOnSurfaceVariant, fontSize: 15),
          labelStyle: const TextStyle(color: textOnSurfaceVariant),
          floatingLabelStyle: const TextStyle(color: textOnSurfaceVariant),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: outline),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: outline),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: primary, width: 1.5),
          ),
        ),
        listTileTheme: const ListTileThemeData(
          textColor: textOnSurface,
          iconColor: textOnSurfaceVariant,
        ),
        progressIndicatorTheme: const ProgressIndicatorThemeData(
          color: primary,
          linearTrackColor: Color(0xFFBFDBFE),
        ),
      ),
      child: Scaffold(
        backgroundColor: bgBackground,
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
            'Tag Pelanggan',
            style: TextStyle(
              color: Colors.white,
              fontSize: 20,
              fontWeight: FontWeight.bold,
            ),
          ),
          centerTitle: true,
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(1),
            child: Container(color: const Color(0xFFBFDBFE), height: 1),
          ),
        ),
        body: Stack(
          children: [
            SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    height: 280,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: const Color(0xFFBFDBFE)),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: Stack(
                      children: [
                        FlutterMap(
                          mapController: _mapController,
                          options: MapOptions(
                            initialCenter: _defaultLocation,
                            initialZoom: 15,
                            onTap: _onMapTap,
                          ),
                          children: [
                            TileLayer(
                              urlTemplate:
                                  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                              userAgentPackageName:
                                  'com.example.billing_kalimasada_mobile',
                            ),
                            if (_selectedLocation != null)
                              MarkerLayer(
                                markers: [
                                  Marker(
                                    point: _selectedLocation!,
                                    width: 28,
                                    height: 33,
                                    alignment: Alignment.topCenter,
                                    child: const CustomerHomeMapMarker(),
                                  ),
                                ],
                              ),
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
                          ],
                        ),
                        Positioned(
                          bottom: 12,
                          right: 12,
                          child: Material(
                            color: Colors.white,
                            shape: const CircleBorder(),
                            elevation: 2,
                            child: IconButton(
                              tooltip: 'Lokasi saya',
                              icon: _isLocating
                                  ? const SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: primary,
                                      ),
                                    )
                                  : const Icon(
                                      Icons.my_location,
                                      color: primary,
                                    ),
                              onPressed: _moveToCurrentLocation,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _selectedLocation == null
                        ? '⚠️ KLIK DULU MAPNYA YA GAESS !'
                        : 'Pin: ${_selectedLocation!.latitude.toStringAsFixed(6)}, ${_selectedLocation!.longitude.toStringAsFixed(6)}',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 13,
                      color: _selectedLocation == null
                          ? const Color(0xFFBA1A1A)
                          : textOnSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    'NAMA PELANGGAN',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: textOnSurfaceVariant,
                      letterSpacing: 0.8,
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _customerSearchController,
                    onChanged: _onCustomerQueryChanged,
                    style: const TextStyle(color: textOnSurface, fontSize: 15),
                    decoration: const InputDecoration(
                      hintText: 'Cari nama / telepon / ID pelanggan',
                    ),
                  ),
                  if (_searching)
                    const Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: LinearProgressIndicator(minHeight: 2),
                    ),
                  if (_searchHits.isNotEmpty)
                    Container(
                      margin: const EdgeInsets.only(top: 8),
                      constraints: const BoxConstraints(maxHeight: 200),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFBFDBFE)),
                      ),
                      child: ListView.separated(
                        shrinkWrap: true,
                        itemCount: _searchHits.length,
                        separatorBuilder: (context, index) =>
                            const Divider(height: 1),
                        itemBuilder: (context, i) {
                          final row = _searchHits[i];
                          final name = row['name']?.toString() ?? '';
                          final area = _customerAreaLabel(row);
                          final phone = row['phone']?.toString() ?? '';
                          final cid = row['customer_id']?.toString() ?? '';
                          final contactLine = [
                            phone,
                            cid,
                          ].where((s) => s.isNotEmpty).join(' · ');
                          return InkWell(
                            onTap: () => _pickCustomer(row),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 16,
                                vertical: 10,
                              ),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.center,
                                children: [
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          name,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                            color: textOnSurface,
                                            fontWeight: FontWeight.w600,
                                            fontSize: 15,
                                          ),
                                        ),
                                        if (contactLine.isNotEmpty) ...[
                                          const SizedBox(height: 2),
                                          Text(
                                            contactLine,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(
                                              fontSize: 12,
                                              color: textOnSurfaceVariant,
                                            ),
                                          ),
                                        ],
                                      ],
                                    ),
                                  ),
                                  if (area.isNotEmpty) ...[
                                    const SizedBox(width: 10),
                                    ConstrainedBox(
                                      constraints: const BoxConstraints(
                                        maxWidth: 112,
                                      ),
                                      child: Text(
                                        area,
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        textAlign: TextAlign.right,
                                        style: const TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.w600,
                                          color: primary,
                                          height: 1.25,
                                        ),
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                  if (_selectedCustomer != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      'Terpilih: ID ${_selectedCustomer!['id']} — ${_selectedCustomer!['name']}',
                      style: const TextStyle(
                        fontSize: 12,
                        color: textOnSurfaceVariant,
                      ),
                    ),
                  ],
                  const SizedBox(height: 20),
                  const Text(
                    'PILIH ODP (OPSIONAL)',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: textOnSurfaceVariant,
                      letterSpacing: 0.8,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Boleh dikosongkan jika hanya memperbarui titik lokasi di peta.',
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.35,
                      color: textOnSurfaceVariant.withValues(alpha: 0.92),
                    ),
                  ),
                  const SizedBox(height: 8),
                  if (_loadingOdps)
                    const Center(
                      child: Padding(
                        padding: EdgeInsets.all(16),
                        child: CircularProgressIndicator(color: primary),
                      ),
                    )
                  else if (_odpLoadError != null)
                    Text(
                      'Gagal memuat ODP: $_odpLoadError',
                      style: const TextStyle(color: Color(0xFFBA1A1A)),
                    )
                  else
                    InputDecorator(
                      decoration: const InputDecoration(),
                      child: DropdownButtonHideUnderline(
                        child: DropdownButton<int?>(
                          value: _selectedOdpId,
                          isExpanded: true,
                          style: const TextStyle(
                            color: textOnSurface,
                            fontSize: 15,
                          ),
                          hint: const Text(
                            'Pilih ODP (opsional)',
                            style: TextStyle(color: textOnSurfaceVariant),
                          ),
                          dropdownColor: Colors.white,
                          iconEnabledColor: primary,
                          items: [
                            const DropdownMenuItem<int?>(
                              value: null,
                              child: Text(
                                'Tanpa ODP — hanya simpan koordinat',
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: textOnSurface,
                                  fontSize: 14,
                                ),
                              ),
                            ),
                            ..._odpList.map((o) {
                              final idVal = o['id'];
                              final id = idVal is int
                                  ? idVal
                                  : int.tryParse(idVal?.toString() ?? '');
                              if (id == null) return null;
                              return DropdownMenuItem<int?>(
                                value: id,
                                child: Text(
                                  _odpLabel(o),
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(color: textOnSurface),
                                ),
                              );
                            }).whereType<DropdownMenuItem<int?>>(),
                          ],
                          onChanged: (v) => setState(() => _selectedOdpId = v),
                        ),
                      ),
                    ),
                  const SizedBox(height: 28),
                  SizedBox(
                    height: 52,
                    child: ElevatedButton(
                      onPressed: _isLoading ? null : _save,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: primary,
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: _isLoading
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Text(
                              'Simpan',
                              style: TextStyle(
                                fontWeight: FontWeight.w700,
                                fontSize: 16,
                              ),
                            ),
                    ),
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
