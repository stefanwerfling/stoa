import 'package:flutter/material.dart';

// The same misplaced widget twice in one build(), and again in a second
// class's build() in the same file: three findings, three identities.
class First extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Padding(padding: EdgeInsets.zero, child: Expanded(child: Text('a'))), // build>Expanded#0
      Padding(padding: EdgeInsets.zero, child: Expanded(child: Text('b'))), // build>Expanded#1
    ]);
  }
}

class Second extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(child: Expanded(child: Text('c'))); // build>Expanded#2
  }
}
