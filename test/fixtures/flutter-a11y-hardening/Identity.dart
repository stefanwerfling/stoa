import 'package:flutter/material.dart' hide Image;
import 'package:my_ui/my_ui.dart';

// A project Image class (shadowing / not Flutter's) and a widget library without
// a Flutter import: nothing is claimed.
class Image extends StatelessWidget {
  const Image();
  @override
  Widget build(BuildContext context) => const SizedBox();
}

Widget identity() => Column(children: [const Image(), Image()]);
