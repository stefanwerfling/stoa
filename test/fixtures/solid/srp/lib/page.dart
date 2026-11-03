import 'package:flutter/widgets.dart';
import 'data/cache.dart';
import 'data/net.dart';

/// A framework subclass: `widget`, `setState`, … could link the groups invisibly → unknown.
class SplitPage extends StatelessWidget {
  final DiskCache _cache = DiskCache();
  final NetClient _net = NetClient();

  SplitPage({super.key});

  void store() {
    _cache.put('k', 'v');
  }

  Future<String> fetch() => _net.get('x');

  @override
  Widget build(BuildContext context) => const SizedBox();
}
