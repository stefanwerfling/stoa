import 'package:flutter/material.dart';

Widget build(int rank) => Column(children: [
      Text('before'),
      switch (rank) { 1 => Text('one'), _ => Text('other') },
    ]);
