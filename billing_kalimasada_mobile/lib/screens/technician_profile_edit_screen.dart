import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../store/auth_provider.dart';

class TechnicianProfileEditScreen extends StatefulWidget {
  const TechnicianProfileEditScreen({super.key});

  @override
  State<TechnicianProfileEditScreen> createState() =>
      _TechnicianProfileEditScreenState();
}

class _TechnicianProfileEditScreenState
    extends State<TechnicianProfileEditScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _address;
  late final TextEditingController _email;
  late final TextEditingController _phone;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final u = context.read<AuthProvider>().user;
    _name = TextEditingController(text: u?['name']?.toString() ?? '');
    _address = TextEditingController(
      text: u?['address']?.toString() ?? u?['notes']?.toString() ?? '',
    );
    _email = TextEditingController(text: u?['email']?.toString() ?? '');
    _phone = TextEditingController(text: u?['phone']?.toString() ?? '');
  }

  @override
  void dispose() {
    _name.dispose();
    _address.dispose();
    _email.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    final err = await context.read<AuthProvider>().updateTechnicianProfile(
      name: _name.text.trim(),
      phone: _phone.text.trim(),
      email: _email.text.trim(),
      address: _address.text.trim(),
    );
    if (!mounted) return;
    setState(() => _saving = false);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
      return;
    }
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Profil berhasil diperbarui')));
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFFCF8FF),
      appBar: AppBar(
        backgroundColor: const Color(0xFF2563EB),
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text(
          'Pengaturan akun',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
        ),
        bottom: const PreferredSize(
          preferredSize: Size.fromHeight(1),
          child: Divider(height: 1),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextFormField(
                controller: _name,
                style: const TextStyle(color: Color(0xFF19163F), fontSize: 16),
                textCapitalization: TextCapitalization.words,
                decoration: _decoration('Nama lengkap', hint: 'Nama Anda'),
                validator: (v) {
                  if (v == null || v.trim().isEmpty) return 'Nama wajib diisi';
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _address,
                style: const TextStyle(color: Color(0xFF19163F), fontSize: 16),
                maxLines: 3,
                textCapitalization: TextCapitalization.sentences,
                decoration: _decoration('Alamat', hint: 'Alamat lengkap'),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _email,
                style: const TextStyle(color: Color(0xFF19163F), fontSize: 16),
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: _decoration('Email', hint: 'nama@email.com'),
                validator: (v) {
                  final t = v?.trim() ?? '';
                  if (t.isEmpty) return null;
                  if (!t.contains('@')) return 'Format email tidak valid';
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _phone,
                style: const TextStyle(color: Color(0xFF19163F), fontSize: 16),
                keyboardType: TextInputType.phone,
                decoration: _decoration('Nomor HP', hint: '08...'),
                validator: (v) {
                  if (v == null || v.trim().isEmpty) {
                    return 'Nomor HP wajib diisi';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _saving ? null : _save,
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF1B0C6B),
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
                child: _saving
                    ? const SizedBox(
                        height: 22,
                        width: 22,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Text('Simpan perubahan'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  InputDecoration _decoration(String label, {String? hint}) {
    return InputDecoration(
      labelText: label,
      hintText: hint,
      labelStyle: const TextStyle(color: Color(0xFF474551), fontSize: 14),
      hintStyle: const TextStyle(color: Color(0xFF787582), fontSize: 14),
      floatingLabelStyle: const TextStyle(
        color: Color(0xFF1B0C6B),
        fontWeight: FontWeight.w600,
      ),
      filled: true,
      fillColor: Colors.white,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Color(0xFFC8C4D3)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Color(0xFF1B0C6B), width: 1.5),
      ),
    );
  }
}
