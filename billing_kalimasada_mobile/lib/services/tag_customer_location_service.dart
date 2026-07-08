import 'dart:convert';

import '../services/api_client.dart';

class TagCustomerLocationService {
  static Future<Map<String, int>> fetchLocationSummary() async {
    final response = await ApiClient.get(
      '/api/mobile-adapter/customers/location-summary',
    );
    if (response.statusCode != 200) {
      throw Exception('HTTP ${response.statusCode}');
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    if (!ApiClient.jsonSuccess(data['success'])) {
      throw Exception(data['message']?.toString() ?? 'Gagal memuat ringkasan');
    }
    final raw = data['data'];
    if (raw is! Map) return {'tagged': 0, 'untagged': 0, 'total': 0};
    return {
      'tagged': _intFrom(raw['tagged']) ?? 0,
      'untagged': _intFrom(raw['untagged']) ?? 0,
      'total': _intFrom(raw['total']) ?? 0,
    };
  }

  static Future<List<Map<String, dynamic>>> fetchCustomersByLocationStatus({
    required String role,
    required String locationStatus,
    int page = 1,
    int limit = 30,
    String search = '',
  }) async {
    final enc = Uri.encodeQueryComponent(search.trim());
    final status = locationStatus == 'untagged' ? 'untagged' : 'tagged';
    final path = role == 'collector'
        ? '/api/mobile-adapter/collector/customers?location_status=$status&q=$enc'
        : '/api/mobile-adapter/customers?page=$page&limit=$limit&location_status=$status&search=$enc';

    final response = await ApiClient.get(path);
    if (response.statusCode != 200) return [];
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    if (!ApiClient.jsonSuccess(data['success'])) return [];
    final raw = data['data'];
    if (raw is! List) return [];
    final list = raw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    if (role == 'collector' && search.trim().isEmpty) {
      final start = (page - 1) * limit;
      if (start >= list.length) return [];
      return list.skip(start).take(limit).toList();
    }
    return list;
  }

  @Deprecated('Use fetchCustomersByLocationStatus')
  static Future<List<Map<String, dynamic>>> fetchTaggedCustomers({
    required String role,
    int page = 1,
    int limit = 30,
    String search = '',
  }) {
    return fetchCustomersByLocationStatus(
      role: role,
      locationStatus: 'tagged',
      page: page,
      limit: limit,
      search: search,
    );
  }

  static int? _intFrom(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }
}
