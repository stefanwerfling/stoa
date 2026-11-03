import 'package:flutter/material.dart';
import 'package:flutter/widgets.dart' as w show Text;

// Every call-site shape DartCallSite must normalize (see test/DartCallSite.test.ts).
Widget build(List<String> items, bool flag) {
  return Column(children: [
    Text('bare'),
    const Text('const'),
    new Row(children: []),
    Image.asset('named.png'),
    const EdgeInsets.all(8),
    w.Text('prefixed'),
    const w.Text('const prefixed'),
    ValueListenableBuilder<int>(valueListenable: n, builder: (c, v, child) => Text('$v')),
    if (flag) Icon(Icons.home) else const SizedBox(),
    ...items.map((e) => Text(e)),
    Image.asset('chained.png').copyWith(),
  ]);
}
