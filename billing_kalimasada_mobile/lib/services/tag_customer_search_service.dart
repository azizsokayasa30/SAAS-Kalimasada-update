import 'dart:convert';

import '../services/api_client.dart';

/// Pencarian pelanggan untuk layar Tag Lokasi (teknisi & kolektor) dengan label area.
class TagCustomerSearchService {
  static String areaLabel(Map<String, dynamic> row, Map<int, String> areaById) {
    for (final key in ['area', 'nama_area', 'area_name', 'wilayah']) {
      final v = row[key]?.toString().trim() ?? '';
      if (v.isNotEmpty) return v;
    }
    final aid = row['area_id'];
    final intId = aid is int ? aid : int.tryParse(aid?.toString() ?? '');
    if (intId != null && areaById.containsKey(intId)) {
      return areaById[intId]!;
    }
    return '';
  }

  static Map<String, dynamic> enrichRow(
    Map<String, dynamic> row,
    Map<int, String> areaById,
  ) {
    final copy = Map<String, dynamic>.from(row);
    final label = areaLabel(copy, areaById);
    if (label.isNotEmpty) copy['area'] = label;
    return copy;
  }

  /// Muat peta id → nama area (abaikan jika server belum deploy rute ini).
  static Future<Map<int, String>> loadAreaNameMap() async {
    try {
      final response = await ApiClient.get('/api/mobile-adapter/areas/names');
      if (response.statusCode != 200) return {};
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (!ApiClient.jsonSuccess(data['success'])) return {};
      final raw = data['data'];
      if (raw is! List) return {};
      final map = <int, String>{};
      for (final item in raw) {
        if (item is! Map) continue;
        final id = item['id'];
        final name = item['nama_area']?.toString().trim() ?? '';
        final intId = id is int ? id : int.tryParse(id?.toString() ?? '');
        if (intId != null && intId > 0 && name.isNotEmpty) {
          map[intId] = name;
        }
      }
      return map;
    } catch (_) {
      return {};
    }
  }

  static Future<List<Map<String, dynamic>>> search({
    required String role,
    required String query,
    required Map<int, String> areaById,
  }) async {
    final enc = Uri.encodeQueryComponent(query);
    final path = role == 'collector'
        ? '/api/mobile-adapter/collector/customers?q=$enc'
        : '/api/mobile-adapter/customers/search?q=$enc';

    var hits = await _fetchList(path);
    if (role == 'collector' && hits.length > 30) {
      hits = hits.take(30).toList();
    }

    hits = hits.map((h) => enrichRow(h, areaById)).toList();

    if (role != 'collector' && hits.any((h) => areaLabel(h, areaById).isEmpty)) {
      hits = await _resolveMissingAreas(hits, areaById);
    }

    if (role != 'collector' && hits.any((h) => areaLabel(h, areaById).isEmpty)) {
      final merged = await _mergeAreaFromCustomersList(query, hits, areaById);
      if (merged.isNotEmpty) hits = merged;
    }

    return hits.map((h) => enrichRow(h, areaById)).toList();
  }

  static Future<List<Map<String, dynamic>>> _fetchList(String path) async {
    final response = await ApiClient.get(path);
    if (response.statusCode != 200) return [];
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    if (!ApiClient.jsonSuccess(data['success'])) return [];
    final raw = data['data'];
    if (raw is! List) return [];
    return raw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
  }

  static Future<List<Map<String, dynamic>>> _resolveMissingAreas(
    List<Map<String, dynamic>> hits,
    Map<int, String> areaById,
  ) async {
    final out = hits.map((h) => Map<String, dynamic>.from(h)).toList();
    final missingIds = <int>[];
    for (final row in out) {
      if (areaLabel(row, areaById).isNotEmpty) continue;
      final id = row['id'];
      final intId = id is int ? id : int.tryParse(id?.toString() ?? '');
      if (intId != null && intId > 0) missingIds.add(intId);
    }
    if (missingIds.isEmpty) return out;

    try {
      final response = await ApiClient.post(
        '/api/mobile-adapter/customers/resolve-areas',
        {'ids': missingIds},
      );
      if (response.statusCode != 200) return out;
      final body = jsonDecode(response.body) as Map<String, dynamic>;
      if (!ApiClient.jsonSuccess(body['success'])) return out;
      final map = body['data'];
      if (map is! Map) return out;

      for (final row in out) {
        if (areaLabel(row, areaById).isNotEmpty) continue;
        final key = row['id']?.toString() ?? '';
        final area = map[key]?.toString().trim() ?? '';
        if (area.isNotEmpty) row['area'] = area;
      }
    } catch (_) {}

    return out;
  }

  /// Fallback bila server lama: `GET /customers?search=` (setelah deploy menyertakan kolom area).
  static Future<List<Map<String, dynamic>>> _mergeAreaFromCustomersList(
    String query,
    List<Map<String, dynamic>> hits,
    Map<int, String> areaById,
  ) async {
    final enc = Uri.encodeQueryComponent(query);
    final alt = await _fetchList(
      '/api/mobile-adapter/customers?page=1&limit=30&search=$enc',
    );
    if (alt.isEmpty) return hits;

    final areaByPk = <int, String>{};
    for (final row in alt) {
      final id = row['id'];
      final intId = id is int ? id : int.tryParse(id?.toString() ?? '');
      if (intId == null || intId < 1) continue;
      final label = areaLabel(row, areaById);
      if (label.isNotEmpty) areaByPk[intId] = label;
    }

    if (areaByPk.isEmpty) return hits;

    return hits.map((row) {
      final copy = Map<String, dynamic>.from(row);
      if (areaLabel(copy, areaById).isNotEmpty) return copy;
      final id = copy['id'];
      final intId = id is int ? id : int.tryParse(id?.toString() ?? '');
      if (intId != null && areaByPk.containsKey(intId)) {
        copy['area'] = areaByPk[intId];
      }
      return copy;
    }).toList();
  }
}
