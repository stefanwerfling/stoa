import 'package:flutter/material.dart';

Widget build() {
  return Column(children: [
    Image.network('u'),
    Image.asset('x', semanticLabel: 'Company logo'),
    Image(image: p, excludeFromSemantics: true),
    Image(image: q, excludeFromSemantics: false),
    IconButton(icon: Icon(Icons.add), onPressed: f),
    IconButton(icon: Icon(Icons.close), tooltip: 'Close', onPressed: f),
  ]);
}
