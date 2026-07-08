double? _parseCoord(dynamic value) {
  if (value == null) return null;
  if (value is num) return value.toDouble();
  final parsed = double.tryParse(value.toString().trim());
  return parsed;
}

bool customerHasLocationTag(Map<String, dynamic> row) {
  final lat = _parseCoord(row['latitude']);
  final lng = _parseCoord(row['longitude']);
  return lat != null && lng != null;
}

int _compareNames(Map<String, dynamic> a, Map<String, dynamic> b) {
  final nameA = (a['name']?.toString() ?? '').toLowerCase();
  final nameB = (b['name']?.toString() ?? '').toLowerCase();
  return nameA.compareTo(nameB);
}

/// Belum tag di atas, sudah tag di bawah; tie-breaker nama A-Z.
List<Map<String, dynamic>> sortTagSearchHits(List<Map<String, dynamic>> hits) {
  final sorted = hits.map((h) => Map<String, dynamic>.from(h)).toList();
  sorted.sort((a, b) {
    final aTagged = customerHasLocationTag(a);
    final bTagged = customerHasLocationTag(b);
    if (aTagged != bTagged) return aTagged ? 1 : -1;
    return _compareNames(a, b);
  });
  return sorted;
}

String formatCustomerCoordinates(Map<String, dynamic> row) {
  final lat = _parseCoord(row['latitude']);
  final lng = _parseCoord(row['longitude']);
  if (lat == null || lng == null) return '-';
  return '${lat.toStringAsFixed(6)}, ${lng.toStringAsFixed(6)}';
}
