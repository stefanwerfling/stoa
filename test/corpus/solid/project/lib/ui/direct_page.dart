import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

// SOLID-DIP stage 1: a UI library importing a data-access package itself
class DirectPage extends StatelessWidget {
  const DirectPage({super.key});

  Future<void> ping() async => http.get(Uri.parse('https://example.org'));

  @override
  Widget build(BuildContext context) => const Placeholder();
}
