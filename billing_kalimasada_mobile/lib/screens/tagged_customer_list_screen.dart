import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/tag_customer_location_service.dart';
import '../services/tag_customer_search_service.dart';
import '../store/auth_provider.dart';
import '../utils/customer_location_tag_utils.dart';
import '../widgets/customer_home_map_marker.dart';
import '../widgets/customer_location_tag_badge.dart';

class TaggedCustomerListScreen extends StatefulWidget {
  const TaggedCustomerListScreen({
    super.key,
    this.locationStatus = 'tagged',
  });

  /// `tagged` atau `untagged`
  final String locationStatus;

  bool get isTagged => locationStatus == 'tagged';

  @override
  State<TaggedCustomerListScreen> createState() => _TaggedCustomerListScreenState();
}

class _TaggedCustomerListScreenState extends State<TaggedCustomerListScreen> {
  static const _primary = Color(0xFF2563EB);
  static const _text = Color(0xFF0F172A);
  static const _muted = Color(0xFF64748B);

  final ScrollController _scrollController = ScrollController();
  final TextEditingController _searchController = TextEditingController();

  final List<Map<String, dynamic>> _rows = [];
  Map<int, String> _areaById = {};
  bool _loading = false;
  bool _loadingMore = false;
  bool _hasMore = true;
  int _page = 1;
  String _search = '';

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    _loadAreaNames();
    _fetch(refresh: true);
  }

  @override
  void dispose() {
    _scrollController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadAreaNames() async {
    final map = await TagCustomerSearchService.loadAreaNameMap();
    if (!mounted) return;
    setState(() => _areaById = map);
  }

  void _onScroll() {
    if (!_hasMore || _loading || _loadingMore) return;
    if (_scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - 200) {
      _fetch();
    }
  }

  Future<void> _fetch({bool refresh = false}) async {
    if (_loading || _loadingMore) return;
    if (!refresh && !_hasMore) return;

    if (refresh) {
      setState(() {
        _loading = true;
        _page = 1;
        _hasMore = true;
        _rows.clear();
      });
    } else {
      setState(() => _loadingMore = true);
    }

    final role = context.read<AuthProvider>().role ?? '';
    try {
      final hits = await TagCustomerLocationService.fetchCustomersByLocationStatus(
        role: role,
        locationStatus: widget.locationStatus,
        page: _page,
        search: _search,
      );
      if (!mounted) return;
      setState(() {
        _rows.addAll(hits);
        _hasMore = hits.length >= 30;
        _page += 1;
        _loading = false;
        _loadingMore = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadingMore = false;
      });
    }
  }

  void _onSearchSubmitted(String value) {
    _search = value.trim();
    _fetch(refresh: true);
  }

  String _areaLabel(Map<String, dynamic> row) {
    return TagCustomerSearchService.areaLabel(row, _areaById);
  }

  Future<void> _openPreview(Map<String, dynamic> row) async {
    final lat = double.tryParse(row['latitude']?.toString() ?? '');
    final lng = double.tryParse(row['longitude']?.toString() ?? '');
    if (lat == null || lng == null) return;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        final point = LatLng(lat, lng);
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    decoration: BoxDecoration(
                      color: const Color(0xFFE2E8F0),
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  row['name']?.toString() ?? 'Pelanggan',
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 16,
                    color: _text,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  formatCustomerCoordinates(row),
                  style: const TextStyle(fontSize: 12, color: _muted),
                ),
                const SizedBox(height: 12),
                SizedBox(
                  height: 220,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: FlutterMap(
                      options: MapOptions(initialCenter: point, initialZoom: 17),
                      children: [
                        TileLayer(
                          urlTemplate:
                              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                          userAgentPackageName:
                              'com.example.billing_kalimasada_mobile',
                        ),
                        MarkerLayer(
                          markers: [
                            Marker(
                              point: point,
                              width: 28,
                              height: 33,
                              alignment: Alignment.topCenter,
                              child: const CustomerHomeMapMarker(),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: () async {
                    final uri = Uri.parse(
                      'https://www.google.com/maps/search/?api=1&query=$lat,$lng',
                    );
                    if (await canLaunchUrl(uri)) {
                      await launchUrl(uri, mode: LaunchMode.externalApplication);
                    }
                  },
                  icon: const Icon(Icons.map_outlined),
                  label: const Text('Buka di Google Maps'),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _onRowTap(Map<String, dynamic> row) {
    if (widget.isTagged) {
      _openPreview(row);
      return;
    }
    Navigator.pop(context, row);
  }

  @override
  Widget build(BuildContext context) {
    final isTagged = widget.isTagged;
    return Scaffold(
      backgroundColor: const Color(0xFFF8FBFF),
      appBar: AppBar(
        backgroundColor: _primary,
        foregroundColor: Colors.white,
        title: Text(
          isTagged ? 'Sudah Tag' : 'Belum Tag',
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
        centerTitle: true,
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: TextField(
              controller: _searchController,
              decoration: InputDecoration(
                hintText: 'Cari nama / telepon / ID',
                prefixIcon: const Icon(Icons.search),
                filled: true,
                fillColor: Colors.white,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: const BorderSide(color: Color(0xFFBFDBFE)),
                ),
              ),
              onSubmitted: _onSearchSubmitted,
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(
                    child: CircularProgressIndicator(color: _primary),
                  )
                : _rows.isEmpty
                ? Center(
                    child: Text(
                      isTagged
                          ? 'Belum ada pelanggan dengan tag lokasi'
                          : 'Semua pelanggan sudah punya tag lokasi',
                      style: const TextStyle(color: _muted),
                    ),
                  )
                : RefreshIndicator(
                    onRefresh: () => _fetch(refresh: true),
                    color: _primary,
                    child: ListView.separated(
                      controller: _scrollController,
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                      itemCount: _rows.length + (_loadingMore ? 1 : 0),
                      separatorBuilder: (_, index) => const SizedBox(height: 8),
                      itemBuilder: (context, index) {
                        if (index >= _rows.length) {
                          return const Padding(
                            padding: EdgeInsets.all(16),
                            child: Center(
                              child: CircularProgressIndicator(color: _primary),
                            ),
                          );
                        }
                        final row = _rows[index];
                        final name = row['name']?.toString() ?? '';
                        final phone = row['phone']?.toString() ?? '';
                        final cid = row['customer_id']?.toString() ?? '';
                        final area = _areaLabel(row);
                        final contact = [
                          phone,
                          cid,
                        ].where((s) => s.isNotEmpty).join(' · ');

                        final borderColor = isTagged
                            ? const Color(0xFFBBF7D0)
                            : const Color(0xFFFDE68A);

                        return Material(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(12),
                          child: InkWell(
                            onTap: () => _onRowTap(row),
                            borderRadius: BorderRadius.circular(12),
                            child: Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: borderColor),
                              ),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
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
                                            fontWeight: FontWeight.w700,
                                            fontSize: 15,
                                            color: _text,
                                          ),
                                        ),
                                        if (contact.isNotEmpty) ...[
                                          const SizedBox(height: 2),
                                          Text(
                                            contact,
                                            style: const TextStyle(
                                              fontSize: 12,
                                              color: _muted,
                                            ),
                                          ),
                                        ],
                                        if (isTagged) ...[
                                          const SizedBox(height: 4),
                                          Text(
                                            formatCustomerCoordinates(row),
                                            style: const TextStyle(
                                              fontSize: 11,
                                              color: _muted,
                                            ),
                                          ),
                                        ] else if ((row['address']?.toString() ?? '')
                                            .isNotEmpty) ...[
                                          const SizedBox(height: 4),
                                          Text(
                                            row['address']?.toString() ?? '',
                                            maxLines: 2,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(
                                              fontSize: 11,
                                              color: _muted,
                                            ),
                                          ),
                                        ],
                                      ],
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: [
                                      CustomerLocationTagBadge(row: row),
                                      if (area.isNotEmpty) ...[
                                        const SizedBox(height: 6),
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
                                              color: _primary,
                                              height: 1.25,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
