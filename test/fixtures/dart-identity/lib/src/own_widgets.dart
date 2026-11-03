import 'package:flutter/widgets.dart';

// An own widget that re-uses a framework name.
class Padding extends StatelessWidget {
  const Padding({super.key, this.child});
  final Widget? child;
  @override
  Widget build(BuildContext context) => child ?? const SizedBox();
}

class FancyCard extends StatelessWidget {
  const FancyCard({super.key});
  @override
  Widget build(BuildContext context) => const SizedBox();
}
