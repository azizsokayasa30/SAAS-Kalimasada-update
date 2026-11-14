import 'dart:async' show unawaited;
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show ChangeNotifier, debugPrint, kDebugMode;
import 'package:path_provider/path_provider.dart';
import '../services/api_client.dart';

class CollectorProvider extends ChangeNotifier {
  /// Ditambah dari luar (tombol sync) agar tab Pelanggan memuat ulang dengan filter chip saat ini.
  int customersReloadNonce = 0;

  Map<String, dynamic>? _overview;
  List<dynamic> _customers = [];
  Map<String, dynamic>? _settlement;
  Map<String, dynamic>? _me;
  List<Map<String, dynamic>> _collectorAreas = [];

  /// Query terakhir yang sukses untuk daftar pelanggan (sinkron tab / strip ringkasan).
  String _lastCustomersFetchStatus = '';
  String _lastCustomersFetchArea = '';
  String _lastCustomersFetchQ = '';

  String? _overviewError;
  String? _customersError;
  String? _settlementError;
  String? _meError;

  bool _overviewLoading = false;
  bool _customersLoading = false;
  bool _settlementLoading = false;
  bool _meLoading = false;

  /// Periode aktif (dashboard) — dipakai overview, pelanggan, dan setoran.
  int? _overviewMonth;
  int? _overviewYear;

  DateTime? _overviewFetchedAt;
  String? _overviewFetchedKey;
  bool _collectorAreasLoaded = false;

  /// Hanya respons dari request terakhir yang boleh mengganti daftar pelanggan.
  int _customersRequestId = 0;
  String? _customersLatestQuery;
  final Map<String, List<dynamic>> _customersCache = {};

  final Map<String, Map<String, dynamic>> _overviewCache = {};

  /// Request yang sedang berjalan per kunci; pemanggil kedua menunggu future yang sama.
  final Map<String, Future<void>> _inflight = {};

  /// Pemilik cache overview di disk (tenant + user) agar tidak tertukar antar akun.
  String? _diskCacheOwner;

  Future<void> _once(
    String key,
    Future<void> Function() run, {
    bool reuse = true,
  }) {
    final existing = _inflight[key];
    if (reuse && existing != null) return existing;
    late final Future<void> future;
    future = run().whenComplete(() {
      if (identical(_inflight[key], future)) _inflight.remove(key);
    });
    _inflight[key] = future;
    return future;
  }

  Map<String, dynamic>? get overview => _overview;
  List<dynamic> get customers => _customers;
  Map<String, dynamic>? get settlement => _settlement;
  Map<String, dynamic>? get me => _me;
  List<Map<String, dynamic>> get collectorAreas => _collectorAreas;
  String get lastCustomersFetchStatus => _lastCustomersFetchStatus;
  String get lastCustomersFetchArea => _lastCustomersFetchArea;
  String get lastCustomersFetchQ => _lastCustomersFetchQ;

  String? get overviewError => _overviewError;
  String? get customersError => _customersError;
  String? get settlementError => _settlementError;
  String? get meError => _meError;

  bool get overviewLoading => _overviewLoading;
  bool get customersLoading => _customersLoading;
  bool get settlementLoading => _settlementLoading;
  bool get meLoading => _meLoading;

  int? get overviewMonth => _overviewMonth;
  int? get overviewYear => _overviewYear;

  /// Bersihkan cache kolektor saat logout (cegah data tenant lain).
  void clear() {
    customersReloadNonce++;
    _overview = null;
    _customers = [];
    _settlement = null;
    _me = null;
    _collectorAreas = [];
    _lastCustomersFetchStatus = '';
    _lastCustomersFetchArea = '';
    _lastCustomersFetchQ = '';
    _overviewError = null;
    _customersError = null;
    _settlementError = null;
    _meError = null;
    _overviewLoading = false;
    _customersLoading = false;
    _settlementLoading = false;
    _meLoading = false;
    _overviewMonth = null;
    _overviewYear = null;
    _overviewFetchedAt = null;
    _overviewFetchedKey = null;
    _collectorAreasLoaded = false;
    _customersRequestId++;
    _customersLatestQuery = null;
    _customersCache.clear();
    _overviewCache.clear();
    _inflight.clear();
    _diskCacheOwner = null;
    unawaited(_deleteDiskOverview());
    notifyListeners();
  }

  Future<File> _diskOverviewFile() async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}/collector_overview_cache.json');
  }

  Future<void> _deleteDiskOverview() async {
    try {
      final f = await _diskOverviewFile();
      if (await f.exists()) await f.delete();
    } catch (_) {}
  }

  Future<void> _saveDiskOverview(int? month, int? year) async {
    final owner = _diskCacheOwner;
    final data = _overview;
    if (owner == null || data == null) return;
    try {
      final f = await _diskOverviewFile();
      await f.writeAsString(
        jsonEncode({
          'owner': owner,
          'month': month,
          'year': year,
          'data': data,
        }),
      );
    } catch (_) {}
  }

  /// Tampilkan overview terakhir dari disk selagi request ke server berjalan.
  Future<void> restoreOverviewFromDisk({
    required String owner,
    required int month,
    required int year,
  }) async {
    _diskCacheOwner = owner;
    try {
      final f = await _diskOverviewFile();
      if (!await f.exists()) return;
      final decoded = jsonDecode(await f.readAsString());
      if (decoded is! Map ||
          decoded['owner'] != owner ||
          decoded['month'] != month ||
          decoded['year'] != year ||
          decoded['data'] is! Map) {
        return;
      }
      if (_overview != null) return;
      _overview = Map<String, dynamic>.from(decoded['data'] as Map);
      _overviewCache['$month/$year'] = _overview!;
      _overviewMonth ??= month;
      _overviewYear ??= year;
      notifyListeners();
    } catch (_) {}
  }

  List<String> _periodQueryParts({int? month, int? year}) {
    final m = month ?? _overviewMonth;
    final y = year ?? _overviewYear;
    final q = <String>[];
    if (m != null) q.add(m == 0 ? 'month=all' : 'month=$m');
    if (y != null) q.add('year=$y');
    return q;
  }

  Future<void> setPeriodAndRefresh({
    required int month,
    required int year,
  }) async {
    _overviewMonth = month;
    _overviewYear = year;
    notifyListeners();
    // Dashboard dulu; setoran & pelanggan menyusul supaya tidak berebut server.
    await fetchOverview(month: month, year: year);
    unawaited(
      Future.wait([
        fetchSettlement(month: month, year: year),
        fetchCustomers(
          status: _lastCustomersFetchStatus,
          q: _lastCustomersFetchQ,
          area: _lastCustomersFetchArea,
          month: month,
          year: year,
        ),
      ]),
    );
  }

  Future<void> fetchOverview({int? month, int? year}) {
    final m = month ?? _overviewMonth;
    final y = year ?? _overviewYear;
    return _once('overview|$m/$y', () => _fetchOverview(m, y));
  }

  Future<void> _fetchOverview(int? m, int? y) async {
    final cached = _overviewCache['$m/$y'];
    if (cached != null && _overviewFetchedKey != '$m/$y') {
      _overview = cached;
    }
    _overviewLoading = true;
    _overviewError = null;
    notifyListeners();
    try {
      final q = _periodQueryParts(month: m, year: y);
      final path =
          '/api/mobile-adapter/collector/overview${q.isEmpty ? '' : '?${q.join('&')}'}';
      final r = await ApiClient.get(path);
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/overview',
      );
      // Periode sudah diganti selama request berjalan: simpan ke cache saja.
      final stale =
          _overviewMonth != null && (m != _overviewMonth || y != _overviewYear);
      if (r.statusCode == 200 && body['success'] == true) {
        final data = Map<String, dynamic>.from(body['data'] as Map);
        _overviewCache['$m/$y'] = data;
        if (!stale) {
          _overview = data;
          _overviewMonth = m;
          _overviewYear = y;
          _overviewFetchedAt = DateTime.now();
          _overviewFetchedKey = '$m/$y';
          unawaited(_saveDiskOverview(m, y));
        }
      } else if (!stale) {
        _overviewError = body['message']?.toString() ?? 'Gagal memuat';
      }
    } catch (e) {
      final stale =
          _overviewMonth != null && (m != _overviewMonth || y != _overviewYear);
      if (!stale) _overviewError = e.toString();
    } finally {
      _overviewLoading = _inflight.keys.any(
        (k) => k.startsWith('overview|') && k != 'overview|$m/$y',
      );
      notifyListeners();
    }
  }

  /// Muat ulang overview hanya jika periode berubah atau data sudah lebih dari [maxAge].
  Future<void> refreshOverviewIfStale({
    int? month,
    int? year,
    Duration maxAge = const Duration(seconds: 60),
  }) async {
    if (_overviewLoading) return;
    final key = '${month ?? _overviewMonth}/${year ?? _overviewYear}';
    final at = _overviewFetchedAt;
    if (_overview != null &&
        at != null &&
        _overviewFetchedKey == key &&
        DateTime.now().difference(at) < maxAge) {
      return;
    }
    await fetchOverview(month: month, year: year);
  }

  Future<void> fetchCollectorAreas({bool force = false}) async {
    if (_collectorAreasLoaded && !force) return;
    try {
      final r = await ApiClient.get('/api/mobile-adapter/collector/areas');
      final body = ApiClient.decodeJsonObject(r, debugLabel: 'collector/areas');
      if (r.statusCode == 200 && body['success'] == true) {
        final raw = body['data'];
        if (raw is List) {
          _collectorAreas = raw
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();
        } else {
          _collectorAreas = [];
        }
        _collectorAreasLoaded = true;
      } else {
        _collectorAreas = [];
      }
    } catch (_) {
      _collectorAreas = [];
    }
    notifyListeners();
  }

  Future<void> fetchCustomers({
    String status = '',
    String q = '',
    String area = '',
    int? month,
    int? year,
  }) {
    final params = <String>[];
    if (status.isNotEmpty) {
      params.add('status=${Uri.encodeComponent(status)}');
    }
    if (q.trim().isNotEmpty) params.add('q=${Uri.encodeComponent(q.trim())}');
    if (area.trim().isNotEmpty) {
      params.add('area=${Uri.encodeComponent(area.trim())}');
    }
    params.addAll(_periodQueryParts(month: month, year: year));
    final query = params.join('&');
    final isLatest = _customersLatestQuery == query;
    _customersLatestQuery = query;
    return _once(
      'customers|$query',
      () => _fetchCustomers(query, status: status, q: q, area: area),
      reuse: isLatest,
    );
  }

  Future<void> _fetchCustomers(
    String query, {
    required String status,
    required String q,
    required String area,
  }) async {
    final requestId = ++_customersRequestId;
    final cached = _customersCache[query];
    final sameQuery =
        status == _lastCustomersFetchStatus &&
        q.trim() == _lastCustomersFetchQ &&
        area.trim() == _lastCustomersFetchArea;
    if (cached != null) {
      _customers = cached;
      _lastCustomersFetchStatus = status;
      _lastCustomersFetchArea = area.trim();
      _lastCustomersFetchQ = q.trim();
    } else if (!sameQuery) {
      // Jangan tampilkan daftar filter lama selama filter baru dimuat.
      _customers = [];
    }
    _customersLoading = true;
    _customersError = null;
    notifyListeners();
    try {
      final path =
          '/api/mobile-adapter/collector/customers${query.isEmpty ? '' : '?$query'}';
      final r = await ApiClient.get(path);
      if (requestId != _customersRequestId) return;
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/customers',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        final raw = body['data'];
        if (raw is List) {
          _customers = List<dynamic>.from(raw);
          _customersCache[query] = _customers;
          _lastCustomersFetchStatus = status;
          _lastCustomersFetchArea = area.trim();
          _lastCustomersFetchQ = q.trim();
        } else {
          _customers = [];
          _customersError = 'Format data pelanggan tidak valid (bukan array).';
        }
        if (kDebugMode) {
          debugPrint(
            '[collector/customers] status=$status area="$area" q="$q" → ${_customers.length} baris',
          );
        }
      } else {
        _customersError = body['message']?.toString() ?? 'Gagal memuat';
      }
    } catch (e) {
      if (requestId != _customersRequestId) return;
      _customersError = e.toString();
    } finally {
      if (requestId == _customersRequestId) {
        _customersLoading = false;
        notifyListeners();
      }
    }
  }

  Future<void> fetchSettlement({int? month, int? year}) {
    final m = month ?? _overviewMonth;
    final y = year ?? _overviewYear;
    return _once('settlement|$m/$y', () => _fetchSettlement(m, y));
  }

  Future<void> _fetchSettlement(int? month, int? year) async {
    _settlementLoading = true;
    _settlementError = null;
    notifyListeners();
    try {
      final q = _periodQueryParts(month: month, year: year);
      final path =
          '/api/mobile-adapter/collector/settlement${q.isEmpty ? '' : '?${q.join('&')}'}';
      final r = await ApiClient.get(path);
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/settlement',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        _settlement = Map<String, dynamic>.from(body['data'] as Map);
      } else {
        _settlementError = body['message']?.toString() ?? 'Gagal memuat';
      }
    } catch (e) {
      _settlementError = e.toString();
    } finally {
      _settlementLoading = false;
      notifyListeners();
    }
  }

  void bumpCustomersReload() {
    customersReloadNonce++;
    _overviewFetchedAt = null;
    _customersCache.clear();
    notifyListeners();
  }

  /// Isolir manual (suspend layanan) untuk pelanggan di wilayah kolektor.
  Future<String?> collectorIsolirCustomer(
    int customerId, {
    String reason = 'Isolir manual oleh kolektor (peringatan)',
  }) async {
    try {
      final r = await ApiClient.post(
        '/api/mobile-adapter/collector/customer-isolir/$customerId',
        {'reason': reason},
      );
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/customer-isolir',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        bumpCustomersReload();
        return null;
      }
      return body['message']?.toString() ?? 'Gagal isolir';
    } catch (e) {
      return e.toString();
    }
  }

  /// Riwayat faktur tahun kalender berjalan (paid & unpaid) untuk detail pelanggan.
  Future<List<Map<String, dynamic>>> fetchCustomerInvoiceHistory(
    int customerId,
  ) async {
    try {
      final r = await ApiClient.get(
        '/api/mobile-adapter/collector/customer-invoice-history/$customerId',
      );
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/customer-invoice-history',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        final raw = body['data'];
        if (raw is List) {
          return raw
              .map((e) {
                if (e is Map) return Map<String, dynamic>.from(e);
                return <String, dynamic>{};
              })
              .where((m) => m.isNotEmpty)
              .toList();
        }
      }
    } catch (_) {}
    return [];
  }

  /// Sesi PPP online/offline — selaras dengan /admin/mikrotik (RADIUS atau Mikrotik).
  Future<Map<String, dynamic>> fetchCustomerPppSession(int customerId) async {
    try {
      final r = await ApiClient.get(
        '/api/mobile-adapter/collector/customer-ppp-session/$customerId',
      );
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/customer-ppp-session',
      );
      if (r.statusCode == 200 &&
          body['success'] == true &&
          body['data'] is Map) {
        return Map<String, dynamic>.from(body['data'] as Map);
      }
    } catch (_) {}
    return {};
  }

  /// Tagihan belum lunas untuk pelanggan (kolektor yang sama wilayah).
  Future<List<Map<String, dynamic>>> fetchCustomerInvoices(
    int customerId,
  ) async {
    try {
      final r = await ApiClient.get(
        '/api/mobile-adapter/collector/customer-invoices/$customerId',
      );
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/customer-invoices',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        final raw = body['data'];
        if (raw is List) {
          return raw
              .map((e) {
                if (e is Map) return Map<String, dynamic>.from(e);
                return <String, dynamic>{};
              })
              .where((m) => m.isNotEmpty)
              .toList();
        }
      }
    } catch (_) {
      /* caller shows empty / message */
    }
    return [];
  }

  Future<void> fetchMe() => _once('me', _fetchMe);

  Future<void> _fetchMe() async {
    _meLoading = true;
    _meError = null;
    notifyListeners();
    try {
      final r = await ApiClient.get('/api/mobile-adapter/collector/me');
      final body = ApiClient.decodeJsonObject(r, debugLabel: 'collector/me');
      if (r.statusCode == 200 && body['success'] == true) {
        _me = Map<String, dynamic>.from(body['data'] as Map);
      } else {
        _meError = body['message']?.toString() ?? 'Gagal memuat';
      }
    } catch (e) {
      _meError = e.toString();
    } finally {
      _meLoading = false;
      notifyListeners();
    }
  }

  /// Upload foto profil kolektor (JPEG/PNG base64) ke backend.
  Future<String?> updateCollectorPhotoBase64(String photoBase64) async {
    final payload = photoBase64.trim();
    if (payload.isEmpty) return 'Foto wajib diisi';
    try {
      final r = await ApiClient.post('/api/mobile-adapter/collector/me/photo', {
        'photo_base64': payload,
      });
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/me/photo',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        final photoUrl = body['data'] is Map
            ? (body['data'] as Map)['photo_url']?.toString()
            : null;
        if (photoUrl != null && photoUrl.trim().isNotEmpty && _me != null) {
          _me = {..._me!, 'photo_url': photoUrl};
          notifyListeners();
        }
        await _once('me', _fetchMe, reuse: false);
        return null;
      }
      return body['message']?.toString() ?? 'Gagal mengunggah foto';
    } catch (e) {
      return e.toString();
    }
  }

  /// Perbarui nomor HP pelanggan di wilayah kolektor.
  Future<String?> updateCustomerPhone(int customerId, String phone) async {
    try {
      final r = await ApiClient.patch(
        '/api/mobile-adapter/collector/customers/$customerId/phone',
        {'phone': phone},
      );
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/customers/phone',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        bumpCustomersReload();
        return null;
      }
      return body['message']?.toString() ?? 'Gagal menyimpan nomor HP';
    } catch (e) {
      return e.toString();
    }
  }

  /// Ubah jatuh tempo tagihan belum lunas.
  Future<String?> updateInvoiceDueDate(
    int customerId,
    int invoiceId,
    String dueDateYmd,
  ) async {
    try {
      final r = await ApiClient.patch(
        '/api/mobile-adapter/collector/customers/$customerId/invoices/$invoiceId/due-date',
        {'due_date': dueDateYmd},
      );
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/customers/due-date',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        return null;
      }
      return body['message']?.toString() ?? 'Gagal menyimpan jatuh tempo';
    } catch (e) {
      return e.toString();
    }
  }

  /// Simpan nama, alamat, email, nomor HP kolektor (Bearer).
  Future<String?> updateCollectorProfile({
    required String name,
    required String phone,
    String? email,
    String? address,
  }) async {
    try {
      final r = await ApiClient.put('/api/mobile-adapter/collector/me', {
        'name': name,
        'phone': phone,
        'email': email ?? '',
        'address': address ?? '',
      });
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/me/update',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        await _once('me', _fetchMe, reuse: false);
        return null;
      }
      return body['message']?.toString() ?? 'Gagal menyimpan';
    } catch (e) {
      return e.toString();
    }
  }
}
