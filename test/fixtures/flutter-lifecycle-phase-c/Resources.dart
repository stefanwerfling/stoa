import 'dart:async';
import 'package:flutter/material.dart';

class EventBus {
  int listen(void Function() f) => 0; // an own listen() API
}

class Resources extends StatefulWidget {
  const Resources({super.key, this.controller, required this.stream});
  final TextEditingController? controller;
  final Stream<int> stream;
  @override
  State<Resources> createState() => _ResourcesState();
}

class _ResourcesState extends State<Resources> {
  final EventBus _bus = EventBus();
  StreamSubscription<int>? _typed;
  late final _untyped = widget.stream.listen((_) {});
  int _handle = 0;
  StreamSubscription<int>? _cancelled;
  late TextEditingController _external;
  late TextEditingController _owned;
  final FocusNode _focus = FocusNode();
  final ScrollController _scroll = ScrollController();
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _typed = widget.stream.listen((_) {}); // REPORT: StreamSubscription, never cancelled
    _handle = _bus.listen(() {}); // SILENT: own listen() into an int field
    _cancelled = widget.stream.listen((_) {}); // SILENT: cancelled
    _external = widget.controller ?? TextEditingController(); // SILENT: external ownership
    _owned = TextEditingController(); // REPORT: owned, never disposed
    _timer = Timer(const Duration(seconds: 1), () {}); // SILENT: cancelled, then nulled
  }

  @override
  void didUpdateWidget(Resources oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.controller != null) {
      _external = widget.controller!;
    }
  }

  @override
  void dispose() {
    _cancelled?.cancel();
    _focus.dispose();
    this._scroll.dispose();
    _timer
      ?..cancel();
    _timer = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text('$_handle $_untyped');
}
