import 'package:flutter/material.dart';
import '../data/api.dart';

// SOLID-DIP stage 1 (imports a project data-access module) and
// DIP-CONCRETE (reads the concrete singleton)
class ApiPage extends StatelessWidget {
  const ApiPage({super.key});

  Future<void> refresh() async => Api.instance.load('me');

  @override
  Widget build(BuildContext context) => const Placeholder();
}
