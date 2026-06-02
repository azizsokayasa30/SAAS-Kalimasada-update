import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../store/task_provider.dart';
import '../store/auth_provider.dart';
import 'new_task_screen.dart';
import 'job_execution_screen.dart';
import 'task_detail_screen.dart';

class TaskListScreen extends StatefulWidget {
  final void Function(int index, {String? taskListFilter})? onNavigateToTab;

  /// `'Tiket'` | `'PSB'` | `'Semua'` — filter chip saat layar dibuka (mis. dari dashboard Gangguan).
  final String? initialTaskTypeFilter;

  const TaskListScreen({
    super.key,
    this.onNavigateToTab,
    this.initialTaskTypeFilter,
  });

  @override
  State<TaskListScreen> createState() => _TaskListScreenState();
}

class _TaskListScreenState extends State<TaskListScreen> {
  bool _isSearching = false;
  String _searchQuery = '';
  late String _selectedType; // 'Semua', 'Tiket', 'PSB'
  final TextEditingController _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    final init = widget.initialTaskTypeFilter;
    if (init == 'Tiket' || init == 'PSB' || init == 'Semua') {
      _selectedType = init!;
    } else {
      _selectedType = 'Semua';
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<TaskProvider>().fetchTasks();
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isTechnician = context.watch<AuthProvider>().role == 'technician';
    const bgBackground = Color(0xFFFCF8FF);
    const textOnSurface = Color(0xFF19163F);
    const textOnSurfaceVariant = Color(0xFF474551);

    return Scaffold(
      backgroundColor: bgBackground,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: _isSearching
            ? TextField(
                controller: _searchController,
                autofocus: true,
                style: const TextStyle(color: Color(0xFF19163F), fontSize: 16),
                cursorColor: Color(0xFF1B0C6B),
                decoration: const InputDecoration(
                  hintText: 'Cari tugas, pelanggan...',
                  hintStyle: TextStyle(color: Color(0xFF787582), fontSize: 14),
                  border: InputBorder.none,
                ),
                onChanged: (value) {
                  setState(() {
                    _searchQuery = value.toLowerCase();
                  });
                },
              )
            : const Text(
                'Tugas Saya',
                style: TextStyle(
                  color: Color(0xFF1B0C6B),
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
        centerTitle: !_isSearching,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Color(0xFF787582)),
          onPressed: () {
            if (_isSearching) {
              setState(() {
                _isSearching = false;
                _searchQuery = '';
                _searchController.clear();
              });
            } else {
              if (Navigator.canPop(context)) {
                Navigator.pop(context);
              } else if (widget.onNavigateToTab != null) {
                widget.onNavigateToTab!(0); // Go back to Dashboard tab
              }
            }
          },
        ),
        actions: [
          if (!_isSearching)
            IconButton(
              icon: const Icon(Icons.search, color: Color(0xFF787582)),
              onPressed: () {
                setState(() {
                  _isSearching = true;
                });
              },
            ),
          IconButton(
            icon: const Icon(Icons.filter_list, color: Color(0xFF787582)),
            onPressed: () {},
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(
            color: const Color(0xFFC8C4D3).withValues(alpha: 0.5),
            height: 1,
          ),
        ),
      ),
      body: Consumer<TaskProvider>(
        builder: (context, provider, child) {
          if (provider.loading && provider.tasks.isEmpty) {
            return const Center(child: CircularProgressIndicator());
          }

          var tasks = provider.tasks;

          if (_selectedType != 'Semua') {
            tasks = tasks.where((t) {
              final type = t['type']?.toString().toUpperCase() ?? '';
              if (_selectedType == 'Tiket') return type == 'TR';
              if (_selectedType == 'PSB') return type == 'INSTALL';
              return true;
            }).toList();
          }

          // Removed status filtering to synchronize with web dashboard which shows all tasks

          if (_searchQuery.isNotEmpty) {
            tasks = tasks.where((t) {
              final title = (t['title'] ?? '').toString().toLowerCase();
              final customer = (t['customer'] ?? '').toString().toLowerCase();
              final address = (t['address'] ?? '').toString().toLowerCase();
              return title.contains(_searchQuery) ||
                  customer.contains(_searchQuery) ||
                  address.contains(_searchQuery);
            }).toList();
          }

          return RefreshIndicator(
            onRefresh: () => provider.fetchTasks(refresh: true),
            child: SingleChildScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Daftar Tugas',
                          style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.bold,
                            color: textOnSurface,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${tasks.length} active work orders assigned to you.',
                          style: const TextStyle(
                            fontSize: 13,
                            color: textOnSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),

                  // Filters
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Row(
                      children: [
                        _buildFilterButton(
                          icon: Icons.tune,
                          label: 'FILTERS',
                          bgColor: const Color(0xFFEAE5FF),
                          textColor: textOnSurface,
                        ),
                        const SizedBox(width: 12),

                        PopupMenuButton<String>(
                          color: Colors.white,
                          surfaceTintColor: Colors.white,
                          onSelected: (String result) {
                            setState(() {
                              _selectedType = result;
                            });
                          },
                          itemBuilder: (BuildContext context) =>
                              <PopupMenuEntry<String>>[
                                const PopupMenuItem<String>(
                                  value: 'Semua',
                                  child: Text(
                                    'Semua',
                                    style: TextStyle(color: Colors.black),
                                  ),
                                ),
                                const PopupMenuItem<String>(
                                  value: 'Tiket',
                                  child: Text(
                                    'Tiket',
                                    style: TextStyle(color: Colors.black),
                                  ),
                                ),
                                const PopupMenuItem<String>(
                                  value: 'PSB',
                                  child: Text(
                                    'PSB',
                                    style: TextStyle(color: Colors.black),
                                  ),
                                ),
                              ],
                          child: _buildFilterButton(
                            label: _selectedType == 'Semua'
                                ? 'TIKET/PSB'
                                : _selectedType.toUpperCase(),
                            suffixIcon: Icons.arrow_drop_down,
                            bgColor: Colors.white,
                            textColor: textOnSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 10),

                  if (provider.error != null && tasks.isEmpty)
                    Center(
                      child: Text(
                        provider.error!,
                        style: const TextStyle(color: Colors.red),
                      ),
                    )
                  else if (tasks.isEmpty)
                    const Center(
                      child: Padding(
                        padding: EdgeInsets.all(20.0),
                        child: Text('Tidak ada tugas tersedia.'),
                      ),
                    )
                  else
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: Column(
                        children: tasks
                            .map((task) => _buildTaskCard(task))
                            .toList(),
                      ),
                    ),

                  const SizedBox(height: 64),
                ],
              ),
            ),
          );
        },
      ),

      floatingActionButton: isTechnician
          ? null
          : FloatingActionButton(
              onPressed: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (context) => const NewTaskScreen(),
                  ),
                );
              },
              backgroundColor: const Color(0xFF070038),
              foregroundColor: Colors.white,
              child: const Icon(Icons.add),
            ),
    );
  }

  Widget _buildFilterButton({
    IconData? icon,
    required String label,
    IconData? suffixIcon,
    required Color bgColor,
    required Color textColor,
  }) {
    return Container(
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: const Color(0xFF787582).withValues(alpha: 0.5),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16, color: textColor),
            const SizedBox(width: 6),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.bold,
              color: textColor,
              letterSpacing: 0.3,
            ),
          ),
          if (suffixIcon != null) ...[
            const SizedBox(width: 6),
            Icon(suffixIcon, size: 16, color: textColor),
          ],
        ],
      ),
    );
  }

  Widget _buildTaskCard(Map<String, dynamic> task) {
    final rawPriority = task['priority']?.toString().toUpperCase() ?? '';
    final priorityLabel = switch (rawPriority) {
      'HIGH' || 'CRITICAL' => 'URGENT',
      'MEDIUM' => 'MEDIUM',
      'LOW' || 'NORMAL' || '' => 'NORMAL',
      _ => rawPriority,
    };

    Color priorityColor;
    Color priorityBgColor;
    IconData priorityIcon;

    switch (rawPriority) {
      case 'HIGH':
      case 'CRITICAL':
        priorityColor = const Color(0xFF93000A);
        priorityBgColor = const Color(0xFFFFDAD6);
        priorityIcon = Icons.error;
        break;
      case 'MEDIUM':
        priorityColor = const Color(0xFF423A91);
        priorityBgColor = const Color(0xFFE4DFFF);
        priorityIcon = Icons.info;
        break;
      case 'LOW':
      case 'NORMAL':
      default:
        priorityColor = const Color(0xFF474551);
        priorityBgColor = const Color(0xFFEAE5FF); // surface-variant
        priorityIcon = Icons.check_circle;
        break;
    }

    final type = task['type']?.toString().toUpperCase() ?? '';
    final typeLabel = type == 'TR'
        ? 'TIKET GANGGUAN'
        : (task['sector']?.toString() ?? (type == 'INSTALL' ? 'PSB' : 'UMUM'));
    Color typeColor;
    Color typeBgColor;

    if (type == 'TR') {
      typeColor = const Color(0xFFBA1A1A); // Red
      typeBgColor = const Color(0xFFFFDAD6);
    } else if (type == 'INSTALL') {
      typeColor = const Color(0xFF146C2E); // Green
      typeBgColor = const Color(0xFFC4EECE);
    } else {
      typeColor = const Color(0xFF474551);
      typeBgColor = const Color(0xFFF0EBFF);
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFC8C4D3)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.02),
            blurRadius: 3,
            offset: const Offset(0, 1),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(width: 4, color: typeColor),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(10, 10, 10, 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Text(
                                'PRIORITAS',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w700,
                                  color: Color(0xFF474551),
                                ),
                              ),
                              const SizedBox(width: 6),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 6,
                                  vertical: 2,
                                ),
                                decoration: BoxDecoration(
                                  color: priorityBgColor,
                                  borderRadius: BorderRadius.circular(4),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(
                                      priorityIcon,
                                      size: 12,
                                      color: priorityColor,
                                    ),
                                    const SizedBox(width: 3),
                                    Text(
                                      priorityLabel,
                                      style: TextStyle(
                                        fontSize: 10,
                                        fontWeight: FontWeight.bold,
                                        color: priorityColor,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: typeBgColor,
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              typeLabel,
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                                color: typeColor,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        task['title']?.toString() ?? 'Tugas',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: Color(0xFF19163F),
                          height: 1.25,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(
                            Icons.apartment,
                            size: 14,
                            color: Color(0xFF787582),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  task['customer']?.toString() ??
                                      'Nama Pelanggan',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                    color: Color(0xFF19163F),
                                  ),
                                ),
                                Text(
                                  'ID: ${task['id']?.toString() ?? '-'}',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: Color(0xFF474551),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(
                            Icons.location_on,
                            size: 14,
                            color: Color(0xFF787582),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              task['address']?.toString() ??
                                  'Alamat tidak tersedia',
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 12,
                                color: Color(0xFF474551),
                                height: 1.3,
                              ),
                            ),
                          ),
                        ],
                      ),
                      if (task['phone'] != null) ...[
                        const SizedBox(height: 4),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Icon(
                              Icons.phone,
                              size: 14,
                              color: Color(0xFF787582),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                task['phone'].toString(),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: Color(0xFF474551),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                      const SizedBox(height: 8),
                      const Divider(height: 1, color: Color(0xFFE4DFFF)),
                      const SizedBox(height: 6),

                      // Action buttons based on priority
                      if (task['priority'] == 'HIGH')
                        SizedBox(
                          width: double.infinity,
                          child: ElevatedButton.icon(
                            onPressed: () {
                              final id = task['id']?.toString();
                              final type = task['type']?.toString();
                              if (id != null && type != null) {
                                context.read<TaskProvider>().updateTaskStatus(
                                  id,
                                  type,
                                  'mulai',
                                );
                              }
                              Navigator.push(
                                context,
                                MaterialPageRoute(
                                  builder: (context) =>
                                      JobExecutionScreen(task: task),
                                ),
                              ).then((_) {
                                if (context.mounted) {
                                  context.read<TaskProvider>().fetchTasks(
                                    refresh: true,
                                  );
                                }
                              });
                            },
                            icon: const Icon(
                              Icons.play_arrow,
                              color: Colors.white,
                              size: 18,
                            ),
                            label: const Text(
                              'Start Job',
                              style: TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.w600,
                                fontSize: 13,
                              ),
                            ),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFF070038),
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              minimumSize: const Size(0, 40),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                          ),
                        )
                      else if (task['priority'] == 'MEDIUM')
                        Row(
                          children: [
                            Expanded(
                              child: OutlinedButton(
                                onPressed: () {},
                                style: OutlinedButton.styleFrom(
                                  side: const BorderSide(
                                    color: Color(0xFF787582),
                                  ),
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 10,
                                  ),
                                  minimumSize: const Size(0, 40),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                ),
                                child: const Text(
                                  'Details',
                                  style: TextStyle(
                                    color: Color(0xFF19163F),
                                    fontWeight: FontWeight.w600,
                                    fontSize: 13,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: ElevatedButton.icon(
                                onPressed: () {
                                  final id = task['id']?.toString();
                                  final type = task['type']?.toString();
                                  if (id != null && type != null) {
                                    context
                                        .read<TaskProvider>()
                                        .updateTaskStatus(id, type, 'mulai');
                                  }
                                  Navigator.push(
                                    context,
                                    MaterialPageRoute(
                                      builder: (context) =>
                                          JobExecutionScreen(task: task),
                                    ),
                                  ).then((_) {
                                    if (context.mounted) {
                                      context.read<TaskProvider>().fetchTasks(
                                        refresh: true,
                                      );
                                    }
                                  });
                                },
                                icon: const Icon(
                                  Icons.play_arrow,
                                  color: Colors.white,
                                  size: 18,
                                ),
                                label: const Text(
                                  'Start',
                                  style: TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w600,
                                    fontSize: 13,
                                  ),
                                ),
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: const Color(0xFF070038),
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 10,
                                  ),
                                  minimumSize: const Size(0, 40),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        )
                      else
                        SizedBox(
                          width: double.infinity,
                          child: OutlinedButton(
                            onPressed: () {
                              Navigator.push(
                                context,
                                MaterialPageRoute(
                                  builder: (context) =>
                                      TaskDetailScreen(task: task),
                                ),
                              ).then((_) {
                                if (context.mounted) {
                                  context.read<TaskProvider>().fetchTasks(
                                    refresh: true,
                                  );
                                }
                              });
                            },
                            style: OutlinedButton.styleFrom(
                              side: const BorderSide(color: Color(0xFF787582)),
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              minimumSize: const Size(0, 40),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                            child: const Text(
                              'LIHAT',
                              style: TextStyle(
                                color: Color(0xFF19163F),
                                fontWeight: FontWeight.w600,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
