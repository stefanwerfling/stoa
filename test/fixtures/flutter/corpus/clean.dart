import 'package:flutter/material.dart';

Widget build() {
  return Column(children: [
    Image.asset('logo.png', semanticLabel: 'Company logo'),
    Image(image: decorative, excludeFromSemantics: true),
    IconButton(icon: Icon(Icons.close), tooltip: 'Close', onPressed: f),
  ]);
}
