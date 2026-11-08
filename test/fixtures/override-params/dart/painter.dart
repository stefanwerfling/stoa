import 'package:flutter/widgets.dart';

class Painter extends CustomPainter {
  // not reported: @override marker
  @override
  void paintAll(int a, int b, int c, int d, int e) {}

  // reported: no marker, external parent
  void sketch(int a, int b, int c, int d, int e) {}
}
