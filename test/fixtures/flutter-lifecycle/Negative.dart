import 'dart:async';
import 'package:flutter/material.dart';

class Fine extends StatefulWidget {
  final TextEditingController? controller;
  const Fine({this.controller});
  @override
  State<Fine> createState() => _FineState();
}

class _FineState extends State<Fine> {
  late final TextEditingController _owned = widget.controller ?? TextEditingController(); // ownership unclear
  final _a = TextEditingController();
  final _b = FocusNode();
  final _c = ScrollController();
  Timer? _timer;
  String label = '';

  @override
  void initState() {
    super.initState();
    _timer = Timer(const Duration(seconds: 1), () {});
    final navigator = Navigator.of(context); // not an inherited lookup
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final theme = Theme.of(context); // allowed here
  }

  Future<void> load() async {
    setState(() => label = 'loading'); // before the await
    final value = await Future.value('x');
    if (!mounted) return;
    setState(() => label = value);
  }

  Future<void> other() async {
    await Future<void>.delayed(Duration.zero);
    if (context.mounted) setState(() {});
  }

  void sync() => setState(() {});

  @override
  void dispose() {
    _a.dispose();
    _releaseRest();
    super.dispose();
  }

  void _releaseRest() {
    for (final node in [_b]) {
      node.dispose();
    }
    _c.dispose();
    _timer?.cancel();
  }

  @override
  Widget build(BuildContext context) => Text(label);
}
