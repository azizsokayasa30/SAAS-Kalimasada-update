import 'package:flutter/material.dart';

class TagLocationSummaryCards extends StatelessWidget {
  const TagLocationSummaryCards({
    super.key,
    required this.tagged,
    required this.untagged,
    required this.loading,
    this.onTapUntagged,
    this.onTapTagged,
  });

  final int tagged;
  final int untagged;
  final bool loading;
  final VoidCallback? onTapUntagged;
  final VoidCallback? onTapTagged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: _SlimCard(
            title: 'Belum Tag',
            count: untagged,
            loading: loading,
            icon: Icons.location_off_rounded,
            iconBg: const Color(0xFFFEF3C7),
            iconFg: const Color(0xFFB45309),
            valueColor: const Color(0xFFB45309),
            borderColor: const Color(0xFFFDE68A),
            onTap: onTapUntagged,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _SlimCard(
            title: 'Sudah Tag',
            count: tagged,
            loading: loading,
            icon: Icons.location_on_rounded,
            iconBg: const Color(0xFFDCFCE7),
            iconFg: const Color(0xFF15803D),
            valueColor: const Color(0xFF15803D),
            borderColor: const Color(0xFFBBF7D0),
            onTap: onTapTagged,
          ),
        ),
      ],
    );
  }
}

class _SlimCard extends StatelessWidget {
  const _SlimCard({
    required this.title,
    required this.count,
    required this.loading,
    required this.icon,
    required this.iconBg,
    required this.iconFg,
    required this.valueColor,
    required this.borderColor,
    this.onTap,
  });

  final String title;
  final int count;
  final bool loading;
  final IconData icon;
  final Color iconBg;
  final Color iconFg;
  final Color valueColor;
  final Color borderColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: borderColor),
          ),
          child: Row(
            children: [
              Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(
                  color: iconBg,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(icon, color: iconFg, size: 18),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 12,
                    color: Color(0xFF0F172A),
                  ),
                ),
              ),
              if (loading)
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Text(
                  '$count',
                  style: TextStyle(
                    fontWeight: FontWeight.w900,
                    fontSize: 18,
                    color: valueColor,
                    height: 1,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
