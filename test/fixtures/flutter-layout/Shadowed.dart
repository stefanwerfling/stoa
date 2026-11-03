import 'package:flutter/material.dart' hide Padding;

// A local Padding shadows the framework class; no claim about it.
class Padding extends StatelessWidget {
  final Widget child;
  const Padding({required this.child});
  @override
  Widget build(BuildContext context) => child;
}

Widget shadowed() => Column(children: [Padding(child: Expanded(child: Text('x')))]);
