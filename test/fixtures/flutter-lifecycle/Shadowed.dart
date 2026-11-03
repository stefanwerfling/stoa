import 'package:flutter/material.dart' hide State;

// A local State class is not Flutter's: nothing is claimed.
abstract class State<T> {
  void setState(void Function() fn) {}
}

class _LocalState extends State<int> {
  final _text = TextEditingController();
  Future<void> load() async {
    await Future<void>.value();
    setState(() {});
  }
}
