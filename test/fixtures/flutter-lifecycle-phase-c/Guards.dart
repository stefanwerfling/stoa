import 'package:flutter/material.dart';

class Guards extends StatefulWidget {
  const Guards({super.key});
  @override
  State<Guards> createState() => _GuardsState();
}

class _GuardsState extends State<Guards> {
  int _n = 0;
  bool _busy = false;

  Future<void> earlyReturn() async {
    await load();
    if (!mounted) return; // DOMINATING
    setState(() => _n++);
  }

  Future<void> blockExitContext() async {
    await load();
    if (!context.mounted || _busy) {
      _busy = false;
      return; // DOMINATING (block exits, `||`)
    }
    setState(() => _n++);
  }

  Future<void> insideIf() async {
    await load();
    if (mounted && _n > 0) {
      setState(() => _n++); // DOMINATING (inside `if (mounted && …)`)
    }
  }

  Future<void> elseOfNegated() async {
    await load();
    if (!mounted) {
      debugPrint('gone');
    } else {
      setState(() => _n++); // DOMINATING (else of `!mounted`)
    }
  }

  Future<void> ternary() async {
    await load();
    mounted ? setState(() => _n++) : null; // DOMINATING (?:)
  }

  Future<void> onlyMentioned() async {
    await load();
    if (mounted) {
      debugPrint('still here');
    }
    setState(() => _n++); // REPORT: non-dominating (mounted only mentioned)
  }

  Future<void> noExit() async {
    await load();
    if (!mounted) {
      debugPrint('gone'); // no return
    }
    setState(() => _n++); // REPORT: non-dominating (no exit)
  }

  Future<void> siblingBranch(bool a) async {
    await load();
    if (a) {
      if (!mounted) return;
    }
    setState(() => _n++); // REPORT: non-dominating (guard only on one path)
  }

  Future<void> guardBeforeAwait() async {
    if (!mounted) return;
    await load();
    setState(() => _n++); // REPORT: none (the guard precedes the await)
  }

  Future<void> breakInExit() async {
    for (var i = 0; i < 3; i++) {
      await load();
      if (!mounted) {
        break; // leaves the loop, not the function
      }
    }
    setState(() => _n++); // REPORT: non-dominating
  }

  Future<void> aliased() async {
    await load();
    final alive = mounted;
    if (!alive) return;
    setState(() => _n++); // SILENT: unknown (mounted via a variable)
  }

  Future<void> compared() async {
    await load();
    if (mounted == false) return;
    setState(() => _n++); // SILENT: unknown (`== false` not modelled)
  }

  Future<void> exclusive(bool ok) async {
    if (ok) {
      await load();
      if (!mounted) return;
      Navigator.of(context).pop();
    } else {
      setState(() => _n++); // SILENT: the await is in the other branch
    }
  }

  Future<void> load() async {}

  @override
  Widget build(BuildContext context) => Text('$_n');
}
