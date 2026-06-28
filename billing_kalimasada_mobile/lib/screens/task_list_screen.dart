import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../store/task_provider.dart';
import '../store/auth_provider.dart';
import 'add_trouble_ticket_screen.dart';
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
  String _selectedStatus = 'Semua'; // 'Semua', 'Aktif', 'Selesai'
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
      final tasks = context.read<TaskProvider>();
      tasks.fetchTasks();
      tasks.fetchTaskHistory();
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
    const primaryBlue = Color(0xFF2563EB);
    const bgBackground = Color(0xFFF6F9FF);
    const textOnSurface = Color(0xFF0F172A);
    const textOnSurfaceVariant = Color(0xFF475569);

    return Scaffold(
      backgroundColor: bgBackground,
      appBar: AppBar(
        backgroundColor: primaryBlue,
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: _isSearching
            ? TextField(
                controller: _searchController,
                autofocus: true,
                style: const TextStyle(color: Colors.white, fontSize: 16),
                cursorColor: Colors.white,
                decoration: const InputDecoration(
                  hintText: 'Cari tugas, pelanggan...',
                  hintStyle: TextStyle(color: Color(0xFFEAF2FF), fontSize: 14),
                  border: InputBorder.none,
                ),
                onChanged: (value) {
                  setState(() {
                    _searchQuery = value.toLowerCase();
                  });
                },
              )
            : const Text(
                'Tugas',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
        centerTitle: !_isSearching,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
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
              icon: const Icon(Icons.search, color: Colors.white),
              onPressed: () {
                setState(() {
                  _isSearching = true;
                });
              },
            ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(
            color: Colors.white.withValues(alpha: 0.14),
            height: 1,
          ),
        ),
      ),
      body: Consumer<TaskProvider>(
        builder: (context, provider, child) {
          if (provider.loading && provider.tasks.isEmpty) {
            return const Center(child: CircularProgressIndicator());
          }

          final activeTasks = provider.tasks.where(_isTaskActive).toList();
          final doneTasks = provider.historyTasks
              .where(_isTaskCompleted)
              .toList();
          final typedActiveCount = _filterBySelectedType(activeTasks).length;
          final typedDoneCount = _filterBySelectedType(doneTasks).length;
          var tasks = switch (_selectedStatus) {
            'Aktif' => activeTasks,
            'Selesai' => doneTasks,
            _ => [...activeTasks, ...doneTasks],
          };

          tasks = _filterBySelectedType(tasks);
          tasks.sort((a, b) => _taskCreatedAt(b).compareTo(_taskCreatedAt(a)));

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
            onRefresh: () async {
              setState(() {
                _selectedType = 'Semua';
                _selectedStatus = 'Semua';
              });
              await Future.wait([
                provider.fetchTasks(refresh: true),
                provider.fetchTaskHistory(refresh: true),
              ]);
            },
            child: SingleChildScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        Expanded(
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
                                switch (_selectedStatus) {
                                  'Aktif' =>
                                    '${tasks.length} tugas aktif belum dikerjakan.',
                                  'Selesai' =>
                                    '${tasks.length} tugas sudah selesai dikerjakan.',
                                  _ =>
                                    '${tasks.length} tugas aktif dan selesai.',
                                },
                                style: const TextStyle(
                                  fontSize: 13,
                                  color: textOnSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 10),
                        _buildCompactTypeFilterPill('PSB'),
                        const SizedBox(width: 6),
                        _buildCompactTypeFilterPill('Tiket'),
                      ],
                    ),
                  ),

                  const SizedBox(height: 8),

                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Row(
                      children: [
                        _buildStatusFilterPill('Aktif', typedActiveCount),
                        const SizedBox(width: 10),
                        _buildStatusFilterPill('Selesai', typedDoneCount),
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
                        child: Text(
                          'Tidak ada tugas tersedia.',
                          style: TextStyle(
                            color: textOnSurfaceVariant,
                            fontWeight: FontWeight.w600,
                          ),
                          textAlign: TextAlign.center,
                        ),
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

                  SizedBox(height: isTechnician ? 24 : 12),
                ],
              ),
            ),
          );
        },
      ),

      bottomNavigationBar: isTechnician ? null : _buildTaskActionBar(),
    );
  }

  Widget _buildCompactTypeFilterPill(String label) {
    final selected = _selectedType == label;
    const primaryBlue = Color(0xFF2563EB);
    return InkWell(
      borderRadius: BorderRadius.circular(999),
      onTap: () {
        setState(() {
          _selectedType = selected ? 'Semua' : label;
        });
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        height: 32,
        constraints: const BoxConstraints(minWidth: 62),
        padding: const EdgeInsets.symmetric(horizontal: 16),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? primaryBlue : Colors.white,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: selected ? primaryBlue : const Color(0xFFBFDBFE),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: selected ? Colors.white : primaryBlue,
          ),
        ),
      ),
    );
  }

  List<dynamic> _filterBySelectedType(List<dynamic> source) {
    if (_selectedType == 'Semua') return source;
    return source.where((t) {
      if (t is! Map) return false;
      final type = t['type']?.toString().toUpperCase() ?? '';
      if (_selectedType == 'Tiket') return type == 'TR';
      if (_selectedType == 'PSB') return type == 'INSTALL';
      return true;
    }).toList();
  }

  bool _isTaskActive(dynamic raw) {
    if (raw is! Map) return false;
    final status = raw['status']?.toString().toLowerCase().trim() ?? '';
    return !{
      'closed',
      'completed',
      'resolved',
      'done',
      'selesai',
      'cancelled',
      'canceled',
      'in_progress',
      'mulai',
    }.contains(status);
  }

  bool _isTaskCompleted(dynamic raw) {
    if (raw is! Map) return false;
    final status = raw['status']?.toString().toLowerCase().trim() ?? '';
    return {
      'closed',
      'completed',
      'resolved',
      'done',
      'selesai',
    }.contains(status);
  }

  String _taskCreatedAt(dynamic raw) {
    if (raw is! Map) return '';
    final createdAt = raw['created_at']?.toString() ?? '';
    if (createdAt.isNotEmpty) return createdAt;
    return raw['activity_at']?.toString() ?? '';
  }

  Widget _buildStatusFilterPill(String label, int count) {
    final selected = _selectedStatus == label;
    const primaryBlue = Color(0xFF2563EB);
    final color = label == 'Selesai' ? const Color(0xFF16A34A) : primaryBlue;
    return Expanded(
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: () => setState(() => _selectedStatus = label),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          height: 38,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? color : Colors.white,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: selected ? color : const Color(0xFFBFDBFE),
            ),
          ),
          child: Text(
            '$label ($count)',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: selected ? Colors.white : color,
              letterSpacing: 0.2,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildTaskActionBar() {
    const primaryBlue = Color(0xFF2563EB);
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: const Border(top: BorderSide(color: Color(0xFFE2E8F0))),
        boxShadow: [
          BoxShadow(
            color: primaryBlue.withValues(alpha: 0.10),
            blurRadius: 18,
            offset: const Offset(0, -8),
          ),
        ],
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
          child: Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: _openAddPsb,
                  icon: const Icon(Icons.person_add_alt_1_rounded, size: 18),
                  label: const Text('Tambah PSB'),
                  style: FilledButton.styleFrom(
                    backgroundColor: primaryBlue,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _openAddTicket,
                  icon: const Icon(Icons.confirmation_number_rounded, size: 18),
                  label: const Text('Tambah tiket'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: primaryBlue,
                    side: const BorderSide(color: primaryBlue, width: 1.2),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _openAddPsb() async {
    final provider = context.read<TaskProvider>();
    final created = await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (context) => const NewTaskScreen()),
    );
    if (mounted && created == true) {
      provider.fetchTasks(refresh: true);
      provider.fetchTaskHistory(refresh: true);
    }
  }

  Future<void> _openAddTicket() async {
    final created = await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (context) => const AddTroubleTicketScreen()),
    );
    if (mounted && created == true) {
      final provider = context.read<TaskProvider>();
      provider.fetchTasks(refresh: true);
      provider.fetchTaskHistory(refresh: true);
    }
  }

  Widget _buildTaskCard(Map<String, dynamic> task) {
    final isCompleted = _isTaskCompleted(task);
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
        priorityColor = const Color(0xFF1D4ED8);
        priorityBgColor = const Color(0xFFDBEAFE);
        priorityIcon = Icons.info;
        break;
      case 'LOW':
      case 'NORMAL':
      default:
        priorityColor = const Color(0xFF475569);
        priorityBgColor = const Color(0xFFEFF6FF); // surface-variant
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
      typeColor = const Color(0xFF2563EB);
      typeBgColor = const Color(0xFFEFF6FF);
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
                                  color: Color(0xFF475569),
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
                          color: Color(0xFF0F172A),
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
                            color: Color(0xFF64748B),
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
                                    color: Color(0xFF0F172A),
                                  ),
                                ),
                                Text(
                                  'ID: ${task['id']?.toString() ?? '-'}',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: Color(0xFF475569),
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
                            color: Color(0xFF64748B),
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
                                color: Color(0xFF475569),
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
                              color: Color(0xFF64748B),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                task['phone'].toString(),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: Color(0xFF475569),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                      const SizedBox(height: 8),
                      const Divider(height: 1, color: Color(0xFFDBEAFE)),
                      const SizedBox(height: 6),

                      // Action buttons based on priority
                      if (isCompleted)
                        SizedBox(
                          width: double.infinity,
                          child: OutlinedButton(
                            onPressed: () async {
                              final provider = context.read<TaskProvider>();
                              await Navigator.push(
                                context,
                                MaterialPageRoute(
                                  builder: (context) =>
                                      TaskDetailScreen(task: task),
                                ),
                              );
                              if (mounted) {
                                provider.fetchTasks(refresh: true);
                                provider.fetchTaskHistory(refresh: true);
                              }
                            },
                            style: OutlinedButton.styleFrom(
                              foregroundColor: const Color(0xFF0F172A),
                              side: const BorderSide(color: Color(0xFF93C5FD)),
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              minimumSize: const Size(0, 40),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                            child: const Text(
                              'LIHAT',
                              style: TextStyle(
                                color: Color(0xFF0F172A),
                                fontWeight: FontWeight.w600,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        )
                      else if (task['priority'] == 'HIGH')
                        SizedBox(
                          width: double.infinity,
                          child: ElevatedButton.icon(
                            onPressed: () async {
                              final provider = context.read<TaskProvider>();
                              final id = task['id']?.toString();
                              final type = task['type']?.toString();
                              if (id != null && type != null) {
                                provider.updateTaskStatus(id, type, 'mulai');
                              }
                              await Navigator.push(
                                context,
                                MaterialPageRoute(
                                  builder: (context) =>
                                      JobExecutionScreen(task: task),
                                ),
                              );
                              if (mounted) {
                                provider.fetchTasks(refresh: true);
                              }
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
                              backgroundColor: const Color(0xFF2563EB),
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
                                  foregroundColor: const Color(0xFF0F172A),
                                  side: const BorderSide(
                                    color: Color(0xFF93C5FD),
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
                                  'Detail',
                                  style: TextStyle(
                                    color: Color(0xFF0F172A),
                                    fontWeight: FontWeight.w600,
                                    fontSize: 13,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: ElevatedButton.icon(
                                onPressed: () async {
                                  final provider = context.read<TaskProvider>();
                                  final id = task['id']?.toString();
                                  final type = task['type']?.toString();
                                  if (id != null && type != null) {
                                    provider.updateTaskStatus(
                                      id,
                                      type,
                                      'mulai',
                                    );
                                  }
                                  await Navigator.push(
                                    context,
                                    MaterialPageRoute(
                                      builder: (context) =>
                                          JobExecutionScreen(task: task),
                                    ),
                                  );
                                  if (mounted) {
                                    provider.fetchTasks(refresh: true);
                                  }
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
                                  backgroundColor: const Color(0xFF2563EB),
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
                            onPressed: () async {
                              final provider = context.read<TaskProvider>();
                              await Navigator.push(
                                context,
                                MaterialPageRoute(
                                  builder: (context) =>
                                      TaskDetailScreen(task: task),
                                ),
                              );
                              if (mounted) {
                                provider.fetchTasks(refresh: true);
                              }
                            },
                            style: OutlinedButton.styleFrom(
                              foregroundColor: const Color(0xFF0F172A),
                              side: const BorderSide(color: Color(0xFF93C5FD)),
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              minimumSize: const Size(0, 40),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                            child: const Text(
                              'LIHAT',
                              style: TextStyle(
                                color: Color(0xFF0F172A),
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
