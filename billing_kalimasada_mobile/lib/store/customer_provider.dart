import 'dart:convert';
import 'package:flutter/material.dart';
import '../services/api_client.dart';

class CustomerProvider extends ChangeNotifier {
  bool _loading = false;
  String? _error;
  List<dynamic> _customers = [];
  Map<String, dynamic> _stats = {};
  Map<String, dynamic> _connectionStats = {};
  List<String> _areaOptions = [];
  int? _listTotalCount;
  num? _listTotalAmount;
  bool _hasMore = true;
  int _page = 1;

  /// Naik tiap refresh; respons request lama diabaikan agar tidak menimpa daftar kosong / halaman salah.
  int _customersFetchGen = 0;

  bool get loading => _loading;
  String? get error => _error;
  List<dynamic> get customers => _customers;
  Map<String, dynamic> get stats => _stats;
  Map<String, dynamic> get connectionStats => _connectionStats;
  List<String> get areaOptions => _areaOptions;
  int? get listTotalCount => _listTotalCount;
  num? get listTotalAmount => _listTotalAmount;
  bool get hasMore => _hasMore;

  Future<void> fetchCustomers({
    bool refresh = false,
    String search = '',
    String? status,
    String? adminFilter,
    String? connectionFilter,
    String area = '',
    int? month,
    int? year,
  }) async {
    if (!refresh) {
      if (!_hasMore || _loading) return;
    }

    if (refresh) {
      _customersFetchGen++;
      _page = 1;
      _customers = [];
      _listTotalCount = null;
      _listTotalAmount = null;
      _hasMore = true;
    }

    final int gen = _customersFetchGen;

    _loading = true;
    _error = null;
    if (refresh) notifyListeners();

    try {
      final q = Uri.encodeQueryComponent(search);
      String url =
          '/api/mobile-adapter/customers?page=$_page&limit=20&search=$q';
      if (status != null && status.isNotEmpty) {
        url += '&status=$status';
      }
      if (adminFilter != null && adminFilter.isNotEmpty) {
        url += '&admin_filter=${Uri.encodeQueryComponent(adminFilter)}';
      }
      if (connectionFilter != null && connectionFilter.isNotEmpty) {
        url +=
            '&connection=${Uri.encodeQueryComponent(connectionFilter.trim())}';
      }
      if (area.trim().isNotEmpty) {
        url += '&area=${Uri.encodeQueryComponent(area.trim())}';
      }
      if (month != null) {
        url += month == 0 ? '&month=all' : '&month=$month';
      }
      if (year != null) {
        url += '&year=$year';
      }
      if (refresh) {
        url += '&_=${DateTime.now().millisecondsSinceEpoch}';
      }
      final response = await ApiClient.get(url);

      if (gen != _customersFetchGen) return;

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (ApiClient.jsonSuccess(data['success'])) {
          if (gen != _customersFetchGen) return;
          final raw = data['data'];
          final newCustomers = raw is List
              ? List<dynamic>.from(raw)
              : <dynamic>[];
          _customers.addAll(newCustomers);
          final summary = data['summary'];
          if (summary is Map) {
            _listTotalCount = _intFrom(summary['total_count']);
            _listTotalAmount = _numFrom(summary['total_amount']);
          }
          final connectionSummary = data['connection_summary'];
          if (connectionSummary is Map) {
            _connectionStats = {
              'online': _intFrom(connectionSummary['online']) ?? 0,
              'offline': _intFrom(connectionSummary['offline']) ?? 0,
              'total': _intFrom(connectionSummary['total']) ?? 0,
            };
          }
          final pagination = data['pagination'];
          if (pagination is Map) {
            final hasMoreRaw = pagination['hasMore'];
            _hasMore = hasMoreRaw is bool
                ? hasMoreRaw
                : _customers.length < (_intFrom(pagination['total']) ?? 0);
          } else {
            _hasMore = newCustomers.length >= 20;
          }
          _page++;
        } else {
          _error = data['message']?.toString();
        }
      } else {
        _error = 'Gagal memuat data pelanggan';
      }
    } catch (e) {
      if (gen == _customersFetchGen) {
        _error = 'Koneksi bermasalah: ${e.toString()}';
      }
    } finally {
      if (gen == _customersFetchGen) {
        _loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> fetchAreaOptions() async {
    try {
      final response = await ApiClient.get('/api/mobile-adapter/areas/names');
      if (response.statusCode != 200) return;
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (!ApiClient.jsonSuccess(data['success'])) return;
      final raw = data['data'];
      if (raw is! List) return;

      final areas = <String>{};
      for (final item in raw) {
        if (item is! Map) continue;
        final area = item['nama_area']?.toString().trim() ?? '';
        if (area.isNotEmpty) areas.add(area);
      }
      _areaOptions = areas.toList()
        ..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
      notifyListeners();
    } catch (e) {
      // Abaikan agar daftar pelanggan tetap bisa dibuka meski endpoint area belum tersedia.
    }
  }

  int? _intFrom(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.round();
    return int.tryParse(value?.toString() ?? '');
  }

  num? _numFrom(dynamic value) {
    if (value is num) return value;
    return num.tryParse(value?.toString() ?? '');
  }

  /// Jangan set `_loading` di sini — dipakai untuk pagination `fetchCustomers`; memakai flag yang sama bikin refresh/macet.
  ///
  /// [bustCache] — tambahkan query unik agar pull-to-refresh tidak memakai respons cache (proxy/CDN) dan angka selalu diambil ulang.
  Future<void> fetchDashboardStats({bool bustCache = false}) async {
    try {
      final path = bustCache
          ? '/api/mobile-adapter/dashboard?_=${DateTime.now().millisecondsSinceEpoch}'
          : '/api/mobile-adapter/dashboard';
      final response = await ApiClient.get(path);
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (!ApiClient.jsonSuccess(data['success'])) return;

        final inner = data['data'];
        final statsWrap = inner is Map ? inner['stats'] : null;
        final statsData = statsWrap is Map<String, dynamic>
            ? statsWrap
            : (statsWrap is Map ? Map<String, dynamic>.from(statsWrap) : null);
        if (statsData != null) {
          num nz(dynamic v) {
            if (v is num) return v;
            return num.tryParse(v?.toString() ?? '') ?? 0;
          }

          _stats = {
            'total': nz(statsData['total_customers']).toInt(),
            'active': nz(statsData['active_customers']).toInt(),
            'suspended': nz(statsData['suspended_customers']).toInt(),
            'isolated': nz(statsData['isolated_customers']).toInt(),
          };
        }
      }
    } catch (e) {
      // Ignore or log error
    } finally {
      notifyListeners();
    }
  }

  Future<bool> restartConnection(String customerId) async {
    try {
      final response = await ApiClient.post(
        '/api/mobile-adapter/action/restart',
        {'customer_id': customerId},
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        return data['success'] == true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  Future<bool> updateLocation(
    String customerId,
    double latitude,
    double longitude, {
    int? odpId,
  }) async {
    try {
      final body = <String, dynamic>{
        'latitude': latitude,
        'longitude': longitude,
      };
      if (odpId != null && odpId > 0) {
        body['odp_id'] = odpId;
      }
      final response = await ApiClient.put(
        '/api/mobile-adapter/customers/$customerId/location',
        body,
      );
      debugPrint(
        'UPDATE LOCATION RES: ${response.statusCode} - ${response.body}',
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        return data['success'] == true;
      }
      if (response.statusCode == 409) {
        try {
          final data = jsonDecode(response.body);
          debugPrint(
            'UPDATE LOCATION CONFLICT: ${data['message']?.toString() ?? response.body}',
          );
        } catch (_) {}
      }
      return false;
    } catch (e) {
      debugPrint('UPDATE LOCATION ERROR: $e');
      return false;
    }
  }
}
