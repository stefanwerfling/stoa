import 'package:flutter/material.dart';
import 'package:my_app/disposer.dart';

// A project mixin may release the fields in its own dispose(): skipped.
class _MixedState extends State<StatefulWidget> with AutoDisposer {
  final _text = TextEditingController();
  @override
  Widget build(BuildContext context) => const SizedBox();
}

// A custom base state may release them: only direct `extends State<…>` is analysed.
class _BasedState extends BaseState<StatefulWidget> {
  final _text = TextEditingController();
}
