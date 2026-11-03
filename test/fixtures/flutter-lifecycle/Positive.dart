import 'dart:async';
import 'package:flutter/material.dart';

class Broken extends StatefulWidget {
  const Broken();
  @override
  State<Broken> createState() => _BrokenState();
}

class _BrokenState extends State<Broken> with SingleTickerProviderStateMixin {
  final _text = TextEditingController(); // CONTROLLER (never disposed)
  late AnimationController _anim;
  final _released = ScrollController();
  Timer? _timer;
  StreamSubscription<int>? _sub;
  String label = '';

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(vsync: this)..repeat(); // CONTROLLER (cascade)
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {}); // SUBSCRIPTION (timer)
    _sub = Stream<int>.empty().listen((_) {}); // not a sole call: receiver is a call chain
    final theme = Theme.of(context); // INHERITED
    WidgetsBinding.instance.addPostFrameCallback((_) => MediaQuery.of(context)); // closure: fine
  }

  Future<void> load() async {
    final value = await Future.value('x');
    setState(() => label = value); // SETSTATE
  }

  @override
  void dispose() {
    _released.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ElevatedButton(
        onPressed: () async {
          await Future<void>.delayed(Duration.zero);
          setState(() {}); // SETSTATE (closure)
        },
        child: Text(label),
      );
}

class _SubState extends State<Broken> {
  late StreamSubscription<int> _events;
  final Stream<int> source = const Stream.empty();

  @override
  void initState() {
    super.initState();
    _events = source.listen((_) {}); // SUBSCRIPTION (listen, no dispose at all)
    final size = MediaQuery.sizeOf(context); // INHERITED (sizeOf)
  }

  @override
  Widget build(BuildContext context) => const SizedBox();
}
