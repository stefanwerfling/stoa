import 'package:flutter/material.dart';

// Valid layouts, or layouts whose correctness is not decidable from the graph.
class Fine extends StatelessWidget {
  final Widget header;
  const Fine(this.header);

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Expanded(child: ListView(children: [Text('a')])), // Expanded in Column, ListView in Expanded
      Row(children: [Expanded(child: TextField()), Spacer()]), // TextField wrapped, Spacer in Row
      Stack(children: [Positioned(top: 0, child: Text('b'))]), // Positioned in Stack
      ListView(shrinkWrap: true, children: [Text('c')]), // shrinkWrap
      SizedBox(height: 200, child: ListView(children: [])), // bounded
      MyWrapper(child: Expanded(child: Text('d'))), // unknown parent: may pass through
      header, // reference
      LayoutBuilder(builder: (c, box) => Expanded(child: Text('e'))), // through a builder
      SingleChildScrollView(scrollDirection: axis, child: ListView(shrinkWrap: true, children: [])), // axis unknown, shrinkWrap true
      SingleChildScrollView(child: ListView(shrinkWrap: true, children: [])), // shrinkWrap
      Expanded(child: ListView.builder(itemBuilder: (c, i) => ListView(children: []))), // inner via builder
      Flex(direction: Axis.vertical, children: [Expanded(child: Text('f'))]), // Flex
      Visibility(child: Expanded(child: Text('g'))), // component wrapper, not in the boxes set
    ]);
  }
}

class MyWrapper extends StatelessWidget {
  final Widget child;
  const MyWrapper({required this.child});
  @override
  Widget build(BuildContext context) => child;
}
