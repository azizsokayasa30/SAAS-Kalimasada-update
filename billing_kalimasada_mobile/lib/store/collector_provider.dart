import 'package:flutter/foundation.dart'
    show ChangeNotifier, debugPrint, kDebugMode;
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
    notifyListeners();
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
    await Future.wait([
      fetchOverview(month: month, year: year),
      fetchSettlement(month: month, year: year),
      fetchCustomers(
        status: _lastCustomersFetchStatus,
        q: _lastCustomersFetchQ,
        area: _lastCustomersFetchArea,
        month: month,
        year: year,
      ),
    ]);
  }

  Future<void> fetchOverview({int? month, int? year}) async {
    _overviewLoading = true;
    _overviewError = null;
    notifyListeners();
    try {
      final m = month ?? _overviewMonth;
      final y = year ?? _overviewYear;
      final q = _periodQueryParts(month: m, year: y);
      final path =
          '/api/mobile-adapter/collector/overview${q.isEmpty ? '' : '?${q.join('&')}'}';
      final r = await ApiClient.get(path);
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/overview',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        _overview = Map<String, dynamic>.from(body['data'] as Map);
        _overviewMonth = m;
        _overviewYear = y;
      } else {
        _overviewError = body['message']?.toString() ?? 'Gagal memuat';
      }
    } catch (e) {
      _overviewError = e.toString();
    } finally {
      _overviewLoading = false;
      notifyListeners();
    }
  }

  Future<void> fetchCollectorAreas() async {
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
  }) async {
    _customersLoading = true;
    _customersError = null;
    notifyListeners();
    try {
      final params = <String>[];
      if (status.isNotEmpty) {
        params.add('status=${Uri.encodeComponent(status)}');
      }
      if (q.trim().isNotEmpty) params.add('q=${Uri.encodeComponent(q.trim())}');
      if (area.trim().isNotEmpty) {
        params.add('area=${Uri.encodeComponent(area.trim())}');
      }
      params.addAll(_periodQueryParts(month: month, year: year));
      final path =
          '/api/mobile-adapter/collector/customers${params.isEmpty ? '' : '?${params.join('&')}'}';
      final r = await ApiClient.get(path);
      final body = ApiClient.decodeJsonObject(
        r,
        debugLabel: 'collector/customers',
      );
      if (r.statusCode == 200 && body['success'] == true) {
        final raw = body['data'];
        if (raw is List) {
          _customers = List<dynamic>.from(raw);
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
      _customersError = e.toString();
    } finally {
      _customersLoading = false;
      notifyListeners();
    }
  }

  Future<void> fetchSettlement({int? month, int? year}) async {
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

  Future<void> fetchMe() async {
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
        await fetchMe();
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
        await fetchMe();
        return null;
      }
      return body['message']?.toString() ?? 'Gagal menyimpan';
    } catch (e) {
      return e.toString();
    }
  }
}
