// No Flutter import at all: names alone never identify a framework widget.
import 'package:my_ui/widgets.dart';

Widget plain() => Column(children: [ListView(children: [Text('x')]), Padding(child: Expanded(child: Text('y')))]);
