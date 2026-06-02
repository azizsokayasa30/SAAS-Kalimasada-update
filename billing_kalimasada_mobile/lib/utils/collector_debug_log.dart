import 'package:flutter/foundation.dart';

/// Log navigasi/filter kolektor — hanya muncul di debug build (`flutter run`).
void collectorDbg(String message) {
  if (kDebugMode) {
    debugPrint('[Collector] $message');
  }
}
