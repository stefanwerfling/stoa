import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'data/api.dart';

// the composition root (a library with a top-level main()): wiring concrete
// classes here is what dependency inversion asks for — no DIP hint
void main() => runApp(const RootApp());

class RootApp extends StatelessWidget {
  const RootApp({super.key});

  Future<void> warmUp() async {
    await http.get(Uri.parse('https://example.org'));
    await Api.instance.load('warm');
  }

  @override
  Widget build(BuildContext context) => const Placeholder();
}
