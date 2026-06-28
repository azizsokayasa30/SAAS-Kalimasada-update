import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../services/api_client.dart';
import 'dart:convert';
import 'customer_detail_screen.dart';
import '../widgets/odp_map_marker.dart';

class OdpDetailScreen extends StatefulWidget {
  final String odpId;

  const OdpDetailScreen({super.key, required this.odpId});

  @override
  State<OdpDetailScreen> createState() => _OdpDetailScreenState();
}

class _OdpDetailScreenState extends State<OdpDetailScreen> {
  bool isLoading = true;
  Map<String, dynamic>? odpData;
  List<dynamic> customers = [];

  @override
  void initState() {
    super.initState();
    _fetchOdpData();
  }

  Future<void> _fetchOdpData() async {
    setState(() => isLoading = true);
    try {
      final cacheBuster = DateTime.now().millisecondsSinceEpoch;
      final response = await ApiClient.get(
        '/api/mobile-adapter/odps/${widget.odpId}?t=$cacheBuster',
      );
      if (response.statusCode == 200) {
        final resData = jsonDecode(response.body);
        if (resData['success']) {
          setState(() {
            odpData = resData['data']['odp'];
            customers = resData['data']['customers'];
            isLoading = false;
          });
        } else {
          _showError(resData['message'] ?? 'Failed to load data');
        }
      } else {
        _showError('Server error: ${response.statusCode}');
      }
    } catch (e) {
      _showError('Connection error: $e');
    }
  }

  void _showError(String message) {
    setState(() => isLoading = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  void _showSuccess(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.green),
    );
  }

  void _showUpdateCapacityDialog() {
    final TextEditingController capacityController = TextEditingController(
      text: odpData?['capacity']?.toString() ?? '',
    );

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text(
          'Update Port Capacity',
          style: TextStyle(color: Color(0xFF070038)),
        ),
        content: TextField(
          controller: capacityController,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(
            labelText: 'New Capacity',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () async {
              Navigator.pop(context);
              final newCapacity = int.tryParse(capacityController.text);
              if (newCapacity == null || newCapacity <= 0) return;

              setState(() => isLoading = true);
              final response = await ApiClient.put(
                '/api/mobile-adapter/odps/${widget.odpId}/capacity',
                {'capacity': newCapacity},
              );

              final resData = jsonDecode(response.body);
              if (resData['success']) {
                _showSuccess(resData['message']);
                _fetchOdpData();
              } else {
                _showError(resData['message']);
              }
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF070038),
              foregroundColor: Colors.white,
            ),
            child: const Text('Update'),
          ),
        ],
      ),
    );
  }

  void _showAssignPortDialog() {
    final TextEditingController portNumberController = TextEditingController();
    int? selectedCustomerPk;

    showDialog(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          return AlertDialog(
            title: const Text(
              'Assign Port to Customer',
              style: TextStyle(color: Color(0xFF070038)),
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: portNumberController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'Port Number',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),
                Autocomplete<Map<String, dynamic>>(
                  optionsBuilder: (TextEditingValue textEditingValue) async {
                    if (textEditingValue.text.isEmpty) {
                      return const Iterable<Map<String, dynamic>>.empty();
                    }
                    try {
                      final q = Uri.encodeQueryComponent(textEditingValue.text);
                      final response = await ApiClient.get(
                        '/api/mobile-adapter/customers/search?q=$q',
                      );
                      if (response.statusCode == 200) {
                        final resData = jsonDecode(response.body);
                        if (resData['success']) {
                          return List<Map<String, dynamic>>.from(
                            resData['data'],
                          );
                        }
                      }
                    } catch (e) {
                      print('Search error: $e');
                    }
                    return const Iterable<Map<String, dynamic>>.empty();
                  },
                  displayStringForOption: (Map<String, dynamic> option) =>
                      '${option['name'] ?? ''}',
                  onSelected: (Map<String, dynamic> selection) {
                    final dynamic rawId = selection['id'];
                    final int? pk = rawId is int
                        ? rawId
                        : rawId is num
                        ? rawId.toInt()
                        : int.tryParse(rawId?.toString() ?? '');
                    setDialogState(() => selectedCustomerPk = pk);
                  },
                  fieldViewBuilder:
                      (
                        context,
                        textEditingController,
                        focusNode,
                        onFieldSubmitted,
                      ) {
                        return TextField(
                          controller: textEditingController,
                          focusNode: focusNode,
                          decoration: const InputDecoration(
                            labelText: 'Customer Name (Type to search)',
                            border: OutlineInputBorder(),
                          ),
                        );
                      },
                  optionsViewBuilder: (context, onSelected, options) {
                    return Align(
                      alignment: Alignment.topLeft,
                      child: Material(
                        elevation: 4.0,
                        child: SizedBox(
                          height: 200.0,
                          width: MediaQuery.of(context).size.width * 0.65,
                          child: ListView.builder(
                            padding: EdgeInsets.zero,
                            itemCount: options.length,
                            itemBuilder: (BuildContext context, int index) {
                              final option = options.elementAt(index);
                              return InkWell(
                                onTap: () => onSelected(option),
                                child: Padding(
                                  padding: const EdgeInsets.all(12.0),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        option['name'] ?? '',
                                        style: const TextStyle(
                                          fontWeight: FontWeight.bold,
                                        ),
                                      ),
                                      Text(
                                        'ID: ${option['id']?.toString() ?? '-'}${option['customer_id'] != null ? ' · ${option['customer_id']}' : ''}',
                                        style: const TextStyle(
                                          fontSize: 12,
                                          color: Colors.grey,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
                      ),
                    );
                  },
                ),
                if (selectedCustomerPk != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8.0),
                    child: Text(
                      'Pelanggan terpilih: ID $selectedCustomerPk',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                onPressed: () async {
                  final portNum = int.tryParse(portNumberController.text);
                  if (portNum == null || selectedCustomerPk == null) {
                    _showError(
                      'Isi nomor port dan pilih pelanggan dari daftar',
                    );
                    return;
                  }
                  Navigator.pop(dialogContext);

                  setState(() => isLoading = true);
                  final odpKey = odpData?['id']?.toString() ?? widget.odpId;
                  final response = await ApiClient.post(
                    '/api/mobile-adapter/odps/$odpKey/assign',
                    {
                      'port_number': portNum,
                      'customer_db_id': selectedCustomerPk,
                    },
                  );

                  final resData = jsonDecode(response.body);
                  if (resData['success']) {
                    _showSuccess(resData['message']);
                    _fetchOdpData();
                  } else {
                    _showError(resData['message'] ?? 'Gagal');
                  }
                },
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF070038),
                  foregroundColor: Colors.white,
                ),
                child: const Text('Assign'),
              ),
            ],
          );
        },
      ),
    );
  }

  void _showUpdateMenu() {
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFFFCF8FF),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16.0),
              child: Text(
                'ODP Port Actions',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF070038),
                ),
              ),
            ),
            ListTile(
              leading: const Icon(
                Icons.settings_input_component,
                color: Color(0xFF070038),
              ),
              title: const Text(
                'Update Kapasitas Port',
                style: TextStyle(
                  color: Color(0xFF070038),
                  fontWeight: FontWeight.bold,
                ),
              ),
              onTap: () {
                Navigator.pop(context);
                _showUpdateCapacityDialog();
              },
            ),
            ListTile(
              leading: const Icon(Icons.person_add, color: Color(0xFF070038)),
              title: const Text(
                'Pasangkan Port Ke Pelanggan',
                style: TextStyle(
                  color: Color(0xFF070038),
                  fontWeight: FontWeight.bold,
                ),
              ),
              onTap: () {
                Navigator.pop(context);
                _showAssignPortDialog();
              },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    const bgBackground = Color(0xFFFCF8FF);
    const textOnSurfaceVariant = Color(0xFF474551);

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
          'ODP INFORMATION',
          style: TextStyle(
            color: Colors.white,
            fontSize: 18,
            fontWeight: FontWeight.w900,
            letterSpacing: 1.5,
          ),
        ),
        centerTitle: true,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(color: Colors.white24, height: 1),
        ),
      ),
      body: isLoading
          ? const Center(child: CircularProgressIndicator())
          : odpData == null
          ? const Center(child: Text("ODP data not found"))
          : SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // ODP Overview
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF0EBFF),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: const Color(0xFFC8C4D3)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    odpData!['name'] ?? widget.odpId,
                                    style: const TextStyle(
                                      fontSize: 22,
                                      fontWeight: FontWeight.bold,
                                      color: Color(0xFF070038),
                                    ),
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 4),
                                  Row(
                                    children: [
                                      const Icon(
                                        Icons.location_on,
                                        size: 18,
                                        color: textOnSurfaceVariant,
                                      ),
                                      const SizedBox(width: 4),
                                      Expanded(
                                        child: Text(
                                          '${odpData!['latitude'] ?? '-'}, ${odpData!['longitude'] ?? '-'}',
                                          style: const TextStyle(
                                            fontSize: 16,
                                            color: textOnSurfaceVariant,
                                          ),
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 6,
                              ),
                              decoration: BoxDecoration(
                                color: const Color(0xFFE4DFFF),
                                borderRadius: BorderRadius.circular(16),
                                border: Border.all(
                                  color: const Color(0xFF787582),
                                ),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(
                                    odpData!['status'] == 'active'
                                        ? Icons.check_circle
                                        : Icons.warning,
                                    size: 16,
                                    color: odpData!['status'] == 'active'
                                        ? const Color(0xFF166534)
                                        : const Color(0xFFBA1A1A),
                                  ),
                                  const SizedBox(width: 4),
                                  Text(
                                    (odpData!['status'] ?? 'UNKNOWN')
                                        .toString()
                                        .toUpperCase(),
                                    style: TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.bold,
                                      color: odpData!['status'] == 'active'
                                          ? const Color(0xFF166534)
                                          : const Color(0xFFBA1A1A),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 16),
                        Container(
                          height: 250,
                          width: double.infinity,
                          decoration: BoxDecoration(
                            color: const Color(0xFFE4DFFF),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: const Color(0xFFC8C4D3)),
                          ),
                          clipBehavior: Clip.antiAlias,
                          child:
                              (odpData!['latitude'] != null &&
                                  odpData!['longitude'] != null)
                              ? FlutterMap(
                                  options: MapOptions(
                                    initialCenter: LatLng(
                                      double.tryParse(
                                            odpData!['latitude'].toString(),
                                          ) ??
                                          -7.404620,
                                      double.tryParse(
                                            odpData!['longitude'].toString(),
                                          ) ??
                                          109.724536,
                                    ),
                                    initialZoom: 16.0,
                                  ),
                                  children: [
                                    TileLayer(
                                      urlTemplate:
                                          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                                      userAgentPackageName:
                                          'com.example.billing_kalimasada_mobile',
                                    ),
                                    MarkerLayer(
                                      markers: [
                                        Marker(
                                          point: LatLng(
                                            double.tryParse(
                                                  odpData!['latitude']
                                                      .toString(),
                                                ) ??
                                                -7.404620,
                                            double.tryParse(
                                                  odpData!['longitude']
                                                      .toString(),
                                                ) ??
                                                109.724536,
                                          ),
                                          width: 28,
                                          height: 33,
                                          alignment: Alignment.topCenter,
                                          child: OdpMapMarker(
                                            status:
                                                (odpData!['status'] ?? 'active')
                                                    .toString(),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                )
                              : const Center(
                                  child: Text(
                                    'Lokasi tidak tersedia',
                                    style: TextStyle(
                                      color: Color(0xFF474551),
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                ),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 32),

                  // Port Capacity Grid
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        'Port Capacity (${odpData!['capacity']})',
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                          color: Color(0xFF070038),
                        ),
                      ),
                      Row(
                        children: [
                          _buildLegendItem(const Color(0xFF166534), 'ACT'),
                          const SizedBox(width: 16),
                          _buildLegendItem(const Color(0xFFC8C4D3), 'AVL'),
                        ],
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),

                  GridView.count(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    crossAxisCount: 8,
                    mainAxisSpacing: 8,
                    crossAxisSpacing: 8,
                    children: List.generate(odpData!['capacity'] ?? 8, (index) {
                      final portNumber = index + 1;
                      final bool isUsed = customers.any(
                        (c) => c['port_number'] == portNumber,
                      );
                      if (isUsed) {
                        return _buildActivePort('P$portNumber');
                      } else {
                        return _buildAvailablePort('P$portNumber');
                      }
                    }),
                  ),

                  const SizedBox(height: 16),

                  OutlinedButton.icon(
                    onPressed: _showUpdateMenu,
                    icon: const Icon(Icons.edit, color: Color(0xFF070038)),
                    label: const Text(
                      'Update Port Status',
                      style: TextStyle(
                        color: Color(0xFF070038),
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    style: OutlinedButton.styleFrom(
                      backgroundColor: const Color(0xFFFCF8FF),
                      side: const BorderSide(
                        color: Color(0xFF070038),
                        width: 2,
                      ),
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ),

                  const SizedBox(height: 32),

                  // Connected Customers
                  const Text(
                    'Connected Customers',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF070038),
                    ),
                  ),
                  const SizedBox(height: 8),
                  if (customers.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(16.0),
                      child: Text(
                        'No customers connected to this ODP yet.',
                        style: TextStyle(color: textOnSurfaceVariant),
                      ),
                    )
                  else
                    Container(
                      decoration: BoxDecoration(
                        color: const Color(0xFFF6F1FF),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFC8C4D3)),
                      ),
                      child: Column(
                        children: customers.asMap().entries.map((entry) {
                          int idx = entry.key;
                          var c = entry.value;
                          return Column(
                            children: [
                              InkWell(
                                onTap: () {
                                  Navigator.push(
                                    context,
                                    MaterialPageRoute(
                                      builder: (context) =>
                                          CustomerDetailScreen(customer: c),
                                    ),
                                  );
                                },
                                child: _buildCustomerItem(
                                  'P${c['port_number']}',
                                  c['name'] ?? '-',
                                  c['customer_id'] ?? '-',
                                ),
                              ),
                              if (idx < customers.length - 1)
                                const Divider(
                                  color: Color(0xFFC8C4D3),
                                  height: 1,
                                ),
                            ],
                          );
                        }).toList(),
                      ),
                    ),

                  const SizedBox(height: 48),
                ],
              ),
            ),
    );
  }

  Widget _buildLegendItem(Color color, String label) {
    return Row(
      children: [
        Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.bold,
            color: Color(0xFF474551),
          ),
        ),
      ],
    );
  }

  Widget _buildActivePort(String label) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFFFCF8FF),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: const Color(0xFFC8C4D3)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          Container(height: 4, color: const Color(0xFF166534)),
          Expanded(
            child: Center(
              child: Text(
                label,
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFF070038),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAvailablePort(String label) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(4),
        border: Border.all(
          color: const Color(0xFF787582),
          style: BorderStyle.solid,
        ),
      ),
      child: Center(
        child: Text(
          label,
          style: const TextStyle(fontSize: 11, color: Color(0xFF787582)),
        ),
      ),
    );
  }

  Widget _buildCustomerItem(String port, String name, String id) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Container(
                width: 32,
                height: 32,
                decoration: const BoxDecoration(
                  color: Color(0xFF1B0C6B),
                  shape: BoxShape.circle,
                ),
                child: Center(
                  child: Text(
                    port,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF070038),
                    ),
                  ),
                  Text(
                    id,
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF474551),
                    ),
                  ),
                ],
              ),
            ],
          ),
          const Icon(Icons.chevron_right, color: Color(0xFF787582)),
        ],
      ),
    );
  }
}
