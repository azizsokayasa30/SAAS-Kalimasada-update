import 'package:flutter/material.dart';

import '../utils/customer_location_tag_utils.dart';

class CustomerLocationTagBadge extends StatelessWidget {
  const CustomerLocationTagBadge({
    super.key,
    required this.row,
    this.compact = true,
  });

  final Map<String, dynamic> row;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final tagged = customerHasLocationTag(row);
    final bg = tagged ? const Color(0xFFDCFCE7) : const Color(0xFFFEF3C7);
    final fg = tagged ? const Color(0xFF15803D) : const Color(0xFFB45309);
    final label = tagged ? 'Sudah Tag' : 'Belum Tag';

    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: compact ? 8 : 10,
        vertical: compact ? 3 : 4,
      ),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: fg.withValues(alpha: 0.25)),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: compact ? 10 : 11,
          fontWeight: FontWeight.w700,
          color: fg,
          height: 1.1,
        ),
      ),
    );
  }
}
