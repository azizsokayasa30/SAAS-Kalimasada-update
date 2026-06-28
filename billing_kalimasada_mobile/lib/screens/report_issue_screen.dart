import 'package:flutter/material.dart';

class ReportIssueScreen extends StatefulWidget {
  final String jobId;

  const ReportIssueScreen({super.key, required this.jobId});

  @override
  State<ReportIssueScreen> createState() => _ReportIssueScreenState();
}

class _ReportIssueScreenState extends State<ReportIssueScreen> {
  String? _selectedCategory;
  bool _isCritical = false;

  @override
  Widget build(BuildContext context) {
    const bgBackground = Color(0xFFFCF8FF);
    const textOnSurface = Color(0xFF19163F);
    const textOnSurfaceVariant = Color(0xFF474551);
    const primaryColor = Color(0xFF070038);

    return Scaffold(
      backgroundColor: bgBackground,
      appBar: AppBar(
        backgroundColor: const Color(0xFF2563EB),
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text(
          'Report Issue',
          style: TextStyle(
            color: Colors.white,
            fontSize: 22,
            fontWeight: FontWeight.bold,
          ),
        ),
        centerTitle: true,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(color: Colors.white24, height: 1),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Issue Category
            const Text(
              'Issue Category',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: textOnSurface,
              ),
            ),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              decoration: BoxDecoration(
                color: const Color(0xFFF0EBFF), // surface-container
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFF787582)), // outline
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: _selectedCategory,
                  hint: const Text('Select a category...'),
                  isExpanded: true,
                  icon: const Icon(
                    Icons.expand_more,
                    color: textOnSurfaceVariant,
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: 'hardware',
                      child: Text('Hardware Failure'),
                    ),
                    DropdownMenuItem(
                      value: 'refusal',
                      child: Text('Customer Refusal'),
                    ),
                    DropdownMenuItem(
                      value: 'access',
                      child: Text('Access Denied'),
                    ),
                    DropdownMenuItem(
                      value: 'wiring',
                      child: Text('Wiring Problem'),
                    ),
                    DropdownMenuItem(value: 'other', child: Text('Other')),
                  ],
                  onChanged: (value) {
                    setState(() {
                      _selectedCategory = value;
                    });
                  },
                ),
              ),
            ),
            const SizedBox(height: 24),

            // Description
            const Text(
              'Description',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: textOnSurface,
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              maxLines: 4,
              decoration: InputDecoration(
                hintText: 'Provide specific details about the problem...',
                hintStyle: const TextStyle(color: textOnSurfaceVariant),
                filled: true,
                fillColor: const Color(0xFFF0EBFF),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: Color(0xFF787582)),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: Color(0xFF787582)),
                ),
                focusedBorder: const OutlineInputBorder(
                  borderRadius: BorderRadius.all(Radius.circular(8)),
                  borderSide: BorderSide(color: primaryColor),
                ),
              ),
            ),
            const SizedBox(height: 24),

            // Attach Evidence
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: const [
                Text(
                  'Attach Evidence',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: textOnSurface,
                  ),
                ),
                Text(
                  'UP TO 3 PHOTOS',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    color: textOnSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: AspectRatio(
                    aspectRatio: 1,
                    child: InkWell(
                      onTap: () {},
                      child: Container(
                        decoration: BoxDecoration(
                          color: const Color(0xFFE4DFFF), // surface-variant
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(
                            color: const Color(0xFF787582),
                            style: BorderStyle.solid,
                          ), // dashed ideally
                        ),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: const [
                            Icon(
                              Icons.add_a_photo,
                              size: 32,
                              color: textOnSurfaceVariant,
                            ),
                            SizedBox(height: 8),
                            Text(
                              'ADD',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: textOnSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: AspectRatio(
                    aspectRatio: 1,
                    child: Container(
                      decoration: BoxDecoration(
                        color: const Color(0xFFF0EBFF),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFC8C4D3)),
                      ),
                      child: const Center(
                        child: Icon(
                          Icons.image,
                          size: 32,
                          color: textOnSurfaceVariant,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: AspectRatio(
                    aspectRatio: 1,
                    child: Container(
                      decoration: BoxDecoration(
                        color: const Color(0xFFF0EBFF),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFC8C4D3)),
                      ),
                      child: const Center(
                        child: Icon(
                          Icons.image,
                          size: 32,
                          color: textOnSurfaceVariant,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),

            // Urgency Level
            const Text(
              'Urgency Level',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: textOnSurface,
              ),
            ),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: const Color(0xFFE4DFFF), // surface-variant
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFC8C4D3)),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: InkWell(
                      onTap: () => setState(() => _isCritical = false),
                      child: Container(
                        height: 48,
                        decoration: BoxDecoration(
                          color: !_isCritical
                              ? Colors.white
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(4),
                          boxShadow: !_isCritical
                              ? [
                                  const BoxShadow(
                                    color: Colors.black12,
                                    blurRadius: 2,
                                  ),
                                ]
                              : null,
                          border: !_isCritical
                              ? Border.all(color: const Color(0xFFC8C4D3))
                              : null,
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(
                              Icons.info,
                              color: !_isCritical
                                  ? primaryColor
                                  : textOnSurfaceVariant,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              'Normal',
                              style: TextStyle(
                                color: !_isCritical
                                    ? primaryColor
                                    : textOnSurfaceVariant,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  Expanded(
                    child: InkWell(
                      onTap: () => setState(() => _isCritical = true),
                      child: Container(
                        height: 48,
                        decoration: BoxDecoration(
                          color: _isCritical
                              ? Colors.white
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(4),
                          boxShadow: _isCritical
                              ? [
                                  const BoxShadow(
                                    color: Colors.black12,
                                    blurRadius: 2,
                                  ),
                                ]
                              : null,
                          border: _isCritical
                              ? Border.all(color: const Color(0xFFC8C4D3))
                              : null,
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(
                              Icons.warning,
                              color: _isCritical
                                  ? const Color(0xFFBA1A1A)
                                  : textOnSurfaceVariant,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              'High (Critical)',
                              style: TextStyle(
                                color: _isCritical
                                    ? const Color(0xFFBA1A1A)
                                    : textOnSurfaceVariant,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 32),

            // Actions
            ElevatedButton.icon(
              onPressed: () {},
              icon: const Icon(Icons.send, color: Colors.white),
              label: const Text(
                'Escalate to Back Office',
                style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                ),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: primaryColor,
                minimumSize: const Size(double.infinity, 56),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
            ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: () {},
              icon: const Icon(
                Icons.save,
                color: Color(0xFF7E4990),
              ), // secondary
              label: const Text(
                'Save as Draft',
                style: TextStyle(
                  color: Color(0xFF7E4990),
                  fontWeight: FontWeight.bold,
                ),
              ),
              style: OutlinedButton.styleFrom(
                side: const BorderSide(color: Color(0xFF7E4990), width: 2),
                minimumSize: const Size(double.infinity, 56),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}
