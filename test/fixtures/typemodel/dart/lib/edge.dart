import 'package:get/get.dart';
import 'base.dart';
import 'x1.dart';
import 'x2.dart';

class Amb extends Dup {}

class Ctrl extends GetxController {}

class Impl implements Base {
  @override
  void a() {}
}

class CycleA extends CycleB {}

class CycleB extends CycleA {}
