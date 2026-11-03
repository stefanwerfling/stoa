import 'package:flutter/material.dart';

// Phase A: decisions on argument VALUES (absent = framework default).
Widget values(bool wrap, Axis dir) => Column(children: [
      ListView(shrinkWrap: false, children: []), // FLAG: shrinkWrap false (literal)
      ListView(shrinkWrap: wrap, children: []), // silent: shrinkWrap unknown, same axis
      ListView(shrinkWrap: true, children: []), // silent: shrink-wrapped along the Column
      ListView(shrinkWrap: true, scrollDirection: Axis.horizontal, children: []), // FLAG: cross axis (height) unbounded
      ListView(scrollDirection: dir, children: []), // FLAG: shrinkWrap false (default) whatever the axis
      ListView(shrinkWrap: true, scrollDirection: dir, children: []), // silent: axis unknown
      Row(children: [ListView(shrinkWrap: true, children: [])]), // FLAG: vertical list in a Row, width unbounded
      Row(children: [ListView(shrinkWrap: true, scrollDirection: Axis.horizontal, children: [])]), // silent
      Flex(direction: Axis.vertical, children: [ListView(shrinkWrap: true, children: [])]), // silent
      Flex(direction: dir, children: [ListView(shrinkWrap: true, children: [])]), // silent: Flex axis unknown
      Flex(direction: dir, children: [ListView(children: [])]), // FLAG: shrinkWrap false
      PageView(children: []), // FLAG: PageView has no shrinkWrap
    ]);

Widget nested(Axis axis) => ListView(children: [
      SingleChildScrollView(child: ListView(shrinkWrap: false, children: [])), // FLAG (nested): shrinkWrap false
      SingleChildScrollView(child: ListView(shrinkWrap: true, children: [])), // silent
      SingleChildScrollView(scrollDirection: Axis.vertical, child: ListView(scrollDirection: Axis.vertical, children: [])), // FLAG (nested): explicit vertical
      SingleChildScrollView(scrollDirection: Axis.horizontal, child: ListView(shrinkWrap: true, children: [])), // FLAG (nested): cross axis
      SingleChildScrollView(scrollDirection: Axis.horizontal, child: ListView(shrinkWrap: true, scrollDirection: Axis.horizontal, children: [])), // silent
      SingleChildScrollView(scrollDirection: axis, child: ListView(shrinkWrap: true, children: [])), // silent: outer axis unknown
    ]);
