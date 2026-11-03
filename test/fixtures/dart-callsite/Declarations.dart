import 'package:flutter/material.dart';
import 'package:flutter/widgets.dart' as w show Text, Icon hide Row;
import 'heavy.dart' deferred as heavy;
import 'stub.dart' if (dart.library.io) 'io.dart' if (dart.library.html) 'web.dart';
export 'src/barrel.dart' show Header hide Footer;
part 'part_file.dart';

// Declarations that DartDeclarations must read (see test/DartCallSite.test.ts).
abstract class Base<T> extends w.StatelessWidget with Alpha, Beta<int> implements Gamma, Delta {}

class Header extends StatefulWidget {}

class _HeaderState extends State<Header> {}

class Plain {}

mixin Tracking on m.ChangeNotifier implements Disposable {}

enum Mode { light, dark }
