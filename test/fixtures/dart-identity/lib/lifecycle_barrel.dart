import 'dart:async';
import 'ui.dart';

class BarrelPage extends StatefulWidget {
  const BarrelPage({super.key});
  @override
  State<BarrelPage> createState() => _BarrelPageState();
}

// State, TextEditingController (via the project barrel) and Timer (dart:async) resolve.
class _BarrelPageState extends State<BarrelPage> {
  final TextEditingController _name = TextEditingController();
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {});
  }

  @override
  Widget build(BuildContext context) => TextField(controller: _name);
}
