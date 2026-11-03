import 'package:flutter/material.dart';
import 'src/own_controllers.dart';

class AmbiguousPage extends StatefulWidget {
  const AmbiguousPage({super.key});
  @override
  State<AmbiguousPage> createState() => _AmbiguousPageState();
}

// TextEditingController is provided by both imports: ambiguous, not reported.
class _AmbiguousPageState extends State<AmbiguousPage> {
  final TextEditingController _name = TextEditingController();

  @override
  Widget build(BuildContext context) => const SizedBox();
}
