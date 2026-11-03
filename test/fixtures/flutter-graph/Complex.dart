import 'package:flutter/material.dart';

class ComplexPage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Column(children: [
      if (flag) const Icon(Icons.home) else Text('off'),
      for (final x in xs) Text(x),
      ...items.map((e) => Text(e)),
      ...[Text('a'), Text('b')],
      _header(),
      widget.child,
      ListView.builder(itemCount: n, itemBuilder: (c, i) {
        if (i == 0) return Text('first');
        return ListTile(title: Text('$i'));
      }),
      ElevatedButton(
        onPressed: () => showDialog(context: context, builder: (c) => AlertDialog(title: Text('Hi'))),
        child: Text('Open'),
      ),
      Padding(padding: EdgeInsets.all(8), child: maybe ?? Text('fallback')),
      Container(child: null),
    ]);
  }

  Widget _header() => header;
}
