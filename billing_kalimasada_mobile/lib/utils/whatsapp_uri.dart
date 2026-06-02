import 'package:url_launcher/url_launcher.dart';

/// URI WhatsApp internasional (sama seperti fitur Chat di detail pelanggan).
String? waLaunchUri(String raw) {
  final digits = raw.replaceAll(RegExp(r'\D'), '');
  if (digits.isEmpty) return null;
  var n = digits;
  if (n.startsWith('0')) {
    n = '62${n.substring(1)}';
  } else if (!n.startsWith('62')) {
    n = '62$n';
  }
  return 'https://wa.me/$n';
}

/// Buka chat WhatsApp pelanggan — identik dengan tap Chat di detail pelanggan.
Future<bool> launchWhatsAppChat(String phone, {String? prefilledText}) async {
  final base = waLaunchUri(phone);
  if (base == null) return false;
  final uri = prefilledText != null && prefilledText.trim().isNotEmpty
      ? Uri.parse('$base?text=${Uri.encodeComponent(prefilledText.trim())}')
      : Uri.parse(base);
  return launchUrl(uri, mode: LaunchMode.externalApplication);
}
