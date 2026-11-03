import 'package:flutter/material.dart' hide Padding;

class Padding extends StatelessWidget {
  const Padding({super.key, this.padding, this.child});
  final Object? padding;
  final Widget? child;
  @override
  Widget build(BuildContext context) => child ?? const SizedBox();
}

Widget shadowed() => Padding(padding: EdgeInsets.zero, child: Expanded(child: Text('a')));
