import 'package:flutter/material.dart';

// Every marked widget throws a layout exception at runtime.
class Broken extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Padding(padding: EdgeInsets.zero, child: Expanded(child: Text('a'))), // PARENTDATA (Expanded in Padding)
      Stack(children: [Flexible(child: Text('b'))]), // PARENTDATA (Flexible in Stack)
      Row(children: [Positioned(top: 0, child: Text('c'))]), // PARENTDATA (Positioned in Row)
      Center(child: Positioned.fill(child: Text('d'))), // PARENTDATA (Positioned.fill in Center)
      ListView(children: [Text('e')]), // UNBOUNDED (ListView in Column)
      if (true) GridView.count(crossAxisCount: 2, children: []), // UNBOUNDED (through conditional)
      Row(children: [TextField(), Text('f')]), // TEXTFIELD (TextField in Row)
      SingleChildScrollView(child: ListView.builder(itemBuilder: (c, i) => Text('g'))), // NESTED
    ]);
  }
}

Widget nestedLists() => ListView(children: [
      Text('h'),
      ListView(children: [Text('i')]), // NESTED (ListView in ListView)
    ]);
