import type {Fact} from '../../Types.js';
import {DartLibraryIndex, type ExternalAnswer, type ExternalLibraries} from '../../model/DartLibraryIndex.js';
import type {DartPackageMap} from './DartPackages.js';

/**
 * What the Flutter framework libraries export, for the names stoa's Flutter
 * rules ask about (Flutter quality track, Phase B). Each entry: the declaring
 * library below `package:flutter/` (the canonical ORIGIN — the same class
 * reached through material.dart and cupertino.dart is one declaration) and
 * which of the three umbrella libraries export it (`w` widgets.dart,
 * `m` material.dart, `c` cupertino.dart).
 *
 * Derived from the Flutter SDK 3.29.2 sources (export directives incl.
 * show/hide, followed transitively, plus class/mixin/enum declarations), not
 * from stoa's own parser — tree-sitter-dart 1.0.0 cannot parse most SDK files
 * (Dart 3 syntax). test/DartLibraryIndex.test.ts re-checks the entries against
 * a local SDK when one is installed.
 *
 * Answers: a catalogued name asked of one of the three libraries is either
 * exported (its origin) or provably `absent` (e.g. `TextField` from
 * widgets.dart); any other name or any other Flutter library is `unknown`
 * (opaque) — never guessed. `Timer` and `StreamSubscription` (Phase C) from
 * `dart:async` are the Dart SDK entries; Flutter does not re-export dart:async.
 */
export const FLUTTER_SDK_VERSION = '3.29.2';

const UMBRELLA: Readonly<Record<string, string>> = {
    'package:flutter/widgets.dart': 'w',
    'package:flutter/material.dart': 'm',
    'package:flutter/cupertino.dart': 'c'
};

/** name → [declaring library below package:flutter/, umbrella libraries exporting it]. */
export const FLUTTER_CATALOG: Readonly<Record<string, readonly [string, string]>> = {
    Align: ['src/widgets/basic.dart', 'wmc'],
    AnimatedPositioned: ['src/widgets/implicit_animations.dart', 'wmc'],
    AnimatedPositionedDirectional: ['src/widgets/implicit_animations.dart', 'wmc'],
    AnimationController: ['src/animation/animation_controller.dart', 'wmc'],
    AspectRatio: ['src/widgets/basic.dart', 'wmc'],
    Axis: ['src/painting/basic_types.dart', 'wmc'],
    Baseline: ['src/widgets/basic.dart', 'wmc'],
    Card: ['src/material/card.dart', 'm'],
    Center: ['src/widgets/basic.dart', 'wmc'],
    ClipOval: ['src/widgets/basic.dart', 'wmc'],
    ClipPath: ['src/widgets/basic.dart', 'wmc'],
    ClipRRect: ['src/widgets/basic.dart', 'wmc'],
    ClipRect: ['src/widgets/basic.dart', 'wmc'],
    ColoredBox: ['src/widgets/basic.dart', 'wmc'],
    Column: ['src/widgets/basic.dart', 'wmc'],
    ConstrainedBox: ['src/widgets/basic.dart', 'wmc'],
    CupertinoLocalizations: ['src/cupertino/localizations.dart', 'c'],
    CupertinoTheme: ['src/cupertino/theme.dart', 'c'],
    CustomScrollView: ['src/widgets/scroll_view.dart', 'wmc'],
    DecoratedBox: ['src/widgets/container.dart', 'wmc'],
    DefaultTextStyle: ['src/widgets/text.dart', 'wmc'],
    Directionality: ['src/widgets/basic.dart', 'wmc'],
    ExcludeSemantics: ['src/widgets/basic.dart', 'wmc'],
    Expanded: ['src/widgets/basic.dart', 'wmc'],
    FittedBox: ['src/widgets/basic.dart', 'wmc'],
    Flex: ['src/widgets/basic.dart', 'wmc'],
    Flexible: ['src/widgets/basic.dart', 'wmc'],
    FocusNode: ['src/widgets/focus_manager.dart', 'wmc'],
    FocusScopeNode: ['src/widgets/focus_manager.dart', 'wmc'],
    FractionallySizedBox: ['src/widgets/basic.dart', 'wmc'],
    GridView: ['src/widgets/scroll_view.dart', 'wmc'],
    IconButton: ['src/material/icon_button.dart', 'm'],
    IconTheme: ['src/widgets/icon_theme.dart', 'wmc'],
    Image: ['src/widgets/image.dart', 'wmc'],
    IndexedStack: ['src/widgets/basic.dart', 'wmc'],
    InputDecoration: ['src/material/input_decorator.dart', 'm'],
    IntrinsicHeight: ['src/widgets/basic.dart', 'wmc'],
    IntrinsicWidth: ['src/widgets/basic.dart', 'wmc'],
    LimitedBox: ['src/widgets/basic.dart', 'wmc'],
    ListView: ['src/widgets/scroll_view.dart', 'wmc'],
    Localizations: ['src/widgets/localizations.dart', 'wmc'],
    MaterialLocalizations: ['src/material/material_localizations.dart', 'm'],
    MediaQuery: ['src/widgets/media_query.dart', 'wmc'],
    Opacity: ['src/widgets/basic.dart', 'wmc'],
    Padding: ['src/widgets/basic.dart', 'wmc'],
    PageController: ['src/widgets/page_view.dart', 'wmc'],
    PageView: ['src/widgets/page_view.dart', 'wmc'],
    Positioned: ['src/widgets/basic.dart', 'wmc'],
    PositionedDirectional: ['src/widgets/basic.dart', 'wmc'],
    ReorderableListView: ['src/material/reorderable_list.dart', 'm'],
    RotatedBox: ['src/widgets/basic.dart', 'wmc'],
    Row: ['src/widgets/basic.dart', 'wmc'],
    ScaffoldMessenger: ['src/material/scaffold.dart', 'm'],
    ScrollController: ['src/widgets/scroll_controller.dart', 'wmc'],
    SearchController: ['src/material/search_anchor.dart', 'm'],
    Semantics: ['src/widgets/basic.dart', 'wmc'],
    SingleChildScrollView: ['src/widgets/single_child_scroll_view.dart', 'wmc'],
    SizedBox: ['src/widgets/basic.dart', 'wmc'],
    Spacer: ['src/widgets/spacer.dart', 'wmc'],
    Stack: ['src/widgets/basic.dart', 'wmc'],
    State: ['src/widgets/framework.dart', 'wmc'],
    StatefulWidget: ['src/widgets/framework.dart', 'wmc'],
    StatelessWidget: ['src/widgets/framework.dart', 'wmc'],
    TabController: ['src/material/tab_controller.dart', 'm'],
    TextEditingController: ['src/widgets/editable_text.dart', 'wmc'],
    TextField: ['src/material/text_field.dart', 'm'],
    TextFormField: ['src/material/text_form_field.dart', 'm'],
    Theme: ['src/material/theme.dart', 'm'],
    Tooltip: ['src/material/tooltip.dart', 'm'],
    TrackingScrollController: ['src/widgets/scroll_controller.dart', 'wmc'],
    Transform: ['src/widgets/basic.dart', 'wmc'],
    TransformationController: ['src/widgets/interactive_viewer.dart', 'wmc'],
    UnconstrainedBox: ['src/widgets/basic.dart', 'wmc'],
    Wrap: ['src/widgets/basic.dart', 'wmc']
};

const DART_ASYNC_NAMES: ReadonlySet<string> = new Set(['Timer', 'StreamSubscription']);

export const isFlutterOrigin = (origin: string | null): boolean => origin !== null && origin.startsWith('package:flutter/');

export const flutterLibraries: ExternalLibraries = (uri: string, name: string): ExternalAnswer => {
    if (uri === 'dart:async' && DART_ASYNC_NAMES.has(name)) {
        return {origin: 'dart:async'};
    }
    const umbrella = UMBRELLA[uri];
    const entry = Object.prototype.hasOwnProperty.call(FLUTTER_CATALOG, name) ? FLUTTER_CATALOG[name] : undefined;
    if (umbrella === undefined || entry === undefined) {
        return 'unknown';
    }
    return entry[1].includes(umbrella) ? {origin: `package:flutter/${entry[0]}`} : 'absent';
};

const NO_PACKAGES: DartPackageMap = new Map();

/**
 * A DartLibraryIndex over `facts` that knows the Flutter catalog. Without a
 * package map (a focused test, the file-local a11y extraction) `package:` URIs
 * of the project itself stay opaque; relative imports still resolve.
 */
export const flutterAwareIndex = (facts: readonly Fact[], packages: DartPackageMap = NO_PACKAGES): DartLibraryIndex => new DartLibraryIndex(facts, packages, flutterLibraries);
