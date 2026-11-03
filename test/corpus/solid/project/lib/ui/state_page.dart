import 'package:flutter/material.dart';
import '../model/item.dart';
import '../state/app_state.dart';

// negative: a state holder and a plain model are intended dependencies
class StatePage extends StatelessWidget {
  const StatePage({super.key});

  AppState create() => AppState();

  Item first() => Item('a');

  @override
  Widget build(BuildContext context) => const Placeholder();
}
