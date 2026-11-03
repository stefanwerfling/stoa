import 'package:flutter/material.dart';
import '../data/dup_a.dart';
import '../data/dup_b.dart';

class AmbiguousPage extends StatelessWidget {
  const AmbiguousPage({super.key});

  // Dup is exported by two libraries: ambiguous, never judged
  void make() => Dup();

  @override
  Widget build(BuildContext context) => const Placeholder();
}
