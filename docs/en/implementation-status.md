# Implementation Status

> As of 2026-11-04. This page describes what is **actually implemented**. The
> other `docs/` documents describe the **design intent** (concept phase) and
> remain valid as rationale; where the implementation deviates, this page wins.
> The entries under "Realized architecture" form a **chronological log**
> (newest first). A statement such as "no rule reads it yet" is true as of
> that entry; later entries may supersede it. The overview below is the
> current state.

## Current state at a glance (2026-11-04)

**Implemented (with tests):**
- Language adapters: TypeScript/JavaScript, PHP, Dart/Flutter, C/C++, plus
  static markup extraction for HTML, JSX, Vue SFC and Angular templates.
- 40 declarative rules (`rules/default/*.json`) and the procedural project
  rules: `R-DEP-CYCLE` (always on), `R-UNUSED-EXPORT` (`--dead-exports`), the
  eight Flutter lifecycle/layout rules (always on, Dart only), the SOLID rules
  (`--solid`) and the validation-contract checks (`--contracts`). The table
  in the rule catalog below lists the declarative rules and part of the
  procedural ones; `docs/en/rule-model.md` has the full list.
- Semantic models, each built once per run and shared: `ModuleGraph`
  (resolved import edges, project config aware), `SymbolGraph` (the single
  ES-module name resolver: named/default/namespace imports, re-exports,
  external and unresolved bindings), `TypeModel` (declared types and
  supertypes, built lazily on first use), `DartLibraryIndex` and
  `FlutterWidgetGraph`. The SymbolGraph is built **only** when an active rule
  declares `usesTypeModel` (today: the SOLID LSP/ISP/DIP-concrete rules under
  `--solid`) or `usesSymbolGraph` (R-UNUSED-EXPORT under `--dead-exports`);
  otherwise it is not built at all.
- Memory-bounded pipeline with `coverage.status` `complete`/`partial`/`failed`
  and exit codes 0/2/1; per-file fact cache (`--cache`); opt-in parallel
  extraction on worker threads (`--jobs`); baseline/diff mode
  (`--baseline`, `--only-new`, `--update-baseline`), with a versioned
  finding-identity scheme and an explicit `--migrate-baseline`.
- Evaluator (`stoa eval`) with exit codes 0 = passed, 1 = failed or technical
  error, 2 = incomplete analysis. A finding identity (file + rule + symbol)
  that is produced twice is a rule defect and fails the evaluation;
  `--update-baseline` refuses to write such a baseline.
- Opt-in metrics (`--memory-stats`, `AnalyzeOptions.onMetrics`): file, fact,
  finding and graph counts, phase timings, peak RSS.

**Experimental (opt-in, few or no real-world hits):** the SOLID rules
(`R-SOLID-DIP-LAYER-DIRECTION`, `-LSP-CONTRACT-COMPATIBILITY`,
`-ISP-INTERFACE-COHESION`, `-DIP-CONCRETE-DEPENDENCY`). The SRP rule
(`R-SOLID-SRP-RESPONSIBILITY-COHESION`) is built and tested but deliberately
**not registered**.

**Heuristic only (risk signals, not proof):** `R-VALIDATION-MISSING-BACKEND`,
`R-VALIDATION-MASS-ASSIGNMENT` (name-based sinks), the validation dataflow
edges marked `heuristic`, `R-SOLID-DIP-LAYER-DIRECTION` (semantic-heuristic,
confidence 0.5), name-based persistence detection.

**Not implemented:** C/C++ include paths (`-I`); Dart edges in
`R-DEP-CYCLE`/`R-UNUSED-EXPORT` (Dart imports are extracted as
`dart.importSpec` and used by the ModuleGraph and the DIP layer rule, but the
two dependency rules read only TS/PHP/C/C++ edges); `R-UNUSED-EXPORT` for
PHP; a git-diff/PR mode; rendered (browser) accessibility checks; API-request/DTO
facts for an end-to-end FE/BE chain; validation on independent external
corpora.

**Known limitations (open):**
- Extraction dominates runtime and memory (see the measurement entry below).
  The TS adapter no longer wraps every token, builds no type checker for
  export questions, answers the per-kind node queries from one index per
  file and walks each function once (together ≈ −74 % extraction time, see
  "Fewer token walks", "One node index per file", "One walk per function")
  and releases an ES module by dropping its own Project ("Parse and
  release"); ranges come from a break table per file instead of a text scan
  per call ("Class members and source ranges"). The parse and ts-morph's
  wrapper creation (needed by the extraction's own navigation) remain.

**Tests and measurements:** see "Quality assurance" below and the dated
measurement entry "Measurement and memory profile". All numbers on this
page come from the curated corpora and fixtures in this repository or from
the named local projects; none is a general accuracy claim.

## Realized architecture

- **TypeScript core** (variant B), deterministic, runnable without an LLM.
- **Language adapters:** TypeScript/JavaScript (via `ts-morph` / the TS compiler
  API), **PHP** (via `php-parser`/glayzzle, fully in-process — no subprocess) and
  **Dart/Flutter** and **C/C++** (both via tree-sitter / `web-tree-sitter`,
  WASM, in-process; metric/complexity facts, error-handling for Dart and C++ —
  C has no try/catch). **C/C++ additionally gets two memory-safety rules**
  (`R-CPP-UNRELEASED-ALLOCATION`, `R-CPP-NEW-DELETE-MISMATCH` — see the rule
  table below) — the one place in the rule catalog where a language's own
  distinguishing risk (manual memory management) is covered, rather than only
  the language-neutral complexity/error-handling rules every adapter gets.
- **UI/UX adapter (HTML):** static accessibility analysis via tree-sitter-html
  (WASM, in-process). Purely static — no rendering and no CSS cascade. Text
  contrast is checked **only** from colours declared together on an element's
  inline style (a provable fact); cascade/rendered contrast stays out of scope
  (see limitations). The first vertical slice of the UI/UX area.
- **UI/UX (React/JSX):** the TypeScript adapter additionally walks JSX elements
  (ts-morph, same parse) and emits the same `ui.*` facts, so **11 of the a11y
  rules** fire on `.jsx/.tsx` intrinsic elements — including the name-computation
  rules (control/link name, form label) and contrast from `style={{…}}` object
  literals. Dynamic attribute values (`{expr}`) and
  dynamic children (`{label}`) are treated as present-but-unknown, a spread
  (`{...props}`) and a dynamic `id`/`type` suppress the relevant checks, and React
  components (`<Button/>`) are skipped — all to avoid false positives.
- **UI/UX (Vue SFC):** `.vue` templates are HTML-family markup (tree-sitter-html,
  shared parser), so **8 of the a11y rules** (the attribute-based ones + contrast)
  fire on the `<template>` section after normalising Vue bindings — `:x`/`v-bind:x`
  and `{{…}}` are present-but-unknown, `@x`/`v-on`/other `v-` directives are
  dropped, components and `<script>`/`<style>` are not analysed. The name-
  computation rules are not ported to templates yet.
- **UI/UX (Angular):** external `*.component.html` templates reuse the same
  template extraction with an Angular binding dialect — `[alt]`/`[attr.aria-label]`
  (and `bind-`) are present-but-unknown, `(event)`/`[(two-way)]`/`*ngIf`/`#ref` are
  dropped. The Angular adapter is registered before the HTML adapter so
  `.component.html` is not mistaken for plain HTML. Inline `template:` strings are
  not covered yet.
- **UI/UX (Flutter/Dart):** Flutter has no HTML/ARIA — accessibility is carried by
  widget properties. The Dart adapter therefore also walks the widget tree (the same
  tree-sitter parse) and emits three deliberately conservative, low-false-positive
  facts: an `Image*` built with neither `semanticLabel:` **nor**
  `excludeFromSemantics: true`, an `IconButton` built without `tooltip:`, and a
  `TextField`/`TextFormField` whose `InputDecoration` carries no label/hint (or which
  has no `decoration:` at all). The widget's **own** constructor arguments are
  inspected **plus** a wrapping `Semantics(label: …)` that names the subtree (a widget
  inside it is not flagged). A label on a child widget, a name via
  `Semantics(value:/hint:)`/`MergeSemantics`, or a decoration built elsewhere
  (variable, `copyWith`) is not resolved (noted in `missingContext`), so the checks
  stay conservative.
- **Dart foundations (Flutter analysis, Phase 0b):** `src/analysis/dart/DartCallSite.ts`
  normalizes every Dart call / instance-creation shape — a bare call (tree-sitter-dart
  has no call node: a primary identifier plus `selector` siblings), `const`/`new`,
  import prefixes (only when the file declares them via `import … as p`; `p.Foo(…)`
  vs `Foo.named(…)` is otherwise syntactically ambiguous), named constructors and
  type arguments — into one record, for the upcoming widget-structure extraction.
  Since Phase 4 also used by the Flutter a11y checks (see below).
  `file.parseErrors` (ERROR + MISSING nodes, emitted only when > 0) makes visible
  that tree-sitter-dart 1.0.0 does not know Dart 3 syntax (records, patterns,
  switch expressions, class modifiers): such a file still "parses", but parts of
  its tree are recovered. No rule reads the fact; coverage status is unchanged.
  The grammar also lacks enhanced enums (Dart 2.17: `enum E with M`, `implements`,
  enum constructors).
  `src/analysis/dart/DartDeclarations.ts` emits the inputs for later widget
  identity: `dart.importSpec` per library directive (`import`/`export`/`part`/
  `part-of`; URI, prefix, `deferred`, `show`/`hide`, configurable URIs) and
  `dart.classDecl` per class/mixin/enum (superclass with prefix and type
  arguments, mixins, interfaces, a mixin's `on`). A declaration whose header the
  grammar could not parse yields no fact rather than a possibly wrong name.
  Deliberately still no `deps.import` for Dart (it would put Dart files into
  R-DEP-CYCLE/R-DEP-UNUSED — a separate decision). `dart.*` facts are read for identity (widget graph, Flutter rules); `dart.stateLifecycle` by the lifecycle rules (Phase 3).
- **FlutterWidgetGraph (Flutter analysis, Phase 1):** `src/analysis/dart/FlutterWidgets.ts`
  extracts, during the one AST pass, the widget structure of every function/method
  body as one compact `ui.flutterWidgetTree` fact (node table: parent, slot label,
  index, kind, name/prefix/constructor, argument names, position, status — no source
  text). `src/model/FlutterWidgetGraph.ts` rebuilds the project-wide graph from facts
  alone after extraction (identical on a FactCache hit, which never re-parses) and
  hands it to project rules via `ProjectRuleInput.flutterWidgetGraph`; it is not part
  of `AnalysisResult`; the Flutter layout rules (Phase 2, below) read it. Node kinds: `widget`, `reference`
  (variable/helper call), `builder` (`*builder` closures, all `return` paths),
  `conditional` (`if`/ternary), `repeat` (`for`), `spread`, `list`, `dynamic`
  (unmodelled expression), `unparsed` (tree-sitter could not parse — e.g. Dart 3
  syntax; localized to the affected slot/element). Child edges follow only a curated
  catalog of widget slots (`child`, `children`, `body`, `appBar`, `title`, `actions`,
  …) and `*builder` closures; callbacks (`onTap:`) are not children — widgets built in
  them are roots. A root is a call outside any tree with a slot/builder argument, or
  what a `Widget`-returning function returns. Identity per widget: `verified`
  (declared in the same file), `heuristic` (import candidates by prefix/show/hide,
  listed), `unresolved` — never by name alone, and a Flutter class is never
  `verified` (no cross-file library index yet). Measured on a 203-file Flutter app:
  2733 nodes, tree facts 9.3 % of all facts, graph build ~16 ms, findings
  byte-identical.
- **Flutter layout rules (Flutter analysis, Phase 2):** four `ProjectRule`s in
  `src/rules/project/FlutterLayoutRules.ts`, the first consumers of the graph —
  `R-FLUTTER-PARENTDATA-MISUSE`, `R-FLUTTER-UNBOUNDED-SCROLLABLE`,
  `R-FLUTTER-TEXTFIELD-UNBOUNDED-WIDTH`, `R-FLUTTER-NESTED-SCROLL-UNBOUNDED`
  (runtime layout exceptions `flutter analyze` does not report). A widget counts
  as the framework widget only with `heuristic` identity and a `package:flutter/`
  import candidate (a same-file declaration shadows it). The effective parent is
  reached only through `conditional`/`repeat`/`spread`/`list`; anything else
  (builder, reference, `dynamic`, `unparsed`, root, custom parent) ends the walk
  without a finding. Argument values are not in the graph, so a rule depending on
  one (`scrollDirection`) stays silent when it is present. Dogfooded on four real
  Flutter apps (SwipeMeister, mwpa-app, velyo, movinder): 224 candidate widgets
  with a known parent, 0 findings — those layouts are correct; recall is shown
  only by fixtures (`test/FlutterLayout.test.ts`), plus one genuine error in the
  Phase-1 graph fixture (`ListView.builder` directly in a `Column`).
- **Widget argument values (Flutter quality track, Phase A):** `src/analysis/dart/DartValues.ts`
  is a reusable, bounded value model for Dart call arguments: literals (bool, null,
  int incl. hex, double incl. a leading `-`, plain strings up to 64 characters
  without interpolation/escapes), static member references (`Axis.vertical`,
  `double.infinity`), and constructor calls as objects one level deep
  (`BoxConstraints(maxHeight: 200)`, `EdgeInsets.all(8)`); everything else is
  explicitly unknown (`reference`, `expression`, `closure`, `widget`). The values are
  stored per widget node in `ui.flutterWidgetTree` (encoding v2, aligned with
  `argNames`) and read via `argValueOf(node, name)` — `undefined` means *absent*
  (framework default applies), which is distinct from unknown. Decision: the MODEL
  is reusable (not Flutter-specific); the STORAGE is the widget node, because
  separate per-argument facts would multiply the fact count and need a positional
  join, while the node already carries evidence and range. Cost on four real apps:
  tree facts +27 %, all facts +2.3 %; of 7857 named arguments, 49 % are literal,
  member or object values. `R-FLUTTER-UNBOUNDED-SCROLLABLE` and
  `R-FLUTTER-NESTED-SCROLL-UNBOUNDED` (1.1.0) now decide on these values: a
  viewport throws when `shrinkWrap` is false (written or default), or when its scroll
  axis is known to differ from the axis the parent leaves unbounded (a
  shrink-wrapping viewport still needs a bounded cross axis); an unknown value keeps
  the rule silent unless the error is certain anyway. Findings on the four apps
  unchanged (byte-identical); evidence now names the deciding values.
- **Identity resolution (Flutter quality track, Phase B):** `src/model/DartLibraryIndex.ts`
  resolves which DECLARATION `prefix.Name` refers to in a file — Dart-generic, from
  `dart.importSpec` + `dart.classDecl` facts: a declaration in the same library
  (incl. its `part` files) shadows every import; otherwise each import with that
  prefix whose `show`/`hide` permit the name is asked — a project library through its
  export namespace (own declarations + `export` directives, transitively,
  cycle-safe), an external one through an `ExternalLibraries` lookup. Status:
  `resolved` (exactly one distinct origin; uninspectable imports are listed as
  `possible` but cannot make it ambiguous in code that compiles), `ambiguous` (two
  or more origins — e.g. Material and an own `Padding`), `unresolved`. The same
  declaration reached through Material and a project barrel is one origin.
  `src/analysis/dart/DartPackages.ts` maps the project's own pubspec names to their
  `lib/` (so `package:my_app/…` is a project file; no pub cache, no network);
  `src/analysis/dart/FlutterCatalog.ts` is the static Flutter knowledge (72 names →
  declaring library and which of widgets/material/cupertino export them, derived
  from Flutter SDK 3.29.2, raised to 3.47.9 on 2026-11-05 — only `IndexedStack`
  moved, to `src/widgets/indexed_stack.dart`, findings unchanged — and
  re-checked against a local SDK by a test) — a name
  outside the catalog stays `unknown`, `TextField` from widgets.dart is `absent`.
  Decision: separate from the SymbolGraph (its ES-module model does not fit Dart
  libraries, `show`/`hide`, `part`), and Flutter knowledge kept out of the generic
  resolver. Graph nodes carry it additively as `WidgetNode.resolution`
  (`identity` stays); `ProjectRuleInput.dartLibraryIndex` is new and optional. All
  Flutter rules now require `resolved` to a `package:flutter/` (or `dart:async`)
  origin — layout 1.1.0/1.2.0, lifecycle 1.1.0, a11y 1.2.0. The a11y extractor uses
  the same algorithm FILE-LOCALLY (the FactCache is per file), so a widget reached
  only through a project barrel is not claimed there. Not modelled: the implicit
  `dart:core`, typedef/function names, conditional URIs, other packages' sources.
  On four real apps: 1881 catalogued widget nodes, all `resolved` to Flutter, zero
  disagreements with the old per-file grading; findings byte-identical; index and
  graph cost under 100 ms per app. Tests: `test/DartIdentity.test.ts`
  (`test/fixtures/dart-identity`).
- **Lifecycle precision (Flutter quality track, Phase C):** `dart.stateLifecycle`
  is now fact v2 (additive). **mounted:** each setState after an await gets a
  structural `guard` within its function body — `dominating` (`if (!mounted)
  return;`/`throw` incl. `!context.mounted` and `|| …` in a block enclosing the
  call, the call inside `if (mounted && …) {…}` or the `else` of `if (!mounted)`,
  `mounted ? setState(…) : …`), `non-dominating` (every mention is an `if`
  condition that provably does not guard the call: a mention beside it, no
  unconditional exit, a guard in one branch only, an exit via `break`), `unknown`
  (`final ok = mounted;`, `== false`, a loop condition, another closure — the rule
  stays silent) or `none`. An await in a different branch of the same
  `if`/`?:`/`switch` than the call does not count as preceding it. Evidence names
  the await, setState and deciding `mounted` lines. No dominance over loops or
  `try`/`finally` beyond that; awaits in a later loop iteration are not modelled.
  **Subscriptions:** a `.listen(…)` is a subscription only when stored in a field
  DECLARED `StreamSubscription` resolved to `dart:async` (catalog entry); untyped
  fields and own `listen()` APIs are never reported; subscriptions kept in a
  collection are not followed. **Resources:** per field, created for certain
  (resolved framework type) / possibly (untyped `listen`), managed elsewhere (also
  assigned from `widget.x`, a parameter, `a ?? b` — skipped; `= null` does not
  count), released for certain (`.dispose()`/`.cancel()`/`.close()`, also `?.`,
  `this.`, cascade — `releaseCalls`) / mentioned (still counts as released, user
  decision of Phase 3) / not provably released (the only reported state).
  Controller, subscription and setState rules at 1.2.0. On four real apps:
  findings unchanged at the same 148 locations (setState evidence now carries the
  lines); 60 setState-after-await calls — 49 dominating, 11 none, 0
  non-dominating/unknown; 50 framework controllers/Timers — 45 released by an
  explicit call, 5 not released (the existing findings); all 4 `.listen` fields
  typed and cancelled. A first stricter guard check surfaced 2 false positives
  (await and setState in exclusive `if` branches), fixed by the branch rule above.
  Not added: `StreamController`/`ValueNotifier` (no occurrence in the apps) and
  third-party controllers (no identity knowledge). Tests:
  `test/FlutterLifecycle.test.ts` (`test/fixtures/flutter-lifecycle-phase-c`).
- **Rule governance (Flutter quality track, E1 — groundwork for SOLID):**
  (a) rule maturity: `Rule.maturity` / `ProjectRule.maturity` (`stable` |
  `experimental`, schema-validated); findings of experimental rules carry
  `ruleMaturity: "experimental"`; no current rule is experimental. (b) The rule
  engine caps every project-rule finding's confidence by its `certaintyBasis`
  (`certaintyCap`), as declarative rules always were. Effect: two rules declared
  0.7 at `semantic-heuristic` now report 0.6 — `R-UNUSED-EXPORT` (only with
  `--dead-exports`) and `R-VALIDATION-CONTRACT-MISMATCH` (only with
  `--contracts`); no finding added or removed, the default output on four real
  apps and the golden corpus is byte-identical. (c) Output filters
  `--min-confidence`, `--certainty`, `--no-experimental`
  (`src/FindingFilter.ts`), applied in the CLI after the baseline step so
  `analyze()` and the baseline stay unfiltered; `AnalysisReport.filter` records
  criteria and hidden count. Tests: `test/RuleGovernance.test.ts`.
- **Dart in the ModuleGraph (Flutter quality track, E2):** `buildModuleGraph`
  takes an optional `DartLibraryIndex` (the pipeline now builds the index before
  the graph). Every Dart `import`/`export` directive whose URI resolves to an
  analyzed file (relative, or a `package:` URI of the project's own packages)
  becomes an edge with `origin: 'dart.importSpec'`, `dartDirective` and
  `resolution` `relative` | `package`; every other one (`dart:`, third-party
  packages, excluded/generated files) is an unresolved import with its URI.
  `part`/`part of` add no edge (one library); a configurable import contributes
  its default URI only. Pre-E2 entries carry no `origin` and are byte-identical.
  `cycleAdjacency` and the SymbolGraph ignore Dart edges, so `R-DEP-CYCLE` is
  unchanged — Dart cycles are legal and common; whether to report them is a
  separate decision. Measured on four real apps (185/74/66/35 Dart files): 548 /
  210 / 294 / 77 edges, 277 / 133 / 95 / 65 unresolved (all external: Flutter,
  `dart:`, third-party; no own-package URI unresolved), import cycles in 3 / 1 /
  0 / 2 strongly connected components (largest 15 files), graph build ≤ 6 ms;
  findings byte-identical on the apps, the golden corpus and the TS projects.
  Tests: `test/ModuleGraph.test.ts` (`test/fixtures/dart-modulegraph`).
- **Layer classification (Flutter quality track, E5a):**
  `src/model/LayerClassification.ts` (`buildLayerClassification(facts,
  dartLibraryIndex)`), Dart only, from facts and the index — no AST. **UI:** a
  class whose superclass resolves to `StatelessWidget`/`StatefulWidget`/`State`
  of `package:flutter/src/widgets/framework.dart`, directly or through project
  classes (`chain`), cycle-safe; base classes of other packages (`GetView`,
  `ConsumerWidget`) and ambiguous/unresolved names never count. **Data access:**
  the module itself imports a package of the versioned catalog
  `src/analysis/dart/DataAccessCatalog.ts` (`http`, `dio`, `shared_preferences`,
  `sqflite`, `cloud_firestore`, `firebase_database`, `firebase_storage`, `hive`,
  `isar`, `drift`, `supabase_flutter`, `graphql_flutter`), or `dart:io` with a
  `show` of file/socket/HTTP/process names; `dart:io` without `show` is
  `undecided` and does not count; one level only, never transitive. Roles belong
  to a library (file + parts); a module without a role is unknown.
  `StatelessWidget`/`StatefulWidget` were added to the Flutter catalog (checked
  against the SDK). Not yet wired into the pipeline — no rule consumes it until
  E6a, so every output is unchanged (verified byte-identical on four real apps,
  the golden corpus and the Flutter fixtures). Measured on the four apps (185 /
  74 / 66 / 35 Dart files): UI modules 76 / 12 / 30 / 14, data-access modules
  5 / 10 / 2 / 0, both in one module 0 / 4 / 0 / 0 (mwpa pages importing
  `shared_preferences`), `dart:io` undecided in 6 / 4 / 8 / 0 files, ≤ 9 ms. UI
  classes not seen: 1 (swipemeister) and 5 (velyo), all in files whose Dart 3
  syntax the grammar cannot structure. Tests: `test/LayerClassification.test.ts`
  (`test/fixtures/dart-layers`).
- **TypeModel (Flutter quality track, E4):** `src/model/TypeModel.ts`
  (`buildTypeModel(facts, analyzedFiles, dartIndex?, moduleGraph?)`; rules read
  it via `typeModelOf(input)` — `ProjectRuleInput.typeModel?`, built from the
  facts once per fact array when absent). Per declared type: every supertype
  resolved to `project` (target declaration), `external` (Dart: resolved
  library URI; TS: a non-analyzed module), `ambiguous` or `unresolved` (Dart:
  opaque candidates listed); inherited members through `extends`/`with`/`on`
  (not `implements`), most-derived first — own members hide, the last mixin
  wins, no constructors or statics — cycle-safe; catalogued framework members
  (`FLUTTER_FRAMEWORK_MEMBERS`, SDK 3.47.9: `State`, `StatelessWidget`,
  `StatefulWidget`, the ticker/keep-alive mixins, `CustomPainter`);
  `hierarchyComplete` only when every base is a project or catalogued framework
  type. Dart resolves through the DartLibraryIndex (prefixes, barrels, parts);
  TS through a same-file declaration or the new file-local
  `struct.importBindings` fact (local name → module, exported name: aliases,
  default and namespace imports — `deps.importName` has no local name) plus the
  ModuleGraph; TS re-export barrels are not followed (followed since the
  semantic consolidation, phase 2 — TS resolution moved to the SymbolGraph). `TickerProviderStateMixin`,
  `SingleTickerProviderStateMixin`, `AutomaticKeepAliveClientMixin` and
  `CustomPainter` were added to the Flutter catalog (SDK-checked). Not wired
  into the pipeline (E6b reads it through `typeModelOf`); findings byte-identical
  on four apps, golden corpus and Flutter fixtures (also with `--solid`).
  `struct.importBindings` adds 0.6–1.0 % facts on the TS projects (none on Dart).
  Measured: complete hierarchies among types with extends/with/on 213/221
  (swipemeister), 34/44 (mwpa: `GetxController`), 132/145 (velyo: parse
  errors), 21/22 (movinder), 15/17 (stoa/src), 7/61 (flyingfish: framework
  bases from `@stefanwerfling/figtree`, `typeorm`); build ≤ 22 ms. Tests:
  `test/TypeModel.test.ts` (`test/fixtures/typemodel`).
- **Class-model facts (Flutter quality track, E3):** one neutral
  `struct.typeDecl` fact per Dart class/mixin/enum
  (`src/analysis/dart/DartMembers.ts`) and per top-level TS class/interface
  (`src/analysis/typescript/TsMembers.ts`): `declKind`, supertypes as written
  (`extends`/`implements`/`with`/`on`, with prefix), `hasParseError`, and the
  members embedded as a compact table (user decision: one fact per member grew
  the facts by 34–43 %; defaults omitted, `expandMembers` restores them —
  `src/analysis/StructFacts.ts`). Per member: kind (method/getter/setter/field/
  constructor), static/abstract/override, body shape (`abstract`, `empty`,
  `throws-unsupported` — Dart `UnsupportedError`/`UnimplementedError`, TS
  `NotImplementedError`-like types or an Error whose message says not
  implemented/supported — or `normal`), declared type, parameters (field
  formals: Dart `this.x`, TS parameter properties, which are also fields),
  referenced own members, referenced import prefixes/imported names (Dart: also
  UpperCamel names not declared in the file, as candidates), constructor calls
  (incl. initializer lists and field initializers) and static property reads.
  Syntactic and file-local, cached like every fact. No rule reads them yet, so
  findings are unchanged (verified on four apps, stoa/src and
  flyingfish/backend with `--dead-exports`, the golden corpus); the report's
  `coverage.factCount` grows. Cost: Dart apps +4.0–5.6 % facts / +19–23 %
  bytes, TS projects +1.1–1.8 % / +2.9–4.1 %; analysis time +10–21 % on the Dart
  apps, ≤ 3 % on TS (single runs). Classes with a parse error: 2 / 316
  (swipemeister), 15 / 206 (velyo), 0 elsewhere — flagged, never to be judged.
  Not modelled: enhanced-enum members (unparseable), extensions, class
  expressions/nested classes in TS, shadowing beyond parameters and locals.
  Tests: `test/StructFacts.test.ts` (`test/fixtures/struct`).
- **Architecture config R6 (Flutter quality track, E5b):**
  `src/architecture/ArchitectureConfig.ts`, schema
  `schemas/architecture.schema.json`, CLI `--architecture <file>` (pipeline
  option `architecture`). Loader after the Validation Contract pattern (ajv
  2020; invalid JSON, schema violations and duplicate layer names fail with a
  clear message, exit 1). A reference to an undeclared layer in
  `allow`/`forbidPackages` (the plan's own example allows `ui → domain` without
  declaring `domain`) is a warning, not an error — it never matches.
  `ArchitectureModel`: a file belongs to the FIRST layer whose `include` globs
  (picomatch, dotfiles, POSIX paths relative to the analysis root — the
  directory of a single-file root) match; `edgeVerdict(from, to)` =
  `same-layer` | `allowed` (listed in `allow`) | `forbidden` | `unknown` (an end
  without a layer — never a violation); `isPackageForbidden(file, package)` per
  layer; `packageNameOf(specifier)` normalizes `package:http/…` → `http`,
  `dart:io`, `axios/x` → `axios`, `@scope/name/x` → `@scope/name`, relative and
  own-package specifiers → null. The report gets `architecture` (only with a
  config; markdown line, SARIF invocation property): layer sizes over the
  analyzed files, files without a layer, and the configuration warnings —
  files matching several layers (count + the first 20), empty layers,
  undeclared layer references. No rule reads it yet (E6d); without
  `--architecture` every output, incl. the full CLI JSON report, is
  byte-identical. Tried on swipemeister with the plan's example layers plus
  `domain` (`lib/Model/**`): ui 77, data 51, domain 11, 64 files without a
  layer. Tests: `test/ArchitectureConfig.test.ts`
  (`test/fixtures/architecture`: loader errors, assignment incl. multiple
  matches and outside-root files, all four edge verdicts, package bans and
  names, report summary and markdown, CLI fail-fast and JSON).
- **`refsOf` on compiler nodes (examined, not adopted):** after "Class
  members and source ranges", `classMembers` was ≈ 3.0 % of the CPU profile,
  ≈ 1.9 points of it in `refsOf` — ts-morph getters (`getExpression`,
  `getName`, `getText`, `getParent`) and the wrapper lookup per candidate.
  Tried: `refsOf` entirely on the compiler nodes of its walk (text as
  ts-morph's `getText` defines it, JSDoc still walked by ts-morph). Facts of
  the 652 measured files byte-identical, but no measurable gain in four
  alternating pairs of 5 rounds against HEAD (extraction 1.51–1.63 s against
  1.58–1.64 s): the wrappers exist anyway (the node index wraps every node,
  see "Building the node index in one walk"), so only cheap getter calls
  went away. No code changed; what is left of `classMembers` is below what
  this machine can measure.
- **The last line count on the position table (follow-up):** the worker
  profiles of the parallel extraction still showed ≈ 4 % in ts-morph's
  `getLineNumberAtPos` — the text scan from the file start that "Class
  members and source ranges" had replaced for every range. One caller was
  left: a function's `lineCount` (`getEndLineNumber() -
  getStartLineNumber() + 1`). It now comes from the per-file break table
  (`lineSpanOf`, `SourcePositions.ts`). ts-morph steps back to the line start
  before counting `\n`; no `\n` lies between a line start and the position,
  so the line of the position itself is the same number — exact, not
  approximated. No ts-morph line API is called in `src/` any more. Measured
  in four alternating pairs of 5 rounds against HEAD: extraction
  1.82–1.86 s → 1.58–1.59 s (≈ −14 %), total 2.35–2.41 s → 2.09–2.11 s.
  Facts of the 652 measured files byte-identical. Tests in
  `test/SourcePositions.test.ts`: `lineSpanOf` against ts-morph for every
  node of texts with JSDoc, LF, CRLF, lone CR and U+2028 (mutation-checked).
- **The TypeScript parse (examined, nothing adopted):** `parse()` takes
  ≈ 17 % of the CPU profile, ≈ 14 points of it inside TypeScript's own parser.
  Measured on the 652 files (best of 7 runs, all files kept alive): `parse()`
  of the adapter ≈ 434–462 ms, TypeScript's
  `createLanguageServiceSourceFile` with parent pointers alone ≈ 305–368 ms;
  without parent pointers ≈ 232 ms, without JSDoc ≈ 278–287 ms; a lib-free
  Project per file ≈ 8 ms in all. None of the gaps is a safe lever:
  - ts-morph always parses with parent pointers (its document registry
    hard-codes it) and navigates by them, so the ≈ 100 ms parent walk stays.
  - JSDoc is part of the facts (`refsOf` reads identifiers inside JSDoc,
    token queries include JSDoc — see "Class members and source ranges"), so
    skipping its parse would change facts.
  - The ≈ 94 ms between TypeScript's parse and ts-morph's `createSourceFile`
    is ts-morph's own per-file bookkeeping (SourceFile wrapper, file and
    directory caches, in-project marking) — the very objects the extraction
    navigates; only bypassing ts-morph's internals could cut it (≈ 4 % end
    to end at most).
  - Files parsed twice (scripts and `declare global` files, which go to the
    shared lib Project after the module check): 3 of 652, 1 KB together.
  No code changed. What remains as a lever is outside the parse: running
  files in parallel (worker threads) — an architecture question, not a
  parse optimization; since built as opt-in `--jobs`, see "Parallel
  extraction".
- **Building the node index in one walk (follow-up):** building the index
  took ≈ 15.5 % of the profile — two walks per file (a raw one numbering the
  nodes, then `forEachDescendant` collecting the wrappers) plus the check
  that both line up. Only ≈ 8.6 % of it was ts-morph creating the wrappers;
  the rest was the second walk, `forEachDescendant`'s per-node traversal
  object and child snapshot, and the check. The raw walk now takes each
  node's wrapper straight from ts-morph's wrapper factory and cache — the
  one `forEachDescendant` uses, so the wrappers are the very same objects.
  That factory (`_getNodeFromCompilerNode`) is internal to ts-morph: should
  a version lack it, or hand back a wrapper of another node, the index falls
  back to `forEachDescendant` with the alignment check as before. Measured
  in four alternating pairs of 5 rounds against HEAD: extraction
  2.04–2.08 s → 1.86–1.87 s (≈ −9 %), total 2.55–2.60 s → 2.40–2.42 s.
  Facts of the 652 measured files byte-identical, findings of 18 runs
  unchanged, golden and SOLID corpora unchanged. Tests in
  `test/NodeIndex.test.ts`: an index built before anything is wrapped hands
  out the wrappers ts-morph hands out later; a missing factory and one that
  returns another node both answer like ts-morph (mutation-checked).
- **Class members and source ranges (follow-up):** the profile put
  `classMembers` at ≈ 5 % and every `rangeOf` together at ≈ 8 %. Most of it
  was ts-morph's `getLineAndColumnAtPos`, which scans the text from the file
  start for the line and back to the line start for the column on every
  call — each range linear in the file length. `SourcePositions.ts` now
  builds the newline and line-break positions once per file and searches
  them binarily, with ts-morph's definition kept exactly (line = 1 + `\n`
  before the position, column from the last `\n` or `\r` — a lone `\r`
  starts no line). The seven identical `rangeOf` copies of the TS
  extraction and the JSX check use it. In `refsOf`, a member whose body
  holds JSDoc no longer walks the whole body with `getDescendants`: only
  the JSDoc nodes are walked by ts-morph, the rest comes from the node
  index (the lists refsOf builds are sorted and de-duplicated, so the order
  does not matter); the callee test asks `getExpression()` instead of
  building the child list. Measured in four alternating pairs of 5 rounds
  against HEAD: extraction 2.59–2.77 s → 2.04–2.10 s (≈ −21 %), total
  3.10–3.38 s → 2.57–2.70 s; in the profile `classMembers` 5.4 % → 2.8 %,
  the ranges 8.1 % → 0.8 %. Facts of the 652 measured files
  byte-identical, findings of 18 runs unchanged (stoa's self-analysis only
  shifts lines), golden and SOLID corpora unchanged. Tests:
  `test/SourcePositions.test.ts` (every position of texts with LF, CRLF,
  lone CR, U+2028 against ts-morph; JSDoc references in `.ts` and `.js`
  members, mutation-checked).
- **Export lookup: `.d.ts` regression fixed, syntactic fallback measured
  (follow-up):** the keyword shortcut of "Fewer token walks" answered a
  declaration without the keyword with `false` whenever the file had no
  export list or assignment — but a `.d.ts` module without an export list
  exports every declaration implicitly (the binder's export context), so
  since 88b90b6 such a file lost those `deps.export` facts and its
  `metric.exportCount` (e.g. 4 → 1). Declaration files now always ask
  ts-morph; none of the 18 compared runs changed (their `.d.ts` files use
  the keyword or are not analyzed). The lookup moved to `ExportLookup.ts`
  and is now checked declaration by declaration against ts-morph's own
  `isExported()`/`isDefaultExport()` on 22 files (export lists, aliases,
  string names, named default, `export default x` / `x()` / `(x)` / `N.x`,
  `export =`, re-exports, overloads, enum + namespace, two defaults, an
  import of the same name, `declare global`, `.d.ts` with and without a
  list, JS with `@typedef`). Also tried: answering the remaining cases from
  the syntax instead of ts-morph's symbol lookup — exact on all 22 files
  (11 of them by the syntax, a mutation check confirmed it), but without a
  measurable gain (extraction 2.64–2.70 s against 2.63–2.69 s, four
  alternating pairs of 5 rounds): the Program ts-morph builds for it is
  cheap for one file without lib files; only the CPU profiler made it look
  like ≈ 7 %. Not adopted. Facts of the 652 measured files byte-identical,
  findings of 18 runs byte-identical, golden and SOLID corpora unchanged.
  Tests: `test/ExportLookup.test.ts` (22 + 1: the `.d.ts` export facts).
- **Wrapping only what is queried (examined, rejected):** the node index
  wraps every node of a file once (`forEachDescendant`). Tried: wrap only
  the nodes a query returns, on demand, from the nearest wrapped ancestor
  down via `forEachChild` (plus wrapping only identifiers that name an
  import in `refsOf`). Facts byte-identical, but no measurable gain: parse +
  extract + release 3.22–3.24 s against 3.16–3.49 s (three alternating pairs
  of 5 rounds), end to end within noise, and the CPU profile shows the same
  time in ts-morph's wrapper creation before and after (≈ 600 ms, 10 %) —
  the extraction's own navigation (`getParent`, `getText`, `getStatements`,
  `getFunctions`, …) wraps nearly every node anyway, so the index only moves
  that cost. Not committed as code. Measured next levers instead: the
  TypeScript parse (≈ 15 % of the profile), `isExported()`'s symbol
  fallback building a Program per module that exports without the keyword
  (≈ 7 %) and `classMembers` (≈ 10 %).
- **Parse and release in the TS adapter (follow-up):** every file was
  parsed into one shared ts-morph Project and released with
  `removeSourceFile()`, whose `forget()` walks every wrapper of the file (all
  of them since the node index) and parses comment nodes on the way — 1.2 s
  of 4.6 s for the 652 measured files, more than parsing itself. Now an ES
  module gets a Project of its own without the lib files and is released by
  dropping the reference. Exact, because every symbol question of the
  extraction compares against a binding declared in the file
  (`isSameBinding`, the export symbols), accepts only declarations from the
  file (`resolveOneHop`) or needs a `const` with an initializer
  (`resolveSimpleAlias`, the Zod shape), and in a module a local binding
  never merges with a lib global. A script (no import/export, incl.
  CommonJS JS — its top-level names merge with lib globals such as `var
  name`) and a file with `declare global` keep the shared Project with the
  lib files. Rejected after measuring: one Project per file WITH lib files
  (facts identical, but every Program re-parses the lib files: extraction
  2.9 → 6.6 s), and recycling the shared Project every K files (≈ −8 %, the
  Program grows with K). Facts byte-identical (same hash over 50,046 facts
  of 652 files), findings of 18 runs byte-identical, golden and SOLID
  corpora unchanged. Measured (parse + extractFacts + release, same files,
  minimum of 3 rounds, alternating runs): 4.6 s → 3.2 s (release 1.2 s →
  ≈ 0); end to end (`analyze` with `--solid --dead-exports`, incl. process
  start, two alternating runs each): flyingfish backend 3.0–3.1 → 2.8–2.9 s,
  frontend 3.3–3.5 → 2.8–3.0 s, stoa/src 3.4–3.6 → 2.8–2.9 s; peak RSS
  backend 356–362 → 394 MB (+9 %: the per-file Projects wait for the next
  GC), frontend 392–395 → 365–377 MB, stoa/src 416–418 → 361–363 MB. Tests:
  `test/TypeScriptAdapterRelease.test.ts` (a module without lib files, a
  script and a `declare global` file with them, the same metrics on both
  paths).
- **Expression bodies are measured (follow-up):** the per-function walk
  inspected only the children of a function's body, never the body itself —
  harmless for a block, but an arrow with an expression body lost its
  top-level node: `() => Math.random()` was not flagged as nondeterministic,
  and the `&&`/`||`/`??` or `?:` at the top of `(a) => a && b` /
  `(a) => (a ? 1 : 2)` did not count. Now `measureBody` starts at the body
  itself, so an expression body counts like its block form `{ return …; }`
  (a block is in none of the kind sets and adds nothing). Effect on the 652
  measured TS/JS files: 201 expression-bodied arrows gain +1 cyclomatic and
  +1 cognitive complexity, 7 gain +1 nesting depth; no nondeterminism fact
  changed there; all other facts byte-identical. Findings of 18 runs
  byte-identical (no threshold crossed), golden and SOLID corpora unchanged.
  The fact cache needs no manual step (its key hashes the engine's code).
  Tests: `test/TsExtractionShortcuts.test.ts` (the per-function case now
  expects the flagged `() => Math.random()`, the counted `&&` and a
  ternary arrow).
- **One walk per function in the TS extraction (follow-up):** each function's
  body was walked twice through ts-morph's `forEachChild` (a wrapper array
  per node) — once for the complexity metrics, once for the
  nondeterminism check — and each class member's reference scope twice (a
  `getChildren` walk plus `getDescendantsOfKind(Identifier)`). Now
  `measureBody` computes metrics and nondeterminism in one `ts.forEachChild`
  walk (same children, same `getText()` slices), and `referenceCandidates`
  finds property accesses, `new` and identifiers in one walk and takes
  their wrappers from the file's node index (a scope holding JSDoc keeps the
  full `getDescendants` path, which also walks JSDoc). Facts byte-identical
  (same hash over 50,046 facts of 652 files), findings of 18 runs unchanged.
  Measured (extractFacts only, same files, minimum of 3 rounds, alternating
  runs): 3.2–3.3 s → 2.5–2.6 s (≈ −20 %; ≈ −74 % against 9.7 s before the
  three follow-ups). Kept as it was here (byte-identical), fixed in
  "Expression bodies are measured": an expression body was not inspected
  itself, only its children. Tests:
  `test/TsExtractionShortcuts.test.ts` (+1: metrics and nondeterminism with
  nested functions, `new Date()` with and without arguments, values from
  the two walks before).
- **One node index per file in the TS extraction (follow-up):** the fact
  families asked the same tree the same questions again and again — each
  `getDescendantsOfKind` (file-wide for catch clauses, property assignments,
  object literals, variable statements, calls; per function for calls,
  property accesses, declarations, assignments, throws) and each
  `forEachDescendant` (function-like nodes, request handlers, JSX elements)
  was a walk of its own. Now `NodeIndex.ts` builds per parse one raw compiler
  walk (preorder number, subtree end, numbers per kind) and one
  `forEachDescendant` for the wrappers, checked node for node against the raw
  numbering; `descendantsOfKind(node, kind)` then answers with the same
  wrappers in the same order as `node.getDescendantsOfKind(kind)` by binary
  search over the kind's numbers, `descendantsOfKinds` like a filtered
  `forEachDescendant`. Token kinds (Identifier, StringLiteral — ts-morph
  walks `getChildren` there, JSDoc included) and a file whose walks do not
  line up keep the ts-morph path (on the 652 measured files: none). A first
  variant that fetched the wrappers per kind with a file-wide
  `getDescendantsOfKind` was slower than before (6.2–6.6 s) and was
  discarded. Facts byte-identical (same hash over 50,046 facts of 652 files),
  findings of 18 runs unchanged. Measured (extractFacts only, same files,
  minimum of 3 rounds, alternating runs): 5.4–5.7 s → 3.3–3.4 s (≈ −40 %;
  together with "Fewer token walks" ≈ −65 % against 9.7 s). Not changed: the
  raw per-function walks of the metrics and the nondeterminism check, the
  identifier walks, parsing. Tests: `test/NodeIndex.test.ts` (every node ×
  20 kinds against `getDescendantsOfKind` incl. JSX, JSDoc and comment
  statements; the kinds variant against `forEachDescendant`; token kinds;
  a re-parse of the same path).
- **Fewer token walks in the TS extraction (follow-up):** the TS extraction
  wrapped every token of a file several times — `getDescendants()` and
  `getDescendantsOfKind(Identifier)` wrap each token in a ts-morph object —
  and `isExported()`/`isDefaultExport()` built a Program and a TypeChecker per
  file for every declaration without the keyword. Now: identifiers outside
  imports are collected by a walk over the compiler tree (only their text is
  read); JSX elements, request handlers and member references use node-only
  walks and wrap only their hits (`refsOf` takes the full path again if JSDoc
  holds a property access or `new`, e.g. `@augments a.B`); the export names
  are computed once per file (`countExports` derives from them), and the
  export questions are answered by the keyword alone unless the file has an
  export without it (`export {x}`, `export {x as default}`, `export default
  x`, `export =`) — only then is ts-morph asked (correction: a `.d.ts`
  module exports implicitly and was answered wrongly; fixed in "Export
  lookup: `.d.ts` regression fixed"). Facts are byte-identical:
  same hash over all 50,046 facts of 652 TS/JS files (flyingfish backend +
  frontend, kapalium frontend, a stoa snapshot), and the findings of 18 runs
  match the previous commit (stoa/src analyzing itself: the same findings,
  two moved by lines in the edited files). Measured (extractFacts only, the same 652
  files, minimum of 3 rounds, alternating runs on a machine under load):
  9.75–10.3 s → 5.6–5.8 s (≈ −43 %). Not changed: parsing, the remaining
  node walks per fact family (one per family), the Dart/PHP/C++ adapters.
  Tests: `test/TsExtractionShortcuts.test.ts` (exports without the keyword,
  aliases and re-exports, named default, `export =`, `export default
  <expr>`, a JSDoc property access as static access — expected values from
  the extraction before the change).
- **Stable names for functions without a name (follow-up):** a TS/PHP
  function without its own name was `anonymous@<line>`, so any edit above it
  renamed its findings (and moved them in a baseline). Now it takes the name
  it is bound to — TS `const handler = () => …`, an object property
  `onClick: …`, a class field `run = () => …`; PHP `$handler = function …` —
  and a remaining callback is `<scope>.(anonymous)#n`, numbered in source
  order within its nearest named scope (`declarationSymbols` in
  FindingIdentity.ts; parentheses so it can never equal a real name). A
  variable, property or class field whose initializer is not a function is
  a scope of its own (`const pair = list.map(() => …)` →
  `pair.(anonymous)#0`), and PHP named functions/methods scope the closures
  in them. An edit above a callback or in another scope no longer renames
  it; adding a callback before it in the same scope still does. Effect vs.
  the previous commit on 18 runs: only former `anonymous@` symbols changed
  (flyingfish backend 11, frontend 16 findings; stoa/src renamed its own,
  e.g. `anonymous@134` → `analyze`); golden and SOLID corpora unchanged, no
  `anonymous@` symbol left, no collision, two runs byte-identical. Tests:
  `test/FunctionIdentity.test.ts` (10: bindings, callbacks per scope, a
  stability case with inserted lines and an added callback in another
  scope, PHP closures).
- **Qualified function identities (follow-up to the evaluator-integrity
  track):** the TS, Dart, PHP and C/C++ adapters named a function or method
  by its bare name, so two classes' `run` in one file shared one finding
  identity (since phase 1 a failed `stoa eval` and a refused
  `--update-baseline`). Now every function fact carries its name qualified
  by the enclosing named scopes — TS: class, namespace, named function,
  object literal bound to a variable (`Service.run`, `outer.inner`,
  `api.run`); Dart: class, mixin, extension, enclosing function; PHP: class,
  trait, interface, enum; C++: class/struct/union with `::`, as out-of-class
  definitions already spell it. Namespaces of PHP and C++ are not added (one
  per file in practice; adding them would rename almost every symbol).
  A base that still occurs twice in one file gets `#n` on every occurrence
  (`uniqueSymbols` in FindingIdentity.ts: getter/setter pairs, C++
  overloads, two closures on one line). `anonymous@<line>` stays as the
  base. Facts and rules are otherwise unchanged; the FactCache invalidates
  itself through the engine fingerprint. The Flutter widget-tree owner is
  the same function symbol, so layout identities read `Page.build>Expanded#n`
  (still numbered per file). Effect, HEAD vs. this change on 18 runs (16
  targets): golden and SOLID corpora, contracts, ffschemas, kapalium
  unchanged; on the others only `location.symbol` and the observation text
  that names it changed — flyingfish backend 54, frontend 39, velyo 31,
  swipemeister 30, stoa/src 10, mwpa 9 findings (complexity, nesting,
  parameters, nondeterminism); no finding added or lost, no identity
  collision before or after on these targets. `R-ORM-EAGER-RELATION` (TS and
  PHP) names a finding `Entity.property` (two entities with the same eager
  property in one file collided); approved golden-corpus change: the six
  eager-relation expectations in `test/corpus/expected.json` (`tags` →
  `Order.tags`, `messages` → `Thread.messages`, `customer` →
  `Order.customer`/`Invoice.customer`, `parent` → `Node.parent`, `source` →
  `Edge.source`), corpus still TP 44 / FP 0 / FN 0. Class-level PHP
  findings (`R-MIGRATION-NO-DOWN`, `R-ORM-ENTITY-NO-PK`, the eager-relation
  prefix) number anonymous classes `(anonymous)#n` when a file holds
  several (a single one stays `(anonymous)`; TS allows at most one, the
  default export). With no rule left that collides, the CLI collision
  tests force one through the test-only environment hook
  `STOA_TEST_DUPLICATE_IDENTITY=1` (not a documented flag, like
  `STOA_TEST_FORCE_INCOMPLETE`: repeats the first finding with the same
  identity). Tests: `test/FunctionIdentity.test.ts`
  (7: `uniqueSymbols`, one per adapter, the finding-level `A.run`/`B.run`
  case, the eager-relation case in TS and PHP), the anonymous-class case in
  `test/EvalIntegrityCli.test.ts`; widget-graph, layout and ORM
  expectations updated.
- **Measurement and memory profile (evaluator-integrity track, phase 4):**
  `--memory-stats` / `AnalyzeOptions.onMetrics` now report the run's
  `PipelineMetrics` (src/PipelineMetrics.ts) — counts (deterministic), phase
  timings and peak RSS (`process.resourceUsage().maxRSS`; not deterministic,
  for comparing runs on one machine). Observational only: report and
  findings are byte-identical with or without it. Measured (built CLI, one
  run each; times in ms):

  | project | files | facts | extraction | graphs | evaluation | total | peak RSS |
  |---|---|---|---|---|---|---|---|
  | stoa/src | 97 | 12,633 | 4,467 | 28 | 78 | 4,604 | 475 MB |
  | flyingfish backend | 241 | 9,861 | 4,048 | 32 | 64 | 4,190 | 414 MB |
  | flyingfish frontend | 102 | 12,455 | 4,173 | 18 | 61 | 4,283 | 439 MB |
  | swipemeister (Dart) | 166 | 7,821 | 2,752 | 120 | 262 | 3,171 | 248 MB |
  | velyo (Dart) | 52 | 4,353 | 1,620 | 85 | 174 | 1,902 | 234 MB |
  | golden corpus | 34 | 461 | 517 | 2 | 6 | 544 | 256 MB |

  Findings: (1) extraction is 85–97 % of the time; graphs plus every rule
  stay under 400 ms. (2) What the run RETAINS is small — facts and models
  13–26 MB on these projects (measured after forced GC, in a measurement
  script only) — while the V8 heap grows to 200–335 MB and RSS to 333–475 MB
  during extraction; a small project already needs ~250 MB (grammars, code).
  The peak is short-lived garbage of the per-file extraction, not held data.
  (3) A CPU profile of flyingfish/backend puts 71 % of the time in ts-morph:
  the TS extraction walks each file's whole tree about eleven times
  (`getDescendantsOfKind`/`forEachDescendant` per fact family), and every
  walk wraps compiler nodes in ts-morph objects. (4) No copies: the graphs
  hold paths, fact ids and references (identity check, see the semantic
  consolidation entry); the facts array lives for one `analyze()` call.
  Not changed, deliberately: bounding/streaming the facts or decoupling graph
  building from evaluation could save at most the ~20 MB retained (≲ 5–10 %
  of the peak) while risking the project-wide rules; the measured lever is
  the TS extraction's repeated walks — a separate, measured change
  (facts must stay byte-identical). Known small waste: with `--solid` the
  SymbolGraph is built even when no rule ends up building a TypeModel (no
  `struct.typeDecl`: flyingfish/schemas, 2.7 ms). Tests:
  `test/PipelineMetrics.test.ts` (one call; counts agree with the report;
  SymbolGraph/TypeModel only when built; counts reproducible; report
  identical with and without; CLI summary and JSON line on stderr, stdout
  unchanged).
- **`analyzedFiles` contract (evaluator-integrity track, phase 3):** the
  RuleEngine derived `ProjectRuleInput.analyzedFiles` from
  `facts.map(subject.file)`, while the contract (and the ModuleGraph, since
  Phase 0 correction P5) use the pipeline's explicit list. No output
  differed — every adapter emits `file.lineCount` for every file, empty ones
  included (checked for TS, Dart, PHP), so both sets were equal on every
  measured project — but a filtered or bounded fact set, or an adapter
  without that fact, would have dropped files. Now `RuleEngine.evaluate`
  takes `analyzedFiles` as an optional last parameter and hands it to every
  project rule as is; the pipeline passes its list (the ModuleGraph's node
  set). Semantics: every file read and extracted in this run (a FactCache hit
  included) — never one excluded, skipped (read/parse error) or not reached
  after a memory-guard stop; a file with no fact stays in it. A caller
  without a list (a test) keeps the old fallback, the files of `facts`. No
  synthetic fact was added. Findings byte-identical on every measured
  project. Tests: `test/AnalyzedFiles.test.ts` (passed as is with a file
  without facts; a filtered fact set keeps the inventory; the fallback; the
  real pipeline hands rules exactly the ModuleGraph's nodes and leaves an
  unreadable file out).
- **SymbolGraph on demand (evaluator-integrity track, phase 2):** a rule
  declares `usesTypeModel` when it reads the TypeModel (`typeModelOf`) —
  `R-SOLID-LSP-CONTRACT-COMPATIBILITY`, `R-SOLID-ISP-INTERFACE-COHESION`,
  `R-SOLID-DIP-CONCRETE-DEPENDENCY` and the unregistered SRP rule. The
  pipeline builds the SymbolGraph (`needsSymbolGraph(projectRules)`, the one
  central decision) only when an active rule declares it — in practice only
  with `--solid`; one instance per run, shared through `ProjectRuleInput`.
  The TypeModel is the SymbolGraph's only consumer. A rule that reads the
  TypeModel without the declaration fails loudly in `typeModelOf` (module
  graph given, symbol graph not) instead of building a second, unshared
  graph; a rule called directly without any graph (a test) still derives
  every model from its facts. Measured benefit is small (the build cost
  0.2–7.7 ms and ≤ 1 MB on the measured projects) — the point is that no
  graph is built for nothing. Findings byte-identical on every measured
  project, with and without `--solid`. Tests: `test/SymbolGraphDemand.test.ts`
  (which rules declare it and which rule sets need the graph; every rule's
  declaration is truthful on the SOLID fixtures; an undeclared TypeModel
  reader throws; shared graph vs. self-built path and reversed fact order
  give identical findings).
- **Unique finding identities and duplicate-safe evaluation (evaluator
  integrity, phase 1 of the follow-up track):**
  - **Found:** the Flutter lifecycle rules used the State class as the
    symbol, the layout rules the owning function (`build`) — several sites in
    one class / one `build()` shared one identity (mwpa: 5 `setState` sites
    and 3 controllers of one class; swipemeister: 3). `--update-baseline`
    then wrote a baseline that `--baseline` rejected ("duplicates an earlier
    entry's identity"), and `stoa eval` passed despite the collision
    (`duplicates` was reported but never decided the outcome).
  - **Identities:** lifecycle `Class.field` (controller, subscription),
    `Class.method#n` (`setState` after `await`, numbered per method in source
    order), `Class.initState:Type.of#n`; layout `owner>Widget#n` (numbered per
    file, since two classes of one file can both own a `build()`). The `#n`
    helper `ordinalSymbols` lives in `src/FindingIdentity.ts`. Versions:
    UNDISPOSED-CONTROLLER, UNCANCELLED-SUBSCRIPTION, SETSTATE-AFTER-AWAIT,
    UNBOUNDED-SCROLLABLE, NESTED-SCROLL-UNBOUNDED 1.3.0; INHERITED-IN-INITSTATE,
    PARENTDATA-MISUSE, TEXTFIELD-UNBOUNDED-WIDTH 1.2.0. Existing baselines with
    these rules report their findings as `new` until rewritten (one with a
    collision could not be loaded before anyway).
  - **Evaluation:** a duplicate produced identity fails a complete evaluation
    (exit 1) even with 0 FP / 0 FN; the identities stay listed in
    `duplicates`, the Markdown explains the collision, stderr names it,
    nothing is dropped. **Baseline:** `saveBaseline` refuses findings that
    share an identity (exit 1, existing file untouched) instead of writing an
    unreadable file.
  - **Known open collision (not changed, needs a decision):** the TS, Dart
    and PHP adapters name a function/method by its bare name — two classes in
    one file with a same-named method share one identity for every
    declarative rule (`A.run` and `B.run` both `run`). None occurred on the
    golden corpora or the measured projects; such a project now fails `eval`
    and `--update-baseline` loudly instead of silently.
  - **Unchanged:** every golden corpus (0 duplicates), every non-Flutter
    finding.
  - Tests: `test/fixtures/flutter-identity` (several sites per class, per
    method, per `build()` and across two classes of one file), uniqueness over
    every lifecycle/layout fixture, Flutter baseline round trip through the
    CLI, `saveBaseline` refusal (unit + CLI), duplicate produced identities
    through the real `stoa eval` (exit 1, JSON, Markdown, stderr) and
    `evaluationOutcome`. Against the previous code these fail.
- **Architecture rule on the consolidated models (semantic consolidation,
  phase 3):** `R-SOLID-DIP-LAYER-DIRECTION` stage 2 → 0.3.0.
  - **Re-exports are dependencies:** TS `export … from` (`deps.reexport`
    entries of the ModuleGraph) is judged like an import (evidence directive
    `export`), consistent with Dart `export` directives, judged since E6d — a
    barrel in the UI layer re-exporting the data layer is a UI → data
    dependency; a re-export of a banned package is a package violation.
  - **One finding per file pair:** edge violations are grouped by (importing
    file, imported file), every site cited — as documented since E6d; before,
    one finding per ModuleGraph edge, and an `import type` plus an import
    (or an import plus a re-export) of the same file would have shared one
    identity (none occurred on the measured projects; with re-exports it
    would).
  - **Packages vs. project modules:** a package ban applies only to entries
    the ModuleGraph marks `external` (TS) — an unresolved tsconfig alias is a
    project reference, never a package; Dart entries are unchanged.
  - **Unchanged by design:** module identity only (findings name files and
    packages, not symbols); type-only imports visible (`type` in the
    evidence); dynamic `import()`, DI and runtime wiring produce no fact and
    are never a violation.
  - **Measured:** the SOLID corpus (stage 2), the dip-declared fixture,
    swipemeister and mwpa (scratch configs, Dart), stoa/src and
    flyingfish/backend (scratch TS configs: 2 and 54 findings) — every
    finding byte-identical except the rule version 0.2.0 → 0.3.0; no project
    had a re-export across layers, a duplicate pair or an unresolved alias on
    a ban list. Without `--architecture` all outputs are byte-identical.
  - **Symbol level (concept, not implemented):** which symbols cross a
    forbidden boundary is now available from the SymbolGraph (binding,
    definition, re-export hops) — the basis for a finer later rule (e.g.
    "UI uses the concrete class `Api` of the data layer" instead of "UI
    imports `api.ts`"), kept separate from the module identity of this rule.
  - **DI, service and plugin registrations (concept only, nothing
    detected):** these create runtime edges no import shows — a
    `GetIt.registerSingleton<Repo>(ApiRepo())`, an Angular/Nest provider, a
    plugin registry keyed by strings. Statically sound only where the
    registration is a literal call with resolvable types (then: a
    framework-specific fact "binds abstraction A to implementation B in file
    F", judged against the layers of A, B and F); lookups by string keys,
    reflection, configuration files and conditional registration stay
    unknown and must never become violations. Worth doing only per framework
    with real projects to calibrate on; none is planned yet.
  - Tests: `test/SolidArchitectureRule.test.ts` (new TS fixture
    `test/fixtures/solid/dip-declared-ts` with a tsconfig alias: re-export of
    a layer and of a package, import type + re-export of one file = one
    finding, unresolved alias on the ban list not reported, resolved alias
    reported, dynamic import silent, exact list, determinism; the E6d
    expectations now read 0.3.0) and the identity-uniqueness test in
    `test/SolidCorpus.test.ts` over the new fixture.
- **SymbolGraph as the one ES-module name resolver (semantic consolidation,
  phase 2):**
  - **One resolver, clear responsibilities:** ModuleResolver/ModuleGraph —
    which module depends on which; SymbolGraph — which exported symbol a
    name refers to and where it is defined; TypeModel — which types exist and
    how they inherit. `TypeModel.resolveTs` no longer resolves imports itself:
    its module-target table and default-export line table are gone; it maps
    the local alias (`struct.importBindings`) to the SymbolGraph binding and
    the binding's definition to a declaration. Dart stays with the
    DartLibraryIndex (a different import model: prefixes, `show`/`hide`,
    parts). Measured before the switch: both TS resolvers agreed on all 3,131
    type bindings of flyingfish and stoa.
  - **`external`:** `ModuleResolver.isExternal` (a bare specifier no
    configured mechanism claims — not relative/absolute/`#`, not the own
    package, no tsconfig `paths` pattern, with `baseUrl` no analyzed path
    below it) is the single classification; the ModuleGraph records it on
    unresolved TS entries (`external`), the SymbolGraph reports `external`
    instead of `unresolved` for packages (a failed relative import or alias
    stays `unresolved`, now with `unresolvedReason` `module`/`export`/`cycle`).
  - **Re-exports:** new file-local fact `deps.reexport` (TS adapter; value in
    `src/analysis/DepsFacts.ts`) for `export {a as b} from`, `export {default
    as X} from`, `export * from`, `export * as ns from` (type-only marked);
    a named one has exactly the range of the `deps.export` the same specifier
    produces, so local and re-exported names are told apart. `deps.export`
    is unchanged. The ModuleGraph adds them as entries with `origin:
    'deps.reexport'` (ignored by `R-DEP-CYCLE` and the stage-1 layer rule; judged by
    stage 2 since phase 3). The SymbolGraph
    follows them to the defining file (`definitions`, every hop in `via`):
    local/explicit beats `export *`; two `export *` with different
    definitions → `ambiguous` (both kept); `export *` never provides
    `default`; a hop into a package → `external` (also when the name can only
    come from the single `export *` into a package); a missing module →
    `unresolved` (`module`); a cycle is detected on the current path →
    `unresolved` (`cycle`). `resolveExport(file, name)` answers `ns.X`.
    Not followed: `import {A} …; export {A};` (counts as defined there).
  - **TypeModel gains through it:** types behind barrels, aliases,
    `default as`, and `ns.X` where `ns` is a named import of an `export * as
    ns`; an `export *` conflict is `ambiguous` with both candidates.
    Declaration merging (several export sites of one name in one file) stays
    one declaration, as before.
  - **Unchanged:** every finding on the main corpus, the SOLID corpus, the
    SOLID fixtures, flyingfish (backend, frontend, schemas), kapalium,
    swipemeister, mwpa and velyo (with `--solid`, `--dead-exports`), and every
    pre-existing TypeModel resolution on all of them — byte-identical. stoa's
    own self-analysis changes only through its new code (274 instead of 276
    findings: four complexity findings fewer; `buildTypeModel` now has a
    fifth, optional parameter). `coverage.factCount` grows by the
    `deps.reexport` facts where re-exports exist; FactCache entries
    invalidate by themselves (engine fingerprint).
  - **Changed test expectations (intended):** a package import is `external`
    (was `unresolved`); the "module not resolvable" case now uses a missing
    relative module; the TypeModel's barrel case resolves (was the documented
    limit).
  - Tests: `test/SymbolGraphReexport.test.ts` (real adapter on
    `test/fixtures/symbolgraph/reexport`: facts and ranges, chains, alias,
    `default as`, namespace re-export, type-only, ambiguity, `default`,
    cycle, missing module, packages, TypeModel through the graph,
    determinism, FactCache hit, ModuleGraph entries, `isExternal`).
- **Evaluator integrity (semantic consolidation, phase 1):** `stoa eval`
  reported an incomplete analysis as a pass — a `partial` scan (memory guard,
  read/parse error) only printed a stderr warning and exited 0 whenever the
  findings reached so far matched. Now: exit 0 = complete and passed, 1 =
  complete and failed or a technical error (an exception in the analysis is
  caught and reported instead of crashing), 2 = incomplete (wins over the
  metrics). `evaluationOutcome(result, analysis)` (`src/evaluation/Evaluator.ts`)
  decides; the result gains the additive fields `analysis` and `outcome`, the
  Markdown two lines. `eval` honours the same test-only incomplete hook as
  `analyze`. `analyze`, its reports and every finding are unchanged. Tests:
  `test/EvalIntegrityCli.test.ts` (real CLI process: passed, FP, FN, memory
  guard, incomplete although every produced finding matches, unreadable file,
  manifest and project untouched, technical error, Markdown; a parse failure
  cannot be provoked through the CLI — it always loads every grammar — so it is
  checked through pipeline + evaluator in a fresh process without the Dart
  grammar) and `evaluationOutcome` in `test/EvaluatorUnit.test.ts`. Against the
  previous code 9 of the 10 CLI tests fail.
- **SOLID, SRP responsibility cohesion (Flutter quality track, E6e):**
  `src/rules/project/SolidSrpRule.ts`, `R-SOLID-SRP-RESPONSIBILITY-COHESION`
  0.1.0 (experimental, `semantic-heuristic` 0.4, `info`, `marcus.purpose`,
  `responsibility-boundaries`). **Not registered** — not even with `--solid` —
  until the candidates are classified by hand (plan, OQ-6); outputs are
  byte-identical with and without `--solid`. Groups = connected components of
  "own instance member references own member" (constructors and statics left
  out, getter + setter one property). Reported when ≥ 2 groups each have a
  method, an own field and a dependency, and the groups are pairwise disjoint
  in fields AND dependencies; a dependency is an import name resolved via the
  TypeModel to a project file, an external package (`packageNameOf`), a Dart
  import prefix or an ambiguous name — names resolving to nothing (dart:core,
  type parameters) are no evidence. Evidence lists every group (methods,
  fields, dependencies), never a number. Judged only where cohesion is fully
  visible: classes/abstract classes without inherited or framework members
  (references to `widget`, `setState` or a base method are not recorded — the
  Phase D artefacts), no parse error, no test path, no test double. Measured
  (four apps, stoa/src, flyingfish): **0 candidates**. Funnel: 394 judgeable
  classes (swipemeister 92, velyo 52, movinder 15, mwpa 45, flyingfish 158,
  stoa 32); 414 excluded for inherited/framework members; 56 split into ≥ 2
  method groups — all reviewed as no SRP violation: data classes with
  per-field accessors (velyo models), l10n tables, TypeORM `up`/`down`
  migrations, stateless providers/managers without own fields (flyingfish),
  the language adapters (`id`/`version`/`extractFacts` vs. `parse` — split
  by the adapter interface), stoa's `TypeModel` (lookup vs. resolution; the
  groups share dependencies),
  a variant value holder (mwpa `DynInputValue`, its groups share
  `flutter`). Tests: `test/SolidSrpRule.test.ts` (`test/fixtures/solid/srp`,
  Dart + TS: positive, getter/setter, shared state, shared dependency, plain
  data, dart:core-only group, subclass, widget, test double, test path, not
  registered, German text) and the lossless case in
  `test/ProjectRuleCategorization.test.ts`.
- **SOLID evaluation, precision gate (Flutter quality track, E7):**
  - **SOLID golden corpus** `test/corpus/solid` (outside `test/corpus/project`,
    so the main corpus is unchanged): a small Flutter/TS project with a
    positive and a negative case per rule and the composition root; two
    manifests — `expected.json` (`--solid`, stage 1) and
    `expected-architecture.json` (`--solid --architecture
    test/corpus/solid/stoa.architecture.json`, stage 2). `stoa eval` now
    accepts `--solid` and `--architecture` (same loaders as `analyze`). Both:
    precision and recall 100 % (7 TP, 0 FP, 0 FN); without `--solid` the corpus
    produces no finding.
  - **Precision gate on the real projects** (manual review of every SOLID
    finding, four apps + stoa/src + flyingfish, without `--architecture`): the
    only false positives were hints in `main.dart`, the composition root, where
    wiring concrete classes is what dependency inversion asks for (stage 1: 2 of
    19, E6c: 2 of 24). User decision: a Dart library with a top-level `main()`
    (a `function` subject in `metric.functionLength`, no file-name pattern) is
    excluded from stage 1 and E6c. After that: swipemeister stage 1 13, E6c 19;
    mwpa stage 1 4, E6c 3; velyo, movinder, stoa/src, flyingfish 0; no false
    positive left in the review. LSP/ISP: 0 findings on all six projects (no
    member there only throws unsupported, no abstract project member is
    fulfilled empty) — user decision: they stay `experimental` until real
    findings were reviewed, although the gate is formally passed. Stage 1 and
    E6c stay `experimental` (semantic heuristics, as planned); stage 2 is
    `stable`.
  - **Unique identities:** several SOLID findings of one class or file shared
    one identity (file, rule, symbol) — 21 duplicates on swipemeister with
    `--architecture` — so a baseline or `--only-new` merged them. Symbols now
    carry the target: E6c `Class:Target`, ISP `Class:Contract`, stage 2 the
    imported file's relative path or `package:<name>`; a test checks
    uniqueness on every SOLID fixture. (The Flutter lifecycle rules still have
    such duplicates — e.g. two `setState`-after-`await` sites in one State —
    outside this track.)
  - **SRP (E6e)** came after E7, see the entry above.
  - Docs: `rule-model` (the SOLID rules; `R-ARCH-LAYER-VIOLATION` realized as
    stage 2), `finding-model` (`architecture` report field, identity),
    `evaluation` (SOLID corpus), `open-questions` (OQ-6), README.
  - Tests: `test/SolidCorpus.test.ts` (both manifests, no finding without
    `--solid`, unique identities, `eval` CLI).
- **SOLID, DIP layer direction stage 2 (Flutter quality track, E6d):**
  `src/rules/project/SolidArchitectureRule.ts`, `R-SOLID-DIP-LAYER-DIRECTION`
  0.2.0 (stable, `syntactic` 0.9, `medium`, `marcus.cooperation`,
  `dependencies`). Only with `--solid --architecture`, and then INSTEAD of
  stage 1 (user decision: one semantics per run under the id; without a config
  stage 1 0.1.0 runs as before). Findings: a resolved ModuleGraph edge — TS
  `deps.import` (type-only included, marked `import type` in the evidence) and
  Dart `import`/`export` (E2) — between two different layers whose direction
  `allow` does not list, one per (importing file, imported file) at its first
  site; and an unresolved (package) import whose `packageNameOf` name is banned
  for the importing file's layer, one per (file, package). A file without a
  layer never leads to a finding. Evidence: the file's layer (config name and
  version) and every import site. Maturity stable as planned: the finding is
  a fact relative to the user's declaration, not a heuristic. Tried with
  scratch configs: swipemeister with the plan's example layers (`lib/Service/**`
  includes the API response models) 92 edge findings, 0 package findings (no
  UI file imports http/dio/sqflite); mwpa with `shared_preferences` banned for
  `lib/Pages/**`: the same 4 pages E6a found. Without `--architecture` every
  output is byte-identical. Tests: `test/SolidArchitectureRule.test.ts`
  (`test/fixtures/solid/dip-declared`: forbidden Dart import/export and TS
  (type) imports in both directions, Dart/`dart:`/npm/scoped package bans,
  allowed, same-layer and unknown edges, replacement of stage 1, no finding
  without `--solid`), plus the lossless-kinds check in
  `test/ProjectRuleCategorization.test.ts`.
- **SOLID, DIP layer direction stage 1 (Flutter quality track, E6a):**
  `src/rules/project/SolidRules.ts`, registered only with `--solid` (pipeline
  option `solid`). `R-SOLID-DIP-LAYER-DIRECTION` 0.1.0 (experimental,
  `semantic-heuristic` 0.5, `low`, `marcus.cooperation` + `marcus.control`,
  `dependencies`): a Dart library declaring a UI class (E5a) that imports a
  data-access package itself or a project data-access module that is neither UI
  (reported on its own) nor a state holder (Dart edges of the E2 ModuleGraph).
  State holder (user decision): a class extending or mixing in a catalogued
  state-management base — `ChangeNotifier`/`ValueNotifier` (`package:flutter/`),
  `GetxController`, `Cubit`/`Bloc`, `StateNotifier`/`Notifier`/`AsyncNotifier`
  (`STATE_HOLDER_BASES`, versioned) — that is not a project declaration; a UI
  depending on its state layer is the intended pattern, even when that layer
  persists data. One finding per library at its first such import; evidence lists the
  UI classes with their Flutter base and every import. Library level only —
  whether the UI class uses the imported names is not checked before E3. The
  rule builds the layer classification itself from the facts and the
  DartLibraryIndex, so without `--solid` nothing extra is computed and every
  output is byte-identical (verified on four real apps, golden corpus,
  fixtures). With `--solid` on the four apps: 14 / 5 / 0 / 0 hints (before the
  state-holder exclusion 14 / 9 / 13 / 0 — velyo's `AppState extends
  ChangeNotifier` and mwpa's `GetxController`s dropped out). The remaining
  targets are services/wrappers doing I/O (swipemeister `ApiService`,
  `PreferencesManager`, `AvatarCacheManager`; mwpa `DBHelper`, `MwpaAPI`,
  `SyncMwpaService`, `Preference`); 4 mwpa pages import `shared_preferences`
  directly. Tests: `test/SolidRules.test.ts` (`test/fixtures/solid/dip-layer`:
  positive, negative, unknown and state-holder cases, a run without `--solid`),
  `test/LayerClassification.test.ts` (state holders), plus the lossless-kinds
  check in `test/ProjectRuleCategorization.test.ts`.
- **SOLID, LSP and ISP contract rules (Flutter quality track, E6b):** in
  `src/rules/project/SolidRules.ts`, only with `--solid`, Dart and TypeScript,
  over the TypeModel (`typeModelOf`). `R-SOLID-LSP-CONTRACT-COMPATIBILITY`
  0.1.0 (`syntactic` 0.8, `low`, `marcus.judgment`,
  `responsibility-boundaries`): a method/getter/setter whose body only throws
  an unsupported/unimplemented error and that overrides a CONCRETE member
  (non-abstract, body present) of a resolved project supertype — the nearest
  declaration along the implementation chain (mixins last-applied first, then
  superclass/`on`), then `implements`; `@override` is not required (the
  hierarchy lookup decides). `R-SOLID-ISP-INTERFACE-COHESION` 0.1.0
  (`syntactic` 0.7, `info`, `marcus.purpose`, `responsibility-boundaries`): a
  class that implements/extends/mixes in a resolved project interface or
  abstract class and fulfils ≥ 2 of its ABSTRACT members (own and inherited)
  with an empty or only-throwing body; one finding per (class, contract).
  Both skip framework/package bases (unknown members), declarations with a
  parse error, classes in test paths (`test/`, `integration_test/`,
  `*_test.dart`, `*.test.ts`/`*.spec.ts`, relative to the deepest common
  directory of the analyzed files) and type names containing
  `Mock`/`Fake`/`Stub` (a documented name exception that only excludes); an
  empty or throwing override of an abstract member is not an LSP finding.
  Maturity `experimental` for now — the plan table says `stable`, but the
  E7 precision gate decides that. Without `--solid` every output is
  byte-identical; with it the four apps, stoa/src and flyingfish produce no
  LSP/ISP finding — none of them has a single member that only throws
  unsupported, nor an empty implementation of an abstract project member (the
  Phase D measurement found the same). Tests: `test/SolidContractRules.test.ts`
  (`test/fixtures/solid/contracts/{dart,ts}`: positive, negative, unknown,
  test-path and test-double cases, a run without `--solid`), plus the
  lossless-kinds check in `test/ProjectRuleCategorization.test.ts`.
- **SOLID, DIP concrete dependency (Flutter quality track, E6c):**
  `R-SOLID-DIP-CONCRETE-DEPENDENCY` 0.1.0 in `src/rules/project/SolidRules.ts`,
  only with `--solid`, Dart only (the E5a layer classification is Dart only)
  (experimental, `semantic-heuristic` 0.5, `low`, `marcus.cooperation`,
  `dependencies`): a UI class (E5a) whose OWN members create a concrete
  project class, call one of its static methods or read one of its static
  members (`Api.instance`), where that class resolves by identity (TypeModel)
  to a non-abstract `class` in a library with the role data access that is
  neither UI nor a state holder. Dart spells a named constructor and a static
  call alike (`Api.x()`): the target's member table decides — a declared
  constructor creates, a declared static method is a call, anything else is
  unknown and not judged. One finding per (UI class, target class) at the
  first site; the evidence lists every site. Never a finding: the class
  itself, abstract targets (a factory constructor of an abstraction), models
  without data access, state holders, DI lookups (`GetIt.I`, `context.read`),
  ambiguous or unresolved names, inherited members. Static method calls go
  beyond the plan wording ("creates … or accesses its `instance`
  statically") — they are the same concrete binding and the dominant pattern
  on swipemeister. With `--solid`: swipemeister 21 (2 creations, 40 static
  calls, 2 static reads — `ApiService`, `PreferencesManager`,
  `AvatarCacheManager`), mwpa 3 (`MwpaApi()`, `SyncMwpaService()`,
  `Preference()`), velyo 0, movinder 0; without `--solid` every output is
  byte-identical. Fixed on the way (E4): `typeModelOf` memoized per fact
  array only, so the same array evaluated without the pipeline's Dart index
  received the pipeline's model; it is now keyed by fact array, Dart index
  and module graph. Tests: `test/SolidDipConcreteRule.test.ts`
  (`test/fixtures/solid/dip-concrete`), the memo case in
  `test/TypeModel.test.ts`, plus the lossless-kinds check in
  `test/ProjectRuleCategorization.test.ts`.
- **Flutter State lifecycle (Flutter analysis, Phase 3):** `src/analysis/dart/FlutterLifecycle.ts`
  emits one neutral `dart.stateLifecycle` fact per class that directly
  `extends State<…>`: fields assigned exactly one call (field initializer or
  `field = …` anywhere in the class, cascades allowed; `a ?? Foo()` is not a
  creation), the field names `dispose()` mentions (transitively through
  same-class methods it calls), calls in `initState()` (outside closures) with a
  positional `context`, and per `setState` call whether an `await` precedes it in
  the same function body (method or closure) and whether `mounted` occurs in
  between. Four `ProjectRule`s in `src/rules/project/FlutterLifecycleRules.ts`
  read it: `R-FLUTTER-UNDISPOSED-CONTROLLER`, `R-FLUTTER-UNCANCELLED-SUBSCRIPTION`,
  `R-FLUTTER-SETSTATE-AFTER-AWAIT`, `R-FLUTTER-INHERITED-IN-INITSTATE`. `State`
  and framework names need a `package:flutter/` (`Timer`: `dart:async`) import
  candidate; any mention in `dispose()` counts as released; a class with a mixin
  outside a known framework list, or a custom base state, is skipped. Dogfooded
  on four real Flutter apps (86 State classes, 202 `setState` calls, 60 after an
  `await`, 49 of them guarded): 16 findings, all verified genuine (5 undisposed
  `TextEditingController`/`ScrollController`, 11 `setState` after `await` without
  `mounted`), 0 false positives found.
- **Flutter a11y hardening (Flutter analysis, Phase 4; rule version 1.1.0):** the
  three `R-A11Y-FLUTTER-*` checks keep their whole-file AST search (user decision:
  not migrated onto the widget graph — measured on four real apps, 4 of 44
  genuine findings lie outside the graph: method bodies with Dart 3 syntax the
  1.0.0 grammar cannot structure, and widgets in non-slot arguments such as
  `suffixIcon:`). Hardened instead: candidates come from `DartCallSite`, so
  `const`/`new`/`prefix.Widget(…)` and `const InputDecoration(…)` are recognised;
  a widget counts only with a `package:flutter/` import candidate in its own file
  (`src/analysis/dart/DartIdentity.ts`, shared with the widget graph; a same-file
  class shadows it); `ExcludeSemantics` hides (not with `excluding: false`),
  `Tooltip(message:)` names an IconButton, and the ancestor walk stops at callback
  closures (only `*builder` closures are passed through). `MergeSemantics` is
  still reported (user decision). Finding delta on the four apps against a fresh
  worktree of the previous commit: exactly one finding removed (an IconButton
  inside `Tooltip(message: …)`, a false positive), the other 147 findings
  byte-identical.
- **Pipeline:** ingestion → fact extraction → rule engine → findings → reporter.
  No clock/randomness/network in the core; same input + versions + language ⇒
  byte-identical findings.
- **Optional, switchable layers:** type-checker facts (`--typecheck`), dead-export
  analysis (`--dead-exports`), SOLID hints (`--solid`), LLM interpretation
  (`--semantic anthropic`).
- **`--typecheck` parity with `tsc -p`:** each TS file is checked inside the
  project of its nearest `tsconfig.json` (parsed with
  `ts.parseJsonConfigFileContent` — `extends`, `lib`, `module`/
  `moduleResolution`, `paths`, `include`/`exclude`, `references`), on the real
  file system, so imports resolve as the compiler resolves them. A file that a
  tsconfig exists for but no reachable project lists (e.g. tests outside
  `include`) is not checked — `tsc -p` does not check it either; a file with no
  tsconfig above it is checked with strict defaults (`tsc --strict <file>`).
  The checker is stoa's bundled TypeScript, not the project's own version.
  `tsc` facts are not stored in the `--cache` (they depend on other files).

## CLI

```
stoa analyze <path> [--format markdown|json|sarif] [--lang en|de]
                    [--include <glob>]... [--exclude <glob>]...
                    [--typecheck] [--dead-exports] [--solid] [--architecture <file>]
                    [--contracts <file>] [--semantic noop|anthropic] [--memory-stats] [--cache]
                    [--baseline <file>] [--update-baseline] [--migrate-baseline] [--only-new]
                    [--min-confidence <0..1>] [--certainty <list>]... [--no-experimental]
                    [--config <file>] [--knowledge <dir>] [--rules <dir>] [--jobs <n>]
stoa eval <path> --expected <file> [--format markdown|json] [--solid] [--architecture <file>]
                    [--contracts <file>] [--knowledge <dir>] [--rules <dir>] [--jobs <n>]
```

- **Formats:** Markdown (human), JSON (machine), SARIF 2.1.0 (CI / code scanning).
- **Languages:** `en` (default) and `de`; rule/principle text, reporter labels and
  dimension names are localized via `LocalizedText` (en fallback).
- **File selection:** `include`/`exclude` globs (picomatch); `node_modules`/`.git`
  are hard-pruned; a single named file bypasses the globs. Default excludes
  additionally cover `build/`, `.next/`, `.nuxt/`, `.turbo/`, `.cache/`,
  `vendor/`, `dist/`, `coverage/` (see Memory-bounded analysis pipeline below
  for why, and for the companion file-size filter).
- `knowledge/` and `rules/` resolve relative to the installed package — the CLI
  runs from any directory after `npm link`/install.
- `--contracts <file>` is accepted by BOTH `analyze` and `eval` (previously
  silently ignored by `eval`) — a malformed/unreadable contract fails fast
  (exit 1) for either command, never a silently-degraded result.
- Output through a pipe is complete at any size: the CLI sets
  `process.exitCode` instead of calling `process.exit()`, which used to end
  the process before an asynchronous stdout was drained and cut piped reports
  at 64 KiB (`stoa analyze … --format json | jq`); regression test
  `test/CliOutput.test.ts`.
- `--architecture <file>` (E5b) loads a declared architecture
  (`stoa.architecture.json`, `schemas/architecture.schema.json`); a broken file
  fails fast the same way (exit 1). It adds the `architecture` summary to the
  report; together with `--solid` it switches the DIP layer rule to stage 2
  (E6d).
- `--memory-stats` prints one progress line to stderr every 100 files —
  current phase (`analysis`, `evaluation` before the graphs, `graphs` once
  they are built, `evaluation` after the rules), files processed/selected, facts
  extracted so far, heap used/limit/total, RSS, external memory, elapsed
  time — plus a final totals line (files, facts, findings, Evidence Graph
  nodes/edges, cache hits if `--cache` was used), and the run's metrics
  (`PipelineMetrics`, also `AnalyzeOptions.onMetrics`): files, facts,
  findings, ModuleGraph nodes/edges, SymbolGraph bindings/nodes and TypeModel
  types (or "not built"), phase timings (discovery, read, extraction, graphs,
  evaluation, total) and peak RSS — once readable, once as a
  `[stoa] metrics-json` line. stdout (the report itself) is unaffected. Off by default — the defaults below need no tuning for a
  typical run.
- `--cache` stores/reuses per-file facts under `<root>/.stoa/cache` across
  runs (see "Per-file fact cache" below) — off by default; omitting it is
  byte-for-byte the previous behavior.
- `--jobs <n>` (also for `eval`) parses and extracts on `n` worker threads —
  same report, more memory, see "Parallel extraction" below. Off by default
  (1, sequential); anything but a whole number >= 1 is a usage error
  (exit 1).
- `--baseline <file>` / `--update-baseline` / `--only-new` — see "Baseline /
  diff mode" below. Off by default; omitting `--baseline` leaves every
  finding exactly as before (no `baselineStatus`, no `AnalysisReport.baseline`).
- `--migrate-baseline` (needs `--baseline`) — converts a baseline written
  under an older finding-identity scheme in place before comparing (see
  "Finding identity scheme 2" below). Without it such a baseline is an
  error (exit 1), never compared. Every entry is classified (`matched`,
  `notReproducible`, `ambiguous`, `duplicate`, with the reason) — stderr,
  JSON `baseline.migration`, Markdown; see docs/en/finding-model.md.
- `--min-confidence <0..1>` / `--certainty <list>` (repeatable or
  comma-separated: `syntactic`, `semantic-heuristic`, `external-tool`) /
  `--no-experimental` — output filters, applied after the baseline step; the
  report records the criteria and the hidden count (`AnalysisReport.filter`).
  Invalid values are usage errors (exit 1). Off by default — omitting them is
  byte-for-byte the previous output.

## Memory-bounded analysis pipeline

Large-repository root cause (profiled, not guessed — see the "Dataflow
Correctness, Symbol Resolution & Cross-Layer Evidence" spec's successor, the
"Memory-Bounded Analysis Pipeline" spec, for the full before/after numbers):
`TypeScriptAdapter` held ONE ts-morph `Project` for the entire `analyze()`
call and never released a `SourceFile` after extracting its facts — AST,
ts-morph's own permanent node-wrapper cache, and the TS compiler's
Program/Checker state all accumulated for the whole repository, never freed,
for the whole run. Separately, the Dart/C/C++/HTML adapters (`web-tree-sitter`,
WASM) never called `Tree.delete()` — a native linear-memory leak invisible to
V8's heap stats (it lives outside the JS heap). Fixed:

- **Per-file release** (`LanguageAdapter.ts`'s `ParseResult.release`, called
  once by `Pipeline.ts` right after `extractFacts`): `TypeScriptAdapter` now
  calls `project.removeSourceFile()`; the four tree-sitter adapters call
  `tree.delete()`. Safe because nothing in `src/analysis/typescript/*`
  resolves a ts-morph symbol ACROSS two files — `OneHopResolution`,
  `ValidationDataflow`, `SymbolResolution` and `SafeParseGuard` are all
  documented and tested as same-file-only, so no analysis needs a sibling
  file's `SourceFile` to still be registered once its own facts are
  extracted. Measured on a real ~300-file repository: peak RSS 909 MB → 451
  MB, wall time 145 s → 5.7 s (this one change plus the file-size filter
  below; see commit history for the isolated before/after of each).
- **Discovery hardening** (`Ingestion.ts`): a directory `readdirSync` cannot
  read (permission error, race with a concurrent delete) is now skipped and
  reported via an optional `onExcluded` callback instead of crashing the
  entire run (previously confirmed against a real external repository with
  one unreadable subdirectory). A new `maxFileBytes` filter (default 1 MB,
  configurable via `StoaConfig.maxFileBytes`) excludes oversized files the
  same way a glob exclude does — found while measuring: a single 3 MB
  generated webpack bundle, sitting outside any default-excluded directory,
  was the single largest memory/time contributor in the measured repository,
  and carries zero analytical value once bundled. An explicitly-named path
  (a single-file analysis root) always bypasses this filter, the same as it
  already bypasses the include/exclude globs. Symlinks are deliberately never
  followed (a `Dirent`'s own `isSymbolicLink()` entry is neither
  `isDirectory()` nor `isFile()`, so this was already true before, just not
  documented as intentional) — the alternative, following them, risks an
  unbounded walk on a circular symlink with no documented need for it here.
- **Memory guard** (`src/MemoryGuard.ts`): every 100 files, `Pipeline.ts`
  compares `process.memoryUsage().heapUsed` against V8's own
  `v8.getHeapStatistics().heap_size_limit` — the same figure a "JavaScript
  heap out of memory" fatal error is measured against, not a fixed MB guess.
  Past 90%, ingestion stops rather than let V8 crash; facts/findings already
  produced are kept (nothing is discarded), and `coverage.status` becomes
  `'partial'` (`coverage.abortReason: 'memory_limit'`,
  `coverage.stoppedAtFile`) — a truncated run is never presented as a
  complete one (see "Analysis Completion Integrity" below for the full
  status/exit-code contract this now feeds). No `global.gc()` call
  anywhere — this guard is a last resort on top of the bounded object
  lifetimes above, not a substitute for them. It also takes a snapshot
  immediately before and after `RuleEngine.evaluate()` (visible via
  `--memory-stats`) — but cannot abort or partially apply that call:
  declarative rules are evaluated per-subject, but the three project rules
  (`DependencyCycleRule`/`DeadExportRule`/`ValidationContractRule`) need the
  complete fact array at once (see "Rule categorization" below), so
  evaluation is one atomic pass. A memory spike strictly inside that one
  call cannot be downgraded to `'partial'` mid-flight; it can only crash the
  process. Named explicitly as an open limitation, not hidden.
- **Metadata-first discovery** (`Ingestion.ts`'s `collectFiles()`, follow-up
  "Analysis Integrity & Memory-Bounded Pipeline" spec): previously read every
  matched file's full content during the walk and returned it all at once —
  the whole repository's text sat in memory before the per-file loop even
  started. `collectFiles()` now returns `FileMeta[]` (path + size only);
  content is read lazily, one file at a time, via `readFileContent()`, and
  only AFTER an adapter has already been chosen by path alone
  (`LanguageAdapter.supports()` takes `FileMeta`, never content) — a file
  nothing can parse is never read into memory at all.
- **A root `.gitignore` is honored** (new `src/GitIgnore.ts`), as a
  deliberately narrow, documented slice: only the repository root's own
  `.gitignore` (no nested-`.gitignore` precedence), no negation (`!pattern`
  lines are skipped — re-inclusion depends on rule order in ways that cannot
  be modeled safely as one more exclude pattern), translated to picomatch
  patterns using the same depth rule git itself uses (no slash → matches at
  any depth; a leading/inner slash → anchored to root). Merged alongside the
  existing exclude list, so an explicitly-named analysis path still bypasses
  it like every other exclude source.
- **No `--jobs`/worker-based concurrency, a considered decision, not an
  oversight:** the file-processing loop is already fully synchronous — there
  is no parallelism to bound in the first place, so the premise behind a
  `--jobs` flag does not hold. More importantly, real OS-thread parallelism
  (`worker_threads`) would INCREASE peak memory, not decrease it — each
  worker needs its own ts-morph/tree-sitter instance, so N workers multiply
  the exact per-file footprint this section just bounded to 1, in exchange
  for throughput, not memory safety, which is this section's actual subject.
  It would also be a substantial, higher-risk rewrite (cross-thread fact
  serialization, a deterministic merge order, a memory guard that makes
  sense per-worker) disproportionate to "small, verifiable phases." Confirmed
  with the project owner before skipping rather than silently dropped.
- **Incremental/cached analysis** was added narrowly instead — see "Per-file
  fact cache" below — once a cache boundary that could be reliably
  invalidated was identified.
- **Scaling test** (`test/MemoryPipelineScaling.test.ts`): a synthetic,
  generated-on-the-fly, mixed-language (TS+PHP), multi-directory repository
  with several Validation Trace ID annotations spread across different
  files — asserts the analysis completes in full, is deterministic across two
  runs, produces no duplicate finding identities, and loses no Evidence Graph
  connection (one `validation.dataflowGraph` fact per annotated-and-invoked
  validator, regardless of which file it lives in). Deliberately NOT a
  memory-threshold assertion (an RSS/heap ceiling in a test is unreliable
  across machines and Node versions) — the real, reproducible before/after
  numbers above came from manually measuring real external repositories with
  `/usr/bin/time -v`, not from a CI-gated benchmark.

### Parallel extraction (opt-in, `--jobs`)

`--jobs <n>` (for `analyze` and `eval`; `AnalyzeAsyncOptions.jobs` of the new
`analyzeAsync`) parses and extracts files on `n` worker threads. Without it
(or with 1) the run is the sequential path, unchanged.

- **What runs where:** each worker (`src/ExtractionWorker.ts`, the work in
  `src/ExtractionWorkerTasks.ts`) holds its own adapters
  (`createAdapterRegistry()`, `src/analysis/DefaultAdapters.ts`) and loads a
  tree-sitter grammar the first time one of its files needs it (`grammarOf`);
  it only parses, extracts and releases. Everything else stays on the main thread: discovery, the memory
  guard, reading each file, the fact cache, `--typecheck`, the graphs and the
  rules.
- **Same report, by construction:** every file's result is a `FileOutcome`
  (`src/FileExtraction.ts`), and both drivers — the synchronous `analyze` and
  `analyzeAsync` — apply the outcomes in file order through the same
  `Ingestion.commit`. Facts, counts, the excluded sample and the cache contents
  therefore come out the same however the workers are scheduled.
- **Bounded memory in flight:** at most `n` × 4 files are read but not yet
  applied, and each worker gets at most 2 files at a time (`ExtractionPool`).
- **Memory guard:** the main-thread guard samples at the same file positions
  as before. In addition, each worker checks its own heap (its own V8 isolate
  and heap limit, `isHeapCritical`) before each file and answers
  `memoryCritical` instead of parsing. Either way the run stops at the first
  file not yet applied, with `abortReason: memory_limit` and every earlier
  file kept.
- **Failures:** an adapter error in a worker fails the run as on the main
  thread. A worker that dies (an exit while it still owes answers, e.g. its
  heap ran out) fails the whole pool: open tasks are rejected, the CLI writes
  a `failed` report (exit 1). Nothing hangs, and no file is lost silently.
- **API:** `analyze()` stays synchronous and sequential. `analyzeAsync()`
  loads the grammars, then runs the sequential path (`jobs` ≤ 1) or the
  parallel one. The CLI uses `analyzeAsync` for `analyze` and `eval`.
- **Cost and start:** a worker needs ≈ 0.4–0.6 s before its first file,
  ≈ 0.35 s of it compiling TypeScript, ts-morph and the adapters. Therefore:
  - all workers start first thing in `analyzeAsync`, overlapping the loading
    of knowledge base and rule set and discovery (the main thread loads no
    grammar in parallel mode — it parses nothing);
  - a worker loads a grammar only when a file needs it (a TypeScript-only
    run loads none, ≈ 30–55 ms per worker);
  - workers turn on Node's module compile cache (`module.enableCompileCache()`,
    Node ≥ 22.1) before loading anything and write it right after loading:
    compiled code is kept in Node's default directory
    (`os.tmpdir()/node-compile-cache`, ≈ 7–9 MB) and later runs' workers load
    in about half the time. Only worker threads do this — a run without
    `--jobs` writes nothing beyond its report, as before;
    `NODE_DISABLE_COMPILE_CACHE=1` turns it off; a Node without the API just
    compiles.

  Measured with `--jobs 4` against the previous state (three alternating
  pairs, warm cache, reports byte-identical): stoa 2.72–2.76 s → 2.41–2.56 s,
  the Dart app 2.34–2.79 s → 2.12–2.15 s, a small fixture 1.15–1.24 s →
  0.85–0.98 s, flyingfish 3.74–4.25 s → 3.62–3.99 s (under load 5.6). The
  first run, which fills the cache, takes as long as before (2.71–2.75 s vs
  2.66–2.75 s). Every worker has its own heap and its own adapters, so peak
  RSS grows with `n`.
- **Measured** (CLI wall time, two runs each, on a 4-core/8-thread laptop
  under desktop load; reports byte-identical in every run):

  | Target | Files | `--jobs 1` | `--jobs 2` | `--jobs 4` |
  |---|---|---|---|---|
  | flyingfish (TS) | 952 | 4.75–4.79 s, 0.80 GB | 3.89–4.16 s, 1.0 GB | 3.74–3.90 s, 1.45 GB |
  | stoa (TS) | 494 | 2.95–2.96 s, 0.56 GB | 2.79–2.86 s, 0.86 GB | 2.76–2.80 s, 1.05 GB |
  | swipemeister/app/lib (Dart) | 166 | 3.20–3.23 s, 0.25 GB | 2.44–2.52 s, 0.41 GB | 2.26–2.60 s, 0.62 GB |

  The gain is smaller than the core count suggests. In the stoa run every
  worker was busy ≈ 1.8 s for ≈ 2.1 s of sequential extraction work in
  total: each worker warms its own JIT, and on this machine four busy cores
  share a lower turbo clock and hyper-threads with the desktop. Small runs
  can even be slower than sequential (the workers' start dominates). Hence
  opt-in, without an automatic default.
- **Tests:** `test/ParallelExtraction.test.ts` — `jobs` 3 equals the
  sequential run (report and facts byte for byte) on fixtures of every
  adapter, on the whole fixture tree with every file selected, and on a
  directory mixing parsed, unsupported and unreadable files; with the fact
  cache; the compile cache (filled only by workers, none without `--jobs`,
  none with `NODE_DISABLE_COMPILE_CACHE=1`); the main-thread and the worker
  memory guard; a dying worker
  (test-only hook `STOA_TEST_WORKER_EXIT`); an adapter error; CLI `--jobs 2`
  equal to the sequential output, invalid `--jobs` values as usage errors.
  Mutation-checked: applying outcomes out of order, ignoring the worker
  guard, not filling the fact cache, not loading a needed grammar, or not
  turning on the compile cache each fail tests. The golden corpora pass
  with `--jobs 4` as without it, and 18 comparison runs give the same
  findings with `jobs` 1 and 4.

### Per-file fact cache (opt-in, `--cache`)

An incremental-analysis slice narrow enough to be confident is correctly
invalidated, per the spec's own explicit priority ("a correct full analysis
beats a fast but stale cache"). `src/FactCache.ts` caches exactly ONE thing:
the facts produced by extracting a single file with a single adapter
(`LanguageAdapter.extractFacts` / `TypeDiagnosticsExtractor.extract`) — never
a rule-evaluation result or a finding. That boundary is what makes the
invalidation story airtight:

- **Cache key:** `(engineFingerprint(), adapter id, file path, file content
  hash)`. Reading every adapter confirms fact extraction depends on nothing
  else — no adapter reads `ProjectContext.rootDir` or another file's
  content, so this key is complete, not an approximation.
- **`engineFingerprint()`** is a hash over every source file the running
  engine is actually built from (the directory the running `Pipeline.js`/
  `Pipeline.ts` module itself lives in — `dist/` once compiled, `src/` under
  `tsx`), computed once per process. A change to the actual fact-extraction
  code invalidates the cache automatically — there is no manually-maintained
  version string to remember to bump. Coarser than a per-adapter fingerprint
  (any engine change invalidates every cached file, not just the ones whose
  extraction logic actually changed) — a deliberate trade favoring a
  guarantee that holds by construction over one that depends on discipline.
- **Rule/contract changes can never serve a stale finding**, by construction:
  `RuleSet`/`ValidationContract` are consumed only AFTER this cache, fresh,
  on every single run — there is nothing cached downstream of them that
  could go stale. This is also why no rule-set or contract version needs to
  be part of the cache key at all.
- **A corrupted or unreadable cache entry is a miss, never a crash** — it
  degrades to recomputing that one file, by design. This now includes
  STRUCTURAL validation (`isValidFact()`), not just "is `facts` an array":
  every element's `id`/`kind`/`subject`/`value`/`evidence`/`certainty`/
  `producedBy` is checked, and if even ONE fact in a cached entry fails, the
  whole entry is a miss — a cache file that is syntactically valid JSON but
  semantically wrong (a missing field, a value of the wrong type) must not
  silently feed a malformed value into a real analysis.
- **Explicitly not attempted, and why:** no `tsconfig.json` dependency
  tracking (nothing in today's TypeScript analysis reads a tsconfig — the
  ts-morph `Project` is in-memory with no `tsconfig.json` loaded — so there
  is nothing to invalidate); no cross-file dependency tracking (no
  cross-file fact extraction exists today — same reasoning, and the same
  constraint the per-file release in the previous section already depends
  on). If either becomes true, this cache's correctness argument must be
  revisited, not assumed to still hold.
- **CLI:** `--cache` (boolean, off by default) stores under
  `<root>/.stoa/cache` — already covered by the existing `.stoa/**` default
  exclude. Omitting it is byte-for-byte the previous behavior: nothing is
  read from or written to disk beyond the analysis target itself.
  `coverage.cacheHits` is present only when the flag was used.
- **Measured** on the same real ~300-file repository as above: cold run
  5.5s / 451 MB, warm (fully cached) run **0.84s / 203 MB** — report output
  identical except for the new `coverage.cacheHits` diagnostic field itself
  (verified by diffing the two JSON reports, not just eyeballing timings).

## Analysis Completion Integrity & Memory-Bounded Evaluation (follow-up spec)

Two goals, from the governing principle: "Stoa may only report as proven
what was actually, completely analyzed and is backed by the analysis
information that exists" — a smaller, fully and correctly analyzed codebase
is worth more than a large one whose analysis silently stays incomplete.

**A single, centrally-managed status.** `coverage.status: 'complete' |
'partial' | 'failed'` (`src/Types.ts`'s `AnalysisStatus`) is now the one
field anything branches on:

- `'complete'`: every selected file was either analyzed or intentionally
  excluded for a documented, non-coverage reason.
- `'partial'`: at least one file Stoa intended to analyze was not reached —
  a memory-guard abort, or a read/parse failure on a selected file (a race
  with a concurrent delete/move between discovery and read, or a parser that
  failed on content it was expected to handle). `coverage.analysisIncomplete`
  (the previous boolean) is kept, but is now always DERIVED from `status` at
  the same point it is set — nothing ever sets it independently, so the two
  can never disagree.
- `'failed'`: a config/setup error (bad `--knowledge`/`--rules`/target path)
  prevented a real report from existing at all. `analyze()` itself never
  returns this — it throws, same as before — but `Cli.ts` now catches that
  exception and synthesizes a minimal, validly-shaped report
  (`AnalysisReport.error` carries the message) so JSON/SARIF/Markdown output
  stays parseable instead of a bare stack trace with nothing on stdout.

**Exit codes (`stoa analyze` only — `stoa eval` keeps its existing
precision/recall pass/fail code, see below):** `0` only for `'complete'`;
`1` for an execution/config/usage error (bad flags, a malformed baseline/
contract file, or a caught setup exception — `'failed'`); `2` whenever
`coverage.status !== 'complete'` — an incomplete scan can never be
indistinguishable from a clean one by exit code alone, on any output format
(verified end-to-end for all three formats in
`test/AnalysisStatusCli.test.ts`). This is a deliberate behavior change from
the prior spec: comparing an incomplete scan against a baseline (without
`--update-baseline`) used to exit `0`; it now exits `2`.

**Structured exclusion reasons**, replacing a freeform diagnostic string:
`ExclusionReason` (`src/Types.ts`) is a closed set —
`excluded_by_config`, `excluded_by_gitignore`, `file_too_large`,
`unsupported_language` (never alone enough to make a run `'partial'` — Stoa
never intended to fully analyze these), vs. `read_error`, `memory_limit`,
`analysis_cancelled` (genuine coverage gaps, which do). `Ingestion.ts` now
tracks config-excludes and `.gitignore`-excludes as two separate matchers
specifically so they can be reported under their own distinct reason
(previously merged into one list, indistinguishable after the fact).
`coverage.excludedByReason` is an exact per-reason count, always complete,
never capped — bounded by construction (seven reasons) regardless of repo
size. `coverage.excludedSample` is a bounded (20) list of example
`{path, reason, detail?}` entries for human debugging — deliberately NOT
the full list: an unbounded per-file array here would reintroduce the exact
kind of unbounded growth this phase exists to avoid. The memory-guard abort
tail (every selected file never even looked at) is represented as a COUNT
(`coverage.filesCancelled`, mirrored into
`excludedByReason.analysis_cancelled`), not one entry per remaining path,
for the same reason. Verified against a real repository (`bambooo`, 314
files): `excludedByReason: {excluded_by_config: 542,
excluded_by_gitignore: 1}`, `status: 'complete'` — hundreds of structurally
excluded files, correctly never flipping the run to `'partial'`.

**Rule categorization (`ProjectRule.requiredFactKinds`, `src/rules/
ProjectRule.ts`)**: each of the three project rules now declares exactly
which fact KINDS it reads — `DependencyCycleRule`: `['deps.import']`;
`DeadExportRule`: `['deps.importName', 'deps.export']`;
`ValidationContractRule`: the four `validation.*` kinds it scans. A new,
separately-tracked `ProjectRuleInput.analyzedFiles` (computed by
`RuleEngine` directly from the fact set's file paths, independent of which
KINDS survive any future filtering) replaced each rule's own
`new Set(facts.map(f => f.subject.file))` — needed because
`DependencyCycleRule`/`DeadExportRule` resolve import targets against "does
this file exist in the analyzed set", which a kind-filtered fact array alone
cannot answer (a file with zero `deps.*` facts would otherwise silently stop
being a valid target). `test/ProjectRuleCategorization.test.ts` proves the
declarations are truthful: running each rule against ONLY its declared
kinds (plus the independently-tracked `analyzedFiles`) produces IDENTICAL
findings to running it against the full fact set, on a fixture that
actually exercises all three.

**Deliberately NOT done, and why — read this before assuming more than
what is here:** the categorization above is metadata only. The main
pipeline still gives every project rule the COMPLETE fact array, and
`Pipeline.ts`'s `facts: Fact[]` is still accumulated in full for the whole
run, never filtered or released early. Two existing, correctness-relevant
consumers depend on this: the optional semantic layer
(`src/semantic/SemanticRunner.ts`'s `buildRequest()` filters `result.facts`
by file+line to ground an LLM verdict for ANY selected finding, file-local
or not) and the finding/evidence-traceability guarantee
(`test/FindingModel.test.ts` asserts every finding's evidence fact kind is
actually present in `result.facts`). Filtering the retained fact array down
to only the project rules' declared kinds — the obvious next step — would
silently break both for the vast majority of findings (file-local ones),
which is exactly the kind of regression the spec's own quality bar forbids
("no regressions on existing rules", "keep existing public APIs as
compatible as possible"). Wiring real incremental fact release would need
those two consumers redesigned first (e.g. re-reading a file's facts on
demand from the fact cache instead of the in-memory array) — a larger,
separate change this round deliberately did not attempt without that prior
dependency analysis. This is the single largest open item in "memory-bounded
evaluation": `RuleEngine.evaluate(facts)` remains one atomic, unbounded pass
over the full fact set, by necessity today, not by oversight.

## Finding identity scheme 2 (Finding Identity spec, phase 1, 2026-11-04)

A finding's identity is (project-relative file, rule id, `location.symbol`)
— positions stay out of it. Phase 1 makes the symbol part stable and
unambiguous across all four languages and versions it.

- **Two layers, kept apart.** Declaration names (functions, types) come
  from the adapters (`declarationSymbols`/`variantBases` in
  `src/FindingIdentity.ts`); finding sites below a declaration are named by
  one shared post-pass, `assignSiteSymbols` (`src/analysis/SiteIdentity.ts`).
  An extractor marks a site fact with `FactSpec.site` and keeps naming it by
  its legacy per-file ordinal (`catch#3`); the pass renames it relative to
  the innermost enclosing function (its `metric.cyclomaticComplexity` fact)
  or type (`struct.typeDecl`) whose range contains it, numbered per (scope,
  kind) in source order: `Service.load>catch#0`. Imports are named by module
  (`import:./db`). A site outside every declaration keeps the ordinal. The
  pass needs no symbol resolution; it reads ranges the adapters already
  produce (the SymbolGraph resolves ES import names, not declarations, and
  is not involved).
- **Namespaces:** PHP namespaces prefix function and class symbols
  (`App\Svc\Repo.find`, `App\Entity\Order.customer`); C++ namespaces are
  joined with `::` (`(anonymous)` for an anonymous one); TS `namespace A.B`
  no longer yields `A.B.B`; an unnamed Dart extension is `(extension on T)`.
- **Overloads and accessors:** a shared base is told apart by its variant
  before any `#n` — `A.size:get`/`A.size:set`, `f(int)`/`f(double)`.
- **Versioning:** `IDENTITY_SCHEME = 2`. The scheme travels through
  `AnalyzeOptions.identityScheme` → `ProjectContext` → `AdapterInfo` (and
  the worker config under `--jobs`); a run under an older scheme bypasses
  the fact cache. A baseline stores `"identity": 2`; a file without the
  field is scheme 1. `applyBaseline` throws on a mismatch, the CLI exits 1
  with the way out. `--migrate-baseline` (`src/BaselineMigration.ts`)
  analyzes the same code under both schemes (sequentially), pairs findings
  by `Finding.id` (rule, file, position — equal in both runs, only symbols
  differ), carries entries over, and drops and lists entries no current
  finding reproduces; it refuses a non-`complete` run and an identity
  collision. Best run on the code state the baseline was written for.
- **Golden changes (renames only):** under both schemes every corpus
  produces the same findings (paired by `Finding.id`: 0 added, 0 lost); only
  `location.symbol` changed — main corpus 28, JSX 14, Flutter 6,
  catch-intent 6, eval-multi 3, validation-dataflow 13, eval fixtures 1 each.
  HTML, Vue, Angular and the SOLID corpora are unchanged (file-level sites,
  or symbols without sites).
- **Limits:** `tsc#`/`promise#` (type diagnostics, produced in the
  pipeline, not by an adapter), `reexport#` and `directive#` keep per-file
  ordinals; so do sites outside a function or type (a `// stoa:validation`
  annotation on a top-level schema constant, static markup). A site whose enclosing declaration is
  renamed is renamed with it — that is a real identity change, which
  `--migrate-baseline` does not cover (it pairs by position on one code
  state).
- **Tests:** `test/IdentityScheme.test.ts` (namespaces TS/PHP/C++,
  PHP class namespace incl. ORM/DDL, Dart extension, overloads, TS module
  names, site stability under an edit in another declaration for all four
  languages incl. a scheme-1 contrast, imports, fact order, `--jobs` 2 =
  sequential, baseline scheme guard, `migrateBaseline`, CLI refuse/migrate/
  usage error); the existing identity tests are updated to the new names.

## Finding identity in evaluator, baseline, snapshot and de-duplication (Finding Identity spec, phase 2, 2026-11-04)

One identity definition — `findingKey`/`keyString` in
`src/FindingIdentity.ts` — now serves every consumer; what was different
before:

- **De-duplication** (`RuleEngine`): the declarative key gains the symbol
  (`file:line:col:symbol:feature`), so two subjects at one position are never
  merged; project-rule findings are no longer merged at all (they were keyed
  by `Finding.id`, a position — two different identities at one position
  would have collapsed silently, and a repeated identity would have been
  hidden from the evaluator). Measured before the change over the repository
  targets, the 10 own projects and the JSX, HTML, Angular, catch-intent and
  eval-multi fixtures: the de-duplication
  merged nothing — no output changes. The documented concept (one problem
  seen by several declarative rules = one finding, stable wins) stays.
- **Evaluator:** a corpus manifest records its identity scheme
  (`"identity": 2`, absent = 1, see `src/evaluation/Corpus.ts`); another
  scheme is refused with the reason (exit 1, nothing evaluated). All manifests
  in the repository carry `"identity": 2` (metadata only, no entry changed).
- **Baseline:** collisions are found and worded by the shared
  `duplicateKeys`/`duplicateIdentityText` (also in `saveBaseline` and the
  migration). A comparison whose current run repeats an identity lists it in
  `baseline.duplicateIdentities`, warns on stderr and appends "N identity
  collision(s), status unreliable" to the Markdown baseline line; the copies
  are not merged. `--update-baseline` refuses such a run as before.
- **Snapshot and snapshot diff:** `scripts/compare-findings.ts` no longer has
  its own key (rule, file, symbol, statement); it pairs by identity through
  `src/FindingDiff.ts` (`diffFindings`) and
  tells a shift (`moved`: only `id`/`location.range` differ) from a change
  (`changed`, with the differing fields). A snapshot records its scheme in
  `snapshot.json`; two schemes are paired by `Finding.id`, with a second
  pass by identity for findings that moved and kept their name.
- **Limits:** a position inside an evidence value counts as content (a
  shifted finding with such a value reads `changed`, never unchanged); the
  winner of a declarative merge is the first rule in rule-set order (no two
  shipped rules share a feature, so it does not occur today).
- **Tests:** `test/FindingIdentityIntegration.test.ts` (de-duplication,
  `duplicateKeys`, `FindingDiff` both pairings, and through the real
  processes: `stoa eval` manifest schemes and identity collision, `stoa
  analyze --baseline` shift/new site/rename and a repeated identity on
  stderr/JSON/Markdown with `--update-baseline` refusing, the snapshot
  script's `same`/`moved`/`CHANGED`/`INTEGRITY` and cross-scheme diff);
  `test/RuleGovernance.test.ts` E1a now checks that project findings stay
  apart and that stable wins in a declarative merge.

## Evaluation memory and lifetimes (Finding Identity spec, phase 3, 2026-11-04)

Measured first (phase 0, then per stage with heap probes in a scratch copy;
a forced GC only there, as a measuring tool — never in the code): the
evaluation is not where the memory goes. Peak RSS is reached in the
extraction; during graphs and rules the retained heap grows by ≤ 2 MB
(graphs ≈ 1 MB, the declarative grouping ≈ 1.4 MB), and the evaluation takes
55 of 1,240 ms (flyingfish backend) to 230 of 3,500 ms (swipemeister).
What the measurement did find, and what changed:

- **Adapters released after the ingestion.** The adapter registry moved
  from the run into `Ingestion` and is dropped by `Ingestion.finish()` once
  the last file is applied; the report's adapter versions are read up front.
  The sequential loop runs in a function of its own (`ingestSequentially`),
  so the last file's adapter is not kept reachable from `analyze`'s frame.
  Before, the TypeScript adapter's shared Project with the lib files (built
  once a script or `declare global` file was parsed) stayed alive through
  graphs and rules: retained heap during the evaluation of the flyingfish
  backend 92–94 → 62–63 MB (−30 MB). Projects without such files are
  unchanged (stoa, swipemeister, velyo).
- **Declarative grouping ends before the project rules**
  (`RuleEngine.evaluateDeclarative`): ≤ 1 MB, kept because it costs nothing.
- **Dart URI resolution memoized.** `DartLibraryIndex` resolved every
  import URI again (path join/normalize) for every name lookup and rebuilt a
  library's declaration set each time; `resolveUri` and the declarations are
  now cached (pure over the immutable index; the relative-URI key includes the
  directory). This was most of `R-SOLID-DIP-CONCRETE-DEPENDENCY` on Dart and
  of the widget graph.

| target (5 runs, median) | evaluation ms | graphs ms | total ms | peak RSS MB |
|---|---|---|---|---|
| velyo (Dart) | 152.6 → 81.8 | 76.3 → 44.1 | 1,723 → 1,641 | 310 → 282 (spread 268–310) |
| swipemeister + architecture (Dart) | 216.4 → 159.2 | 98.0 → 72.7 | 3,427 → 3,299 | 452 → 450 |
| flyingfish backend (TS) | 59.3 → 61.5 | 21.8 → 23.2 | 1,227 → 1,203 | 363 → 403 (spread 362–416, both sides) |
| flyingfish backend, `--jobs 4` | 84.5 → 67.0 | 45.9 → 30.9 | 1,901 → 1,880 | 1,007 → 997 |
| stoa `src` (TS) | 65.5 → 64.1 | 20.6 → 19.7 | 1,124 → 1,119 | 366 → 373 |

Facts, findings, ModuleGraph/SymbolGraph/TypeModel sizes are identical in
every run (also flyingfish frontend/schemas, mwpa); the findings snapshots
before/after are identical (`scripts/compare-findings.ts`). Peak RSS shows
no change beyond its run-to-run spread — it is set by the extraction.

- **Rule classification: not introduced as a mechanism.** By what they
  read: the 40 declarative rules are local (one subject's facts);
  `R-DEP-CYCLE` (always on) and the SOLID rules need the ModuleGraph; only
  the SOLID rules with `usesTypeModel` need the SymbolGraph, which is
  already built only then; the Flutter layout rules (always on) read the
  widget graph, which is empty without Dart; dead exports, Flutter lifecycle,
  validation contracts and SRP read the whole fact set. Every graph is thus
  needed by an always-on rule or already built on demand, and the project
  rules need all facts — a classification would add a mechanism with no
  memory or time to gain. No streaming: nothing measured supports it.
- **Not measured reliably:** the transient garbage per rule (`heapUsed`
  before a GC depends on when the young generation was last collected).

## Semantic gaps closed: PHP PSR-4, C/C++ includes, Dart accessors and closures, PHP types (Finding Identity spec, phase 4, 2026-11-05)

The four gaps chosen from the phase-0 inventory. Every relationship keeps an
explicit state — resolved, unresolved, ambiguous, external, or unknown
(`external` absent) — and nothing without evidence is reported as resolved.
One resolver per language, no second one: the ModuleGraph's (via
`ModuleResolver`), the TypeModel reads its results.

- **PHP `use` through composer.json PSR-4.** `ProjectConfig.psr4` reads the
  root composer.json `autoload`/`autoload-dev` `psr-4` (never `vendor/`).
  `ModuleResolver.resolvePhpClass` follows Composer's order: longest prefix
  first, directories as declared, the first existing file wins — resolved
  only when that file was analyzed; an earlier candidate that exists on disk
  but was not analyzed leaves the name unresolved instead of letting a later
  one win. ModuleGraph: a PHP `use` (a `deps.import` that now carries
  `useKind`) becomes an edge with `resolution: 'psr4'`, or an unresolved
  entry with `external: true` (outside every prefix, composer.json present),
  `false` (under a prefix without a file; also every `use function` /
  `use const` — PSR-4 loads classes only) or no `external` (no composer.json:
  unknown). Before, every PHP `use` went through the TypeScript resolver and
  was called external.
  - A group use `use App\{A, B}` now names its items with the group prefix
    (before: `A`, `B`) — the values of `deps.importDeep`/`deps.importUnused`
    for group uses change accordingly.
  - `R-DEP-CYCLE` counts PSR-4 edges as it counts a TS `import` (only
    `import type` is skipped; PHP has no type-only `use`) — the documented
    intent of "PSR-4 resolution so R-DEP-CYCLE covers PHP".
- **C/C++ `#include` facts.** `cpp.include {module, form, conditional}`:
  `form` = `quoted` / `system` / `macro` (`#include NAME`, header unknown);
  `conditional` = inside `#if`/`#ifdef`/`#elif`/`#else` other than the
  include guard (a top-level `#ifndef X` + `#define X` that is the whole
  file). ModuleGraph: a quoted include resolves to the file next to the
  including one (`relative`, origin `cpp.include`) — the first place every
  compiler searches; otherwise unresolved with `external` unknown (include
  paths `-I` are not known without the build). `<x>` of an ISO C/C++
  standard header (`StandardHeaders.ts`) is external; any other `<x>` and
  every macro include stays unknown. `R-DEP-CYCLE` 1.1.0 counts
  unconditional include edges (statement unchanged; `missingContext` names
  the new limits). The architecture rule judges include edges by layer and
  a `<x>` as a package only when it is a standard header.
- **Dart accessors and closures measured.** Getters and setters
  (`X.v:get` / `X.v:set` when both exist, as TypeScript's accessors) and
  function expressions — named by the variable or field they initialize
  (`A.m.f`), else `<scope>.(anonymous)#n`. Their bodies were already left
  out of the enclosing function's metrics, so no existing metric changes;
  they were simply unmeasured. A closure inside a function gets no
  widget-tree fact (part of the enclosing tree). (Its nondeterminism was at
  first read with the enclosing function's whole body; since 2026-11-07 it
  is its own fact, see "External validation".) A function
  expression inside a region tree-sitter had to recover (`file.parseErrors`
  — Dart 3 records, patterns, switch expressions) is not measured: it is
  often a misread record (an "18-parameter closure" in velyo was one).
  Scheme 1 measures named functions only, as before. Sites inside a closure
  (catch, accessibility) are now scoped to it — as in TypeScript.
- **PHP types in the TypeModel.** PHP emits `struct.typeDecl` (scheme 2,
  `src/analysis/php/PhpMembers.ts` on the shared AST helpers in `PhpAst.ts`) for
  named classes, interfaces, traits and enums under their identity
  (`App\Service\UserService`): a trait is a `mixin`, its `use` in a class a
  `with` supertype; members with body shape (`throws-unsupported` by the
  TypeScript adapter's rule), `#[\Override]`, promoted constructor
  parameters, and body references. `struct.importBindings` carries the class
  `use`s and the file's namespace (`null` when the file declares several).
  The TypeModel resolves a PHP name by PHP's rules (`\X`; first segment = a
  `use` alias; `namespace\X`; else relative to the namespace) to the
  declaration with that identity, case-insensitively; several → ambiguous;
  none → external only when the name came through a `use` the ModuleGraph
  placed outside the project, else unresolved (`\Exception`, …). The LSP and
  ISP rules thereby judge PHP; `R-SOLID-DIP-CONCRETE-DEPENDENCY` stays
  Dart-only (its UI classification is).
- **Bug fixed on the way:** an abstract or interface method (`body: null`)
  made the PHP extraction throw — at HEAD, one such file ended the whole
  analysis as `failed` with no file analyzed. Such methods are now skipped
  (they have nothing to measure).
- **Dynamic and unknown constructs (inventory).** Explicitly unknown, never
  resolved: C/C++ macro includes, quoted includes not next to the includer,
  non-standard `<x>` headers, conditional includes (edge flagged, outside the
  cycle view); PHP names without composer.json; PHP names in a file with
  several namespaces. Not modelled at all (no fact, so no claim): PHP
  `new $class`, `$x::m()`, `require $path`, classmap/`files` autoloading,
  PHP references without a `use` in the ModuleGraph (the TypeModel does
  resolve them), Dart function expressions in recovered regions.

Measured (findings snapshots before → after, `scripts/compare-findings.ts`;
`--jobs 1` and `--jobs 4` identical; all golden corpora unchanged and
passing):

| target | change | why |
|---|---|---|
| corpus, flyingfish backend/frontend | `R-DEP-CYCLE` changed (version 1.1.0, `missingContext`) | rule semantics extended |
| swipemeister | + `R-SIDEEFFECT-NONDETERMINISM` `_WinnerFrameState._remaining` | a getter calling `DateTime.now()`, unmeasured before |
| swipemeister | `R-A11Y-FLUTTER-IMAGE-LABEL` `_CardBackground.build>image#1` → `_CardBackground.build.(anonymous)#1>image#0` | the image sits in a closure, now a scope |
| velyo | + `R-DEEP-NESTING` `ContentPack.allWords` | a getter, depth 4 |
| velyo | + `R-COMPLEXITY-COGNITIVE`, `R-DEEP-NESTING` `_PathMap.build.(anonymous)#4` | a 220-line `LayoutBuilder` closure, cognitive 39 |
| velyo | `R-A11Y-FLUTTER-IMAGE-LABEL` `_GeoQuizState.build>image#0` → `…build.(anonymous)#1>image#0` | as above |
| stoa (self) | `childNodes` findings moved with the function to `PhpAst.ts`; `StructFacts` 17 → 18 exports (`UNSUPPORTED_MESSAGE`, now shared by TS and PHP) | refactoring |

No PHP or C/C++ project is among the comparison targets; the PHP/C/C++
behaviour is covered by tests (`PhpModuleResolution`, `CppIncludes`,
`FunctionIdentity`).

## Parallel extraction compared: `--jobs` 1/2/4/8 (Finding Identity spec, phase 5, 2026-11-05)

A reproducible comparison of the opt-in parallel extraction (see "Parallel
extraction") against the sequential run, over nine targets of different
languages and sizes. No code path changed; the result is the measurement and
the harness `scripts/compare-jobs.ts`.

- **Harness:** `npx tsx scripts/compare-jobs.ts [--targets <file>] [--jobs
  1,2,4,8] [--runs N] [--out <dir>] [--cache] [--errors]` (after `npm run
  build`; it runs `dist/Cli.js analyze --format json`). A preload records
  the main process's `process.resourceUsage()` at exit — peak RSS
  (`maxRSS`, worker threads included, they share the process) and user +
  system CPU time — and the load average is recorded per run. The order of
  the configurations rotates each round; the table holds the median and the
  range. Every run is compared with the sequential one: findings byte for
  byte (paths relative), identities, order, coverage (without `cacheHits`)
  and exit code. `--cache` runs writer/reader pairs on copies of the targets
  (each configuration with itself, plus sequential → `--jobs 8` and back);
  `--errors` runs a generated project with broken, unreadable and non-source
  files and the test hooks `STOA_TEST_FORCE_INCOMPLETE` (memory guard) and
  `STOA_TEST_WORKER_EXIT` (dying worker). Results go to `runs.json` (raw)
  and `result.md` in `--out` (default `.stoa/compare-jobs`), written after
  each section. Targets as in `compare-findings` (`.stoa/` for private ones).
- **Measured** (5 runs per configuration, 8-thread laptop under desktop
  load, load average 4–9 during the runs; median wall time and peak RSS,
  change against sequential):

  | Target | Files | sequential | `--jobs 2` | `--jobs 4` | `--jobs 8` |
  |---|---|---|---|---|---|
  | golden corpus (mixed) | 34 | 0.85 s, 167 MB | +6 %, ×1.9 | +13 %, ×2.8 | +38 %, ×4.6 |
  | PHP API | 36 | 0.88 s, 204 MB | +8 %, ×1.7 | +15 %, ×2.6 | +43 %, ×4.4 |
  | Dart app (small) | 52 | 2.40 s, 236 MB | −21 %, ×1.6 | −26 %, ×2.5 | −18 %, ×4.2 |
  | stoa `src` (TS) | 111 | 1.82 s, 335 MB | −6 %, ×1.8 | −7 %, ×2.4 | +17 %, ×3.7 |
  | Dart app (medium) | 166 | 3.62 s, 280 MB | −24 %, ×1.5 | −32 %, ×2.1 | −30 %, ×3.5 |
  | C library (large files) | 171 | 2.91 s, 393 MB | −22 %, ×1.6 | −33 %, ×1.9 | −25 %, ×2.8 |
  | TS backend | 241 | 1.99 s, 327 MB | −3 %, ×1.7 | −3 %, ×2.3 | +12 %, ×3.5 |
  | C/C++ project | 530 | 4.34 s, 372 MB | −28 %, ×1.5 | −34 %, ×2.0 | −35 %, ×2.9 |
  | TS monorepo | 952 | 4.67 s, 701 MB | −17 %, ×1.5 | −18 %, ×2.0 | −10 %, ×2.8 |

  `--jobs 1` is the sequential path (within ±8 %, noise). CPU time grows
  with the workers (TS monorepo 8.3 s → 16.0 s at `--jobs 4` → 21.2 s at
  `--jobs 8`, 1.8 → 5.0 cores busy): each worker compiles and warms its own
  code. Each worker adds ≈ 150–200 MB peak RSS.
- **Reading:** projects of a few dozen files get slower with workers (their
  start dominates). Dart and C/C++ gain 25–35 % at `--jobs 4` — their
  tree-sitter parse is most of the work. TypeScript gains little (backend
  ≈ 0 %, monorepo ≈ 18 %): ts-morph's per-file work is split, but each
  worker builds its own ts-morph state. `--jobs 8` is never faster than
  `--jobs 4` on this machine and often slower. Single measurements under
  desktop load vary by ±10 %; the pattern is the same in every run.
- **Results:** in all 225 benchmark runs, 126 cache runs (63 writer/reader pairs) and 13 error runs
  findings, identities, order, coverage and exit code equal the sequential
  run.
- **Fact cache:** every writer/reader pair, also across configurations
  (sequential writes, `--jobs 8` reads, and back), hits every file (e.g.
  952 / 952) with identical findings. A warm run is 2–4 × faster than a cold
  one (TS monorepo 5.0 s → 1.6 s); warm, the workers only cost their start
  (`--jobs 8` warm 2.0 s vs sequential warm 1.6 s).
- **Error behaviour:** broken, unreadable and non-source files give exit 2
  `partial` with 6 analyzed / 2 skipped in every configuration; the memory
  guard stopping at the first file gives exit 2 `partial` in every
  configuration; a dying worker gives exit 1 `failed` within 0.75–1.0 s,
  no hang.
- **Decision:** parallel extraction stays opt-in, no default is changed.
  The memory cost (×2–3 at `--jobs 4`, ×3–5 at `--jobs 8`) is relevant,
  and the gain depends on language and size: none or negative for small and
  TypeScript projects, 25–35 % for larger Dart and C/C++ projects. Where it
  pays, `--jobs 4` is the useful setting on 8 threads.
- **Fixed while measuring (script only):** copying a target for the cache
  check failed on unreadable directories and on sockets/FIFOs in a project
  tree; the copy now takes only regular readable files and directories and
  skips `node_modules`, `.git` and `.stoa`. Results are written per section
  so an aborted run keeps what it measured.

## Final quality assurance (Finding Identity spec, phase 6, 2026-11-05)

Every check run on the working tree of phases 1–5 (on top of `db60e07`);
Node 24.21, 8-thread laptop.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | 0 errors |
| Typecheck incl. tests and scripts | project `tsconfig.json` options (`strict`, `noUncheckedIndexedAccess`) over `src`, every `test/*.ts` and `scripts/*.ts` | `src`, `scripts` and all other test files: 0 errors. 20 errors in 8 older test files (`Solid*`, `Schema`, `KnowledgeBase`, `RuleGovernance`), the same 20 already at `db60e07` — not introduced here, see limitations |
| ESLint | `npm run lint` | 0 errors, 0 warnings |
| Build | `npm run build` | ok |
| All tests | `npm test` | 668 / 668 passed, 0 failed, 0 skipped, 0 cancelled |
| CLI tests | `node --import tsx --test` on `AnalysisStatusCli`, `BaselineCli`, `CliOutput`, `EvalIntegrityCli`, `Sarif` | 34 / 34 |
| Evaluator | `Evaluation`, `EvaluatorUnit`, `CrossLanguageEval`, `RuleGovernance` | 28 / 28 |
| SymbolGraph and ModuleGraph | `SymbolGraph`, `SymbolGraphDemand`, `SymbolGraphReexport`, `SymbolResolution`, `ModuleGraph`, `ModuleResolution`, `PhpModuleResolution`, `CppIncludes` | 83 / 83 |
| TypeModel | `TypeModel`, `StructFacts` | 16 / 16 |
| Architecture and SOLID | `ArchitectureConfig`, `LayerClassification`, `Solid*` (6 files), `Dependency`, `DependencyTypeOnly`, `DeadExport`, `ProjectRuleCategorization` | 59 / 59 |
| Golden corpora (tests) | `Rules`, `SolidCorpus`, the a11y corpora, `ValidationDataflowCorpus`, `BackendValidation` | 90 / 90 |
| Baseline and identity | `Baseline`, `BaselineCli`, `FindingIdentityIntegration`, `IdentityScheme`, `FunctionIdentity`, `DartIdentity` | 84 / 84 |
| Integration | `Pipeline`, `ParallelExtraction`, `FactCache`, `MemoryGuard`, `MemoryPipelineScaling`, `Ingestion`, `RealWorldReport`, `AnalysisStatus`, `AnalyzedFiles`, `PipelineMetrics` | 72 / 72 |
| Golden corpora (CLI) | `node dist/Cli.js eval <corpus> --expected <manifest>` for the project, SOLID (with and without architecture), HTML, JSX, Vue, Angular, Flutter, catch-intent and validation-dataflow corpora | all exit 0, precision and recall 100 % (TP 44, 7, 7, 37, 14, 8, 8, 6, 6, 20; FP 0, FN 0) |
| Golden manifests vs `db60e07` | per manifest: entry count and changed fields | 16 manifests, every count unchanged; only `symbol` (the phase-1 renames, approved per file) and the new `"identity": 2` changed |
| Baseline integrity | `analyze src --baseline … --update-baseline`, then `--only-new` sequential and with `--jobs 4`; an old-scheme baseline with and without `--migrate-baseline` | 107 unique entries, scheme 2; 0 new in both runs; the old scheme is refused with exit 1, migration rewrites it to scheme 2 and lists dropped entries |
| Determinism | `analyze .` three times sequential and once `--jobs 4`; phase 5 (`scripts/compare-jobs.ts`, 364 runs) | findings byte-identical (404) in all four; all 364 comparison runs identical |
| Dependencies | `git diff db60e07 -- package.json package-lock.json` | no change |

The test groups overlap (`SolidCorpus` and `BaselineCli` are in two groups);
they are run separately to give each area its own count. Tests that skip on
their own condition — as root (`chmod 000`), without a Flutter SDK, or on a
Node without `module.enableCompileCache` — all ran here (0 skipped).

**API changes** (stoa ships the CLI only, `bin`; no library entry point).
New CLI flag `--migrate-baseline`; the baseline, corpus manifest and
snapshot files carry `"identity"`; the report's baseline summary carries
`duplicateIdentities`; ModuleGraph edges add `resolution: 'psr4'`, origin
`cpp.include` and `conditional`; new facts `cpp.include` and PHP
`struct.typeDecl`/`struct.importBindings`. Internal: `extractFile` takes
the `ProjectContext` instead of the root directory; `identityScheme` on
adapters and `analyze` options; the ingestion result no longer exposes the
adapter registry. All are described in the phase 1–5 sections above and in
`finding-model.md`; the README was brought up to date in this phase
(`--migrate-baseline`, PSR-4 and C/C++ includes no longer "planned").

**Known limitations:** the golden corpora are small and curated; C/C++ has
no golden corpus; the PHP and C/C++ phase-4 behaviour is covered by tests,
not by a real-world comparison target with ground truth; the timing figures
come from one laptop under desktop load; the test files are not part of
`npm run typecheck` (tsx runs them without type checking), and 8 older ones
carry 20 type errors (`AnalysisResult` imported from `Pipeline.js` instead
of `Types.js`, implicit `any` parameters, the `ajv/dist/2020` import shape)
that predate this spec and were left unchanged.
Resolved since by the quality-hardening spec, phase 1 — see the next
section.

## Test typecheck (Quality Hardening spec, phase 1, 2026-11-05)

Test and script code is now type-checked with the same strictness as the
production code.

- **Configuration:** `tsconfig.test.json` extends `tsconfig.json` (same
  `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …) and
  covers `src/**`, `test/**` and `scripts/**`, with `noEmit`. Excluded are
  only `test/fixtures` and `test/corpus`: they are analysis *input* — code
  deliberately written to trigger or avoid findings, in several languages —
  not code that runs. `tsc --listFilesOnly` confirms none of them is pulled
  in through an import. The production configuration is unchanged; `npm run
  build` still emits `src/` only.
- **Command:** `npm run typecheck:test` (`tsc -p tsconfig.test.json`), next
  to `npm run typecheck` (production, unchanged). The QA sequence is
  `typecheck`, `typecheck:test`, `lint`, `test`, `build`.
- **The 20 errors fixed (8 test files, no assertion changed):**
  - 5 `Solid*` tests imported `type AnalysisResult` from `src/Pipeline.js`,
    which uses but does not export it; it now comes from `src/Types.js`, where
    it is declared. The 10 implicit-`any` parameters were follow-on errors and
    are gone with it.
  - `Schema` and `RuleGovernance` used the default import of
    `ajv/dist/2020.js`, which under NodeNext is the CommonJS module object,
    not the class; they now use the named export `{Ajv2020}` (same class at
    runtime).
  - `KnowledgeBase` deleted `name` from an object whose inferred type has no
    such property; the object is now annotated `Record<string, unknown>`, the
    type `basePrinciple()` already returns.
- **Not used:** no `any`, no type assertion, no `@ts-expect-error`/`@ts-ignore`,
  no ESLint exception; nothing suppressed.
- **Checked:** `npm run typecheck` 0 errors, `npm run typecheck:test` 0
  errors, `npm run lint` 0 problems, `npm test` 668 / 668, `npm run build`
  ok; no golden manifest, baseline or dependency changed.

## Finding identity completed (Quality Hardening spec, phase 2, 2026-11-05)

Identity scheme 3 and an explicit identity kind on every finding (both user
decisions). Details of the naming in `finding-model.md` §6 "Identity".

- **One model, extended:** `src/FindingIdentity.ts` gains scheme 3,
  `IdentityKind` and `declarationIdentities`/`uniqueIdentities` (the
  existing `declarationSymbols`/`uniqueSymbols` now derive from them); the
  site pass `SiteIdentity.ts` does the anchoring. No second naming path.
- **What scheme 3 changes** (scheme 2 still producible for
  `--migrate-baseline`):
  - a site outside every declaration is anchored to a new fact
    `struct.anchor` — a top-level binding in TS/JS (`const`/`let`/`var`
    with a plain name, `export default`, `module.exports`/`exports.x =`),
    an element with a static `id` in HTML and Vue/Angular templates — else
    named after the file (`(module)>…`, `(document)>…`) and numbered among
    the file-level sites only;
  - `--typecheck` diagnostics (`tsc#n`, `promise#n`) go through the same
    site pass, against the declarations of the adapter's facts for that file
    (Pipeline.ts), kind `external`;
  - Flutter lifecycle call sites: `Class.method>setState#n`,
    `Class.initState>Theme.of#n` (per method and call) instead of
    `Class.method#n` / `Class.initState:Theme.of#n`;
  - C++ definitions with equal name and parameters: their preprocessor
    condition as variant (`[!MIMIRMIND_HAVE_CUDA]`), `#n` only when the
    conditions are equal too (kind `ambiguous`).
- **Identity kind:** `location.identityKind` (and `subject.identityKind` on
  facts), one of `declaration`, `anonymous`, `site`, `module`, `external`,
  `fileOrdinal`, `ambiguous`, `file`; set by the extractor (the default of
  `FactBuilder`: `declaration` for a symbol, `fileOrdinal` for a not yet
  anchored site), by the site pass, and by each project rule where it makes
  its symbol. Additive in `fact.schema.json` and `finding.schema.json`; the
  FactCache validates it. The Markdown header counts the kinds. Not part of
  `FindingKey`.
- **Files and messages:** baselines, corpus manifests and snapshots accept
  `"identity": 3`; a scheme-2 file is refused like a scheme-1 one, a
  baseline converted only with `--migrate-baseline`. The "must be …" error
  text names the valid schemes from one list (`IDENTITY_SCHEMES`).
- **Golden manifests** (all 16 rewritten mechanically: each corpus analyzed
  under scheme 2 and 3, findings paired by `Finding.id`, the manifest's
  symbol replaced by its finding's new one; no entry added, removed or left
  unpaired except in the two deliberately broken evaluator fixtures
  `eval/expected-malformed.json` and `eval/expected-missing.json`):

  | Manifest | Entries | Symbols changed | Why |
  |---|---|---|---|
  | `corpus/expected.json` | 44 | 3 | `synchronize#0`/`syncWithMigrations#0` in `export const dataSource = {…}` → `dataSource>…#0` |
  | `fixtures/validation-dataflow-corpus/expected.json` | 20 | 7 | annotated top-level schemas: `annotation#2` → `ageSchema>annotation#0` etc., `unused#0` → `unusedSchema>unused#0` |
  | `fixtures/html/expected.json` | 37 | 37 | static HTML: `(document)>…` numbered among the flagged sites (`button#5` → `(document)>button#1`); `dupids.html` under its ids (`#main>dupid#0`, `#dup2>dupid#0`) |
  | `fixtures/vue/expected.json`, `fixtures/angular/expected.json` | 8 + 8 | 8 + 8 | template sites → `(document)>…#0` |
  | 11 others (SOLID ×2, JSX, Flutter, catch-intent, eval-multi, eval ×5) | — | 0 | `"identity": 3` only |

- **Tests:** `test/IdentityStability.test.ts` (18): a site inserted before
  another (same declaration: shifts — the documented limit; another
  declaration or top level: does not), a top-level site no longer shifted by
  a catch in a function (scheme 2 did), anchors for `const`/`export
  default`/`module.exports`, a moved and a new method, a moved module (file
  part changes, symbol stays), same-named methods in two classes, C++
  preprocessor twins (nested, `#else`, include guard, equal conditions →
  `ambiguous`), anonymous functions, static HTML with and without ids, a Vue
  template with static and bound ids, imports and a re-export added above,
  the site pass independent of fact order (anchors included), `tsc`
  diagnostics anchored and `external`, the kind on every corpus finding,
  the kind outside the identity, migration 2 → 3. Namespaces and C++
  overloads stay covered by `IdentityScheme.test.ts`. Existing tests that
  named old symbols were updated to the scheme-3 names, each assertion as
  strict as before (same entries, same order): HTML/Vue/Angular a11y tests,
  `A11yCorrectness`, the Flutter lifecycle identity test, and the tests
  that wrote a current-scheme file (`"identity": 2` → `3`).
- **Measured on the 9 comparison targets** (`.stoa/compare-jobs-targets.json`,
  one run per scheme, `dist/`): every target `complete`; per target the same
  set of `Finding.id` under scheme 2 and 3 (4,508 findings in all); 0
  duplicate identities under either. Renamed: 3 ORM (corpus), 6 Flutter
  (5 lifecycle call sites, 1 `iconButton#0` → `(module)>iconButton#0`), 5
  C++ (`#ifdef` twins in mimirmind → `[MIMIRMIND_HAVE_L0]`,
  `[!MIMIRMIND_HAVE_L0]`, `[MIMIRMIND_HAVE_CUDA]`), 6 flyingfish (two
  `login.html` fields → `#input_email>field#0`, `#input_password>field#0`;
  `img#0`, `html#0` → `(document)>…`; two NAPI loader `catch#6` →
  `(module)>catch#5`). Kinds after: 0 `ambiguous`, 5 `fileOrdinal` — the
  two NAPI top-level `catch` blocks, a login `<img>` and a 404 page `<html>`
  with no id around them, and the Flutter `IconButton` whose `build` method
  tree-sitter-dart could not parse (Dart 3 record pattern + switch
  expression; parser limit, not an identity rule). Facts grow by the anchors:
  corpus 479 → 500, stoa `src` 15,039 → 16,110, flyingfish 53,725 → 54,581;
  Dart, PHP and C/C++ unchanged (no anchors produced). Run time was not
  benchmarked here (one run each, scheme 2 first) — phase 4 measures.
- **Not anchored (documented limits):** PHP and C/C++ top-level code and
  Dart top-level variables get no `struct.anchor` (their sites outside a
  declaration are `(module)>…`); a destructuring binding names no anchor;
  two sites of one kind in one declaration are still numbered in source
  order (`load>catch#1` shifts when a catch is inserted above it in the same
  function); `Finding.id` stays position-based (it is the pairing key of the
  migration, not an identity).
- **Checked:** `npm run typecheck`, `npm run typecheck:test`, `npm run lint`
  0 errors; `npm test` 686 / 686; `npm run build` ok; no dependency added.

## Baseline and evaluator consolidated (Quality Hardening spec, phase 3, 2026-11-05)

Goal: every component uses the same finding-identity semantics, and a
baseline migration is explicit, reproducible and traceable.

- **One identity logic:** baseline, migration, snapshot diff
  (`src/FindingDiff.ts`), evaluator and the CLI all key on `findingKey` /
  `keyString` and name a repeated identity with `duplicateKeys` /
  `duplicateIdentityText` (`src/FindingIdentity.ts`). The evaluator's two
  hand-written "seen" loops are replaced by the shared `splitRepeated`
  (which `duplicateKeys` now builds on); its lists stay as they were (every
  surplus copy).
- **Migration classified** (`src/BaselineMigration.ts`): each entry gets one
  outcome — `matched`, `notReproducible` (`noLegacyFinding`,
  `noCurrentFinding`), `ambiguous` (`legacyIdentityShared`,
  `positionShared`), `duplicate` (`targetIdentityShared`). Before, the first
  three failure cases fell into one `unmatched` list, a shared legacy
  identity was discarded without a word, and a position shared only in the
  legacy run was not checked at all. `duplicate` still writes nothing
  (exit 1), but now names the entry. Entries are processed in key order, so
  the result is independent of entry and finding order (tested).
- **Traceable output:** stderr gives the counts per outcome and every
  dropped entry with its reason (the line still opens with the old wording);
  `AnalysisReport.baseline.migration` carries the counts, the renamed
  entries (`from` → `to`) and the dropped entries with outcome and reason;
  Markdown adds a line under the baseline line (en/de) and lists up to 20
  dropped entries.
- **No silent scheme change:** the JSON report stamps the identity scheme
  (`versions.identity`, additive); `--migrate-baseline` on a baseline that
  is already current or does not exist yet says "nothing to migrate" and
  writes nothing.
- **Duplicates detected without a baseline too:** `stoa analyze` names an
  identity collision on stderr even without `--baseline` (before, only
  `eval`, `--baseline` and `--update-baseline` checked); the exit code is
  unchanged.
- **CLI contract:** no flag added or removed; exit codes unchanged (0
  complete, 1 error, 2 partial); the old stderr text is a prefix of the new
  one up to "(dropped)"; the report changes are additive (`versions.identity`,
  `baseline.migration`).
- **Measured** (dist build, the 9 comparison targets, a baseline of every
  finding under scheme 1 and under scheme 2, migrated on the same code):
  all 18 migrations `matched` 100 % — 0 notReproducible, 0 ambiguous, 0
  duplicate; renamed under scheme 2 → 3: corpus 3, swipemeister 6,
  mimirmind 5, flyingfish 6, others 0; under 1 → 3: corpus 31, velyo 17,
  MAPI 13, stoa `src` 4, swipemeister 31, flyingfish backend 130, rohc 0,
  mimirmind 750, flyingfish 190. Scheme 1 produces fewer findings on two
  Dart targets (velyo 49 instead of 52, swipemeister 94 instead of 95):
  findings that shared one identity there were merged (`ContentPack.allWords`
  deep nesting, two closures `_PathMap.build.(anonymous)#4`,
  `_WinnerFrameState._remaining`). After migrating a scheme-1 baseline they
  read as `new` — correct, since the old baseline never held them
  separately.
- **Tests:** `test/BaselineMigration.test.ts` (11): every outcome and
  reason, no assignment for a shared identity or position (in either run),
  duplicate blocks writing, order independence, `migrationSummary`
  (renamed, dropped), Markdown en/de, CLI JSON `versions.identity` and
  `baseline.migration`, stderr reasons, a second `--migrate-baseline` writes
  nothing, duplicate exits 1 with the file untouched, collision warning
  without a baseline, missing baseline file. Two existing migration tests
  read the new result shape (same assertions: carried-over keys, the one
  dropped entry — now with outcome and reason).
- **Not changed:** corpus manifests still have no automatic conversion (an
  expected finding the engine misses has nothing to pair with; re-approval
  stays manual); a newer scheme than the running one is still "malformed"
  (exit 1).
- **Checked:** `npm run typecheck`, `npm run typecheck:test`, `npm run lint`
  0 errors; `npm test` 697 / 697; `npm run build` ok; no dependency added.

## Rule evaluation and memory measured (Quality Hardening spec, phase 4, 2026-11-05)

Goal: analyze large projects more efficiently without changing a result.
Outcome: the rules are classified by the data they actually read, their
independence is proven, memory per pipeline phase is measurable
reproducibly — and no data release or restructuring is justified by the
measurement, so none was made. No finding changed.

- **Classification (measured, `test/RuleDataNeeds.test.ts`):** every
  project rule's input is wrapped in a recording proxy while the real
  pipeline runs over fixtures that take each rule past its early exits; the
  fields it reads decide its class.

  | Class | Rules | Data read |
  |---|---|---|
  | Local | the 40 declarative rules | one subject's facts (`groupUnits`: file, symbol, range, kind) |
  | Module | R-DEP-CYCLE; R-SOLID-DIP-LAYER-DIRECTION (stage 1 and the declared-layers stage 2) | `moduleGraph` (stage 1 also `facts`, `dartLibraryIndex` for the layer classification) |
  | Symbol | R-SOLID-LSP-CONTRACT-COMPATIBILITY, R-SOLID-ISP-INTERFACE-COHESION, R-SOLID-DIP-CONCRETE-DEPENDENCY; the four Flutter lifecycle rules | `symbolGraph`/`typeModel` (SOLID), `dartLibraryIndex` (lifecycle: cross-file name resolution), `facts` |
  | Project | R-UNUSED-EXPORT, R-VALIDATION-CONTRACT; the four Flutter layout rules | all imports × all exports (`facts`, `analyzedFiles`); the evidence over all facts; the project widget graph |

  Since R-UNUSED-EXPORT 1.1.0 (2026-11-05, see "External validation") that
  rule reads the SymbolGraph and is in the symbol class.

  R-SOLID-SRP (not registered) reads the TypeModel (symbol). The test pins
  the exact fields per rule; a rule that starts reading more fails it.
- **Dependencies between rules:** declarative rules meet only in the
  de-duplication (one finding per file, position, symbol and feature —
  always within one file); project rules never read another rule's
  findings, and the shared lazily built TypeModel is the same whichever
  rule builds it. Proven by the test: evaluating each file on its own gives
  the declarative findings of the whole set (6 corpora, all languages);
  project rules alone, together and in reverse order give the same
  findings; none writes to a (deep-frozen) fact.
- **Memory per phase** (`scripts/measure-phases.ts`, the 9 comparison
  targets, retained heap after a full collection, MB; one run each):

  | Target | Facts | start | after ingestion | after graphs | after rules | result alive | released | RSS after ingestion | peak RSS |
  |---|---|---|---|---|---|---|---|---|---|
  | corpus | 500 | 43.9 | 48.7 | 48.7 | 48.9 | 48.7 | 48.3 | 201 | 201 |
  | velyo (Dart) | 7,287 | 43.9 | 53.7 | 56.7 | 58.8 | 54.1 | 47.0 | 252 | 254 |
  | MAPI (PHP) | 1,452 | 43.9 | 47.7 | 47.7 | 47.8 | 47.6 | 46.7 | 230 | 230 |
  | stoa `src` | 16,308 | 43.9 | 61.4 | 62.4 | 63.9 | 61.9 | 50.4 | 392 | 395 |
  | swipemeister (Dart) | 16,130 | 43.9 | 60.8 | 66.5 | 71.6 | 61.4 | 47.1 | 265 | 304 |
  | flyingfish backend | 9,893 | 43.9 | 57.8 | 59.1 | 60.5 | 58.3 | 50.9 | 366 | 367 |
  | rohc (C) | 8,347 | 43.9 | 53.8 | 54.0 | 55.0 | 54.5 | 46.0 | 298 | 407 |
  | mimirmind (C/C++) | 25,190 | 43.9 | 68.4 | 69.0 | 70.1 | 69.1 | 46.2 | 340 | 407 |
  | flyingfish | 54,581 | 43.9 | 90.3 | 95.0 | 100.6 | 92.5 | 53.4 | 647 | 767 |

  Facts dominate what the run holds (flyingfish: ≈ 39 MB for the result,
  ≈ 0.7 KB per fact); the graphs add 0–5.7 MB, the rules 0.1–5.6 MB, both
  gone with the run. The peak is set during ingestion — parsing (flyingfish:
  RSS 647 MB after ingestion, 767 MB peak, against ≈ 100 MB of live heap),
  not in the evaluation. After a run 2–10 MB stay for module-level caches
  (grammars, the shared TypeScript lib project); three runs of stoa `src`
  in one process: 61.6 / 61.9 / 62.1 MB — constant, no growth per run.
- **Time per rule** (ad hoc: each rule's `evaluate` wrapped, ms): the
  evaluation is 1–7 % of a run. flyingfish 295 (declarative 193,
  R-UNUSED-EXPORT 40, LSP 35 including the TypeModel build); swipemeister
  233 (DIP-concrete 118 including the TypeModel build, declarative 50);
  stoa `src` 100; mimirmind 59.
- **Optimizations examined — none made, each for a measured reason:**
  - *Local rules right after each file:* correct (proven above), but
    the declarative evaluation is 46–193 ms and the facts stay anyway
    (project rules, `AnalysisResult.facts`, `coverage.factCount`) — no
    memory and ≤ 4 % time to gain.
  - *Fact projections per rule:* `requiredFactKinds` is verified metadata,
    but the full fact set is retained regardless — nothing to release.
  - *Shorter lifetime of graphs and temporary data:* graphs and rules hold
    ≤ 11 MB on top of the facts and are released when `analyze` returns;
    freeing them earlier cannot lower a peak that is set while parsing.
  - *Incremental evaluation:* project rules need the complete fact set; the
    per-file part (extraction) is already cached (`--cache`).
  - *Reusing computed graphs:* ModuleGraph, widget graph and Dart index are
    built once per run, the SymbolGraph only for a rule that needs it, the
    TypeModel memoized for all rules. Left: the Dart layer classification
    is computed by both DIP rules (≤ 19 ms on swipemeister) — too small for
    a shared cache; R-UNUSED-EXPORT resolves relative imports itself instead
    of using the ModuleGraph — switching would change findings (alias and
    package imports), so it is not a phase-4 change (open point; done since
    in R-UNUSED-EXPORT 1.1.0).
- **Changed:** `AnalysisProgress` has a `graphs` phase (after the graphs,
  before the rules; `--memory-stats` prints it); new
  `scripts/measure-phases.ts`; `scripts/CompareTargets.ts` holds the target
  list both comparison scripts had copied; `test/RuleDataNeeds.test.ts` (3).
- **Results unchanged:** the build before and after phase 4, 21 targets (12
  repository targets, 9 comparison targets): findings with order and
  identities, coverage and fact count byte-identical. Golden corpora
  unchanged (`npm test`).
- **Checked:** `npm run typecheck`, `npm run typecheck:test`, `npm run lint`
  0 errors; `npm test` 700 / 700; `npm run build` ok; no dependency added.

## External validation (Quality Hardening spec, phase 5, 2026-11-05)

Goal: measure stoa on code it was not developed against. Outcome: four
open-source projects, one per language, pinned to a commit and analyzed
reproducibly; 176 findings classified by hand, with precision only over
those and recall only inside files read in full. The review uncovered one
counting error shared by three extractors, three FP patterns of single
rules and a PHP parser limit — **measured and documented, nothing fixed**
(fixes are separate steps that need their own approval). No finding of the
golden corpora changed.

- **Data and tooling:** `validation/external/<name>/{manifest,labels}.json`,
  `scripts/external-validation.ts` (`fetch` / `sample` / `report`),
  `src/evaluation/ExternalValidation.ts` (label checks, deterministic sample,
  counting), `validation/external/README.md` (categories, criteria, what the
  numbers mean). Checkouts live in `.stoa/external/` (git-ignored, not
  linted); no third-party source is copied into the repository. The external
  corpus is kept apart from the golden corpora and the dogfooding targets and
  does not become a golden corpus automatically.
- **Projects:**

  | Project | Language | Version / commit | Licence | Analyzed |
  |---|---|---|---|---|
  | ky (sindresorhus/ky) | TypeScript | v2.2.0, `3541888878c4d303a8bc2ad61815f4e048f55a5d` | MIT | `source/`, with SOLID and dead-export rules |
  | symfony/console | PHP | v8.1.11, `5a315b092b81f3e920e9daea1a2ae4c66ed298b9` | MIT | all except `Tests/`, with SOLID rules |
  | lua/lua | C | v5.5.1, `7579fc9d7ed90240487251dfb69168f8e64e9294` | MIT | all, with SOLID rules |
  | flutter/samples `compass_app/app` | Dart/Flutter | `9df2cac15cc3d28a51aace018ad822387d30ac72` | BSD-3-Clause | `lib/` (sparse checkout), with SOLID rules |

- **Review:** a model review (claude-opus-5-5), marked as such in every
  label file, **not confirmed by a human**. Labeled: the deterministic
  sample (up to 5 findings per rule, sha256 rank of the identity), plus
  rules reviewed in full where a pattern showed (ky R-UNUSED-EXPORT 66,
  symfony R-DEP-UNUSED 24 and R-DEP-CYCLE 4, compass all 14), plus every
  finding in the 2–3 files per project read in full for recall (`fnScope`,
  all rules). Criteria: TP = the claim is true and the code is the kind the
  rule is for, metric thresholds checked by a hand count; FP = the claim is
  wrong (also a metric that crosses the threshold only through a counting
  error) or the code is not what the rule is for; unclear = not decidable.
- **Results** (`scripts/external-validation.ts report`):

  | Project | Language | Status | Files analyzed / skipped | Findings | Reviewed | TP | FP | Unclear | FN | Precision | Recall |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | ky | TypeScript | complete | 31 / 0 | 90 | 86 | 26 | 59 | 1 | 0 | 30.6 % | 100 % (5 TP in scope) |
  | symfony-console | PHP | partial | 172 / 2 | 175 | 56 | 22 | 33 | 1 | 0 | 40.0 % | 100 % (5 TP in scope) |
  | lua | C | complete | 68 / 0 | 168 | 20 | 16 | 4 | 0 | 0 | 80.0 % | 100 % (4 TP in scope) |
  | compass-app | Dart/Flutter | complete | 111 / 0 | 14 | 14 | 3 | 11 | 0 | 0 | 21.4 % | 100 % (3 TP in scope) |

  Per rule (reviewed / TP / FP / unclear):

  | Rule | ky | symfony | lua | compass |
  |---|---|---|---|---|
  | R-COMPLEXITY-COGNITIVE | 6 / 6 / 0 / 0 | 6 / 5 / 1 / 0 | 5 / 3 / 2 / 0 | – |
  | R-DEEP-NESTING | 3 / 2 / 1 / 0 | 5 / 2 / 3 / 0 | 5 / 3 / 2 / 0 | – |
  | R-FN-TOO-MANY-PARAMS | – | 5 / 3 / 2 / 0 | 6 / 6 / 0 / 0 | 10 / 0 / 10 / 0 |
  | R-SIDEEFFECT-NONDETERMINISM | 4 / 4 / 0 / 0 | 7 / 7 / 0 / 0 | 4 / 4 / 0 / 0 | 1 / 0 / 1 / 0 |
  | R-ERR-SWALLOWED | 2 / 1 / 1 / 0 | 5 / 1 / 3 / 1 | – | – |
  | R-UNUSED-EXPORT | 66 / 12 / 54 / 0 (all) | – | – | – |
  | R-DEP-UNUSED | – | 24 / 0 / 24 / 0 (all) | – | – |
  | R-DEP-CYCLE | – | 4 / 4 / 0 / 0 (all) | – | – |
  | R-WIDE-PUBLIC-SURFACE | 3 / 1 / 1 / 1 | – | – | – |
  | R-VALIDATION-MISSING-BACKEND | 2 / 0 / 2 / 0 | – | – | – |
  | R-A11Y-FLUTTER-TEXTFIELD-LABEL | – | – | – | 2 / 2 / 0 / 0 |
  | R-A11Y-FLUTTER-IMAGE-LABEL | – | – | – | 1 / 1 / 0 / 0 |

  How to read it: precision is over the *reviewed* findings, and the
  sample is stratified — rules reviewed in full (R-UNUSED-EXPORT,
  R-DEP-UNUSED) weigh heavily in a project total, so a total is not an
  estimate for all findings of a project. Recall rests on 10 files
  (2–3 per project, 17 TPs, 0 misses found) — too narrow to claim a
  recall for the rules; it only says no miss was found there. Per-rule
  samples of 5 give no statistically firm precision either.
- **Findings of the review (documented, not fixed):**
  - **else-if counted as nesting (TypeScript, PHP, C):** the metric walk
    treats an `else if` / `elseif` as an `if` nested in the previous one's
    else, so each further branch of an if/else-if chain adds a nesting level
    and a growing cognitive increment (`TsExtraction` `NESTING_KINDS`,
    `PhpExtraction` `NESTING_KINDS`, `CppExtraction` `NESTING_TYPES`). Hand
    counts by structure (SonarSource: else-if +1 flat, no nesting) put 9 of
    the 30 reviewed R-DEEP-NESTING / R-COMPLEXITY-COGNITIVE findings below
    the threshold (examples: `StringInput.tokenize` reported nesting 5 /
    cognitive 22, actual 3 / 13; lua `getnum_aux` cognitive 21, actual 10).
    The reported values of the remaining TPs are also too high. Not checked
    for Dart.
    **Fixed since (2026-11-05):** an `else if` / `elseif` now adds one flat
    cognitive increment and no nesting level in all four metric walks —
    Dart had the same defect. Detected by structure (TS: the `elseStatement`
    of an `IfStatement`; PHP: the `alternate` of an `if`; C/C++: the
    `if_statement` of an `else_clause`; Dart: the `alternative` of an
    `if_statement`); an `if` inside an `else { … }` block stays nested.
    Cyclomatic values are unchanged. The 9 findings labelled FP above are
    no longer produced, all 21 metric TPs still are, and the values match
    the hand counts (`appendSearchParameters` depth 7 → 5, hand 5;
    `applySearchParameters` 4 → 3, hand 3). Findings only drop or their
    values fall, none is added: ky −1, lua −45, symfony −27, flyingfish
    backend −2 / frontend −5, mwpa −2, swipemeister −1, velyo −1; golden
    corpora unchanged. Tests: `test/ElseIfMetrics.test.ts`.
  - **R-UNUSED-EXPORT without package entry points and re-exports
    (TypeScript):** 54 of 66 FP — 38 exports of `index.ts`, the package
    entry (`package.json` `exports`), and 16 declarations re-exported through
    `export … from` (also chained, `types/retry.ts` → `types/options.ts` →
    `index.ts`). 12 TP (exported, used only in their own file).
    **Fixed since (2026-11-05, R-UNUSED-EXPORT 1.1.0):** the rule reads the
    shared SymbolGraph (now also built for `usesSymbolGraph`): an export is
    used when an import binding reaches it directly or as a re-export hop
    (`export {x} from`, `export *`, `export * as ns`, chains), and imports
    resolve through the module graph (tsconfig paths, package
    self-references), not relative-only. Exports of package entry points,
    and everything they re-export, are public API and not reported. Entry
    points (`src/config/EntryPoints.ts`): `entryPoints` in stoa.config.json
    (globs relative to the analysis root), and `main`/`module`/`types`/
    `typings`/`exports`/`bin` of the root package.json — counted only when
    the path is an analyzed file, maps onto one by a source extension
    (`index.js` → `index.ts`), or lies in the tsconfig `outDir` with a
    `rootDir` set (`dist/index.d.ts` → `src/index.ts`); several candidates
    or no match is no entry (nothing guessed; `exports` subpath patterns
    with `*` are left out). ky declares `"entryPoints": ["index.ts"]` in its
    manifest (`analyze.entryPoints`): 66 → 12 findings, exactly the 12 TP,
    0 FP. On the other targets findings only drop: flyingfish/schemas
    1070 → 2 (its package.json `types` is `src/index.ts`, which re-exports
    the whole package; the 2 left are exported, used only in their own file
    and not re-exported — true positives); no finding added anywhere; all
    other changes are the rule version and texts. Tests: `test/DeadExport.test.ts`.
  - **R-DEP-UNUSED (PHP):** 24 of 24 FP — 20 imports used only in PHPDoc
    (`@param`, `@return`, `@throws`, `@var`, `@see`; PHPStan/Psalm and IDEs
    need them, PHP-CS-Fixer's `no_unused_imports` counts them as used), 3
    used only as attributes (`#[AsCommand(…)]`, `#[RequiredBundle(…)]`), 1
    namespace alias used as a prefix (`use …\ValueResolver as Resolver;` →
    `new Resolver\BuiltinTypeValueResolver()`).
    **Fixed since (2026-11-06, R-DEP-UNUSED 1.1.0):** the PHP extraction
    (`src/analysis/php/PhpReferences.ts`) counts as a use of an import's
    local name: an unqualified code name; the first segment of a qualified
    one (`Resolver\Builtin` uses the alias `Resolver`; a fully qualified
    `\A\Foo` or `namespace\Foo` uses no import — before, the last segment
    of every name counted); attribute names (`#[AsCommand]`, `#[ORM\Entity]`);
    in doc comments (`/** … */`, also single-line) the names in tag lines
    (`@param list<Foo> $x`, `@throws FooException`, `@var Foo[]`), inline
    `{@see}`/`{@link}`, and Doctrine annotation tags (`@ORM\Column`). Prose
    outside tags and plain comments do not count; names compare
    case-sensitively. symfony/console: 146 → 0 findings — the 24 labelled
    FP and 122 in `Tests/` (all attribute uses: PHPUnit `#[DataProvider]`,
    console `#[AsCommand]`, `#[Argument]`, …); no other target changes
    beyond the rule version and texts. Tests:
    `test/PhpUnusedImport.test.ts`.
  - **Single FP patterns:** generated code (`*.freezed.dart`, 10 parameter
    findings, header "GENERATED CODE") is not excluded;
    R-VALIDATION-MISSING-BACKEND reads `request.body` in an HTTP *client*
    (outgoing body) as server input (2); R-FN-TOO-MANY-PARAMS reports a
    decorator's override again although the parent's signature dictates it
    (2); R-ERR-SWALLOWED misses that the catch variable is rethrown after a
    retry loop (`QuestionHelper.validateAttempts`) and counts deliberate
    fallbacks (`return`, `$date = false` followed by an error) as swallowed
    (3); the Dart extraction attributes `DateTime.now()` inside an `onTap`
    closure to the enclosing `build` (the TypeScript extraction skips nested
    functions) (1); R-WIDE-PUBLIC-SURFACE on a package's re-export entry,
    which is what the rule's own remediation recommends (1).
    **Generated code fixed since (2026-11-06):** the default `exclude`
    (`src/Config.ts`) now also holds `**/*.freezed.dart` and `**/*.g.dart`,
    the build_runner outputs (freezed, json_serializable); they are excluded
    like any config exclude (`excluded_by_config`, counted in the coverage,
    status stays `complete`). A config or `--exclude` that sets its own
    list replaces the defaults, as before. compass_app: −10 findings,
    exactly the 10 labelled FP; no other target changes (the local Flutter
    projects have no generated files). Tests: `test/Ingestion.test.ts`.
    **Dart closure attribution fixed since (2026-11-07):** every measured
    Dart function, closures included, has its own `ast.usesNondeterminism`
    fact, and a clock or RNG call inside a nested, separately measured
    function counts for that one only — as in TypeScript
    (`src/analysis/dart/DartExtraction.ts`, `inNestedFunction`). Under
    identity scheme 1, which measures named functions only, a closure stays
    part of its function, as before. R-SIDEEFFECT-NONDETERMINISM moves from
    the function to the closure: compass `SearchFormDate.build` →
    `SearchFormDate.build.(anonymous)#0` (the labelled FP), mwpa 3, mwpa
    arch target 5 (incl. 2 in tests), swipemeister 1 likewise; a function
    that calls the clock itself and in a closure now has two findings
    (swipemeister `_WinnerDialogState._startRoll` and its `setState`
    closure, +1). A baseline entry on the function no longer reproduces
    (`notReproducible`); the closure's finding is new. Tests:
    `test/FunctionIdentity.test.ts`.
  - **Reliable in this sample:** R-SIDEEFFECT-NONDETERMINISM 15 / 16 (the
    one FP is the Dart attribution), R-DEP-CYCLE 4 / 4 (every edge checked),
    the Flutter a11y rules 3 / 3, parameter counts always correct.
  - **PHP 8.4 syntax:** `php-parser` 3.7.0 parses PHP 8.3 by default
    (`version` 803); `new Foo()->bar()` without parentheses (PHP 8.4) fails in
    `Command/Command.php:682` and
    `DependencyInjection/AddConsoleCommandPass.php:107`, so symfony/console
    runs `partial` (172 / 174 files, both reported as skipped — the run says
    so instead of passing over it).
    **Fixed since (2026-11-07):** `src/analysis/PhpAdapter.ts` sets the
    parser's language level to 8.5 (`PHP_LANGUAGE_LEVEL`), the newest
    php-parser 3.7.0 knows: 8.4 adds `new Foo()->bar()`, property hooks and
    asymmetric visibility, 8.5 the pipe operator and `clone(…)` with
    parentheses (at 8.3 `clone ($this)` failed too). Newer levels only add
    syntax. symfony/console: `partial` 172 / 174 → `complete` 174 / 174;
    the two files add 8 findings (cognitive complexity, nesting, parameter
    counts in `Command` and `AddConsoleCommandPass`), and with
    `Command.php` in the module graph two R-DEP-CYCLE findings merge into
    one larger cycle. No other target changes. Tests:
    `test/PhpExtraction.test.ts`.
- **Changed:** new `src/evaluation/ExternalValidation.ts`,
  `scripts/external-validation.ts`, `validation/external/` (README, 4
  manifests, 4 label files), `test/ExternalValidation.test.ts` (9: precision
  only over TP/FP, unclear apart, no precision for an unreviewed rule,
  recall only in scope, scope by rule, unlabeled finding in scope and miss
  outside scope are errors, stale labels, deterministic sample, label-file
  checks, corpus integrity: full SHA, licence, model review marked);
  `languageOf` exported from `Evaluator.ts`; `.stoa/` in the ESLint ignores
  (third-party checkouts).
- **Checked:** `npm run typecheck`, `npm run typecheck:test`, `npm run lint`
  0 errors; `npm test` 709 / 709; `npm run build` ok; no dependency added.

## Baseline / diff mode (opt-in, `--baseline`)

Wires up `Finding.baselineStatus` (`'new' | 'known' | 'fixed'`), present in
the type since the original finding model but never actually set by
anything until now. The point: a large existing codebase has a backlog of
findings nobody is going to triage today — a baseline lets CI/pre-commit
surface only what a change actually introduced, not the whole backlog.

- **Identity, reused, not reinvented:** a finding's baseline identity is
  `(project-relative file, rule id, symbol)` — exactly the key the
  golden-corpus evaluator (`src/evaluation/Evaluator.ts`) already uses to
  match produced findings against expected ones. Extracted into a shared
  `src/FindingIdentity.ts` so there is one definition, not two. Line/column
  are deliberately excluded: the symbol already distinguishes findings
  within a file, and an exact position would make identity brittle to
  unrelated line shifts elsewhere in the same file (a known, accepted
  limitation this inherits from the evaluator, not a new one).
- **`--baseline <file>`:** loads the file if it exists and stamps every
  current finding `new` or `known`; a baseline entry no longer reproduced
  by the current run is reported as `fixed` in the new
  `AnalysisReport.baseline` summary (`newCount`/`knownCount`/`fixedCount`/
  `fixed: FindingKey[]`) — never fabricated as a Finding, since there is
  nothing in current code to anchor a "fixed" result to. If the file does
  not exist yet, every finding is `new` and nothing is `fixed` — the
  natural first-run state, not an error. A malformed baseline file DOES
  throw (exit 1) — silently treating it as "no baseline" would mislabel
  every already-known finding as new.
- **`--update-baseline`:** writes the current run's findings (before any
  `--only-new` filtering) as the new baseline at the same path, sorted
  deterministically. Separate from `--baseline` on purpose — loading and
  overwriting are different-enough actions that conflating them risked a
  baseline being silently created/overwritten when the user only meant to
  compare.
- **`--only-new`:** filters the rendered report down to findings that are
  NOT `known` — the actual CI/pre-commit payoff. A no-op if `--baseline` was
  never given.
- **Rendering:** Markdown gets a `- Baseline: N new, M known, K fixed`
  summary line and a `[new]`/`[known]` tag per finding heading (localized
  en/de, like every other report label). SARIF gets the standard
  `result.baselineState` (`'new'`/`'unchanged'`) — SARIF 2.1.0 already
  defines this vocabulary for exactly this purpose, reused rather than
  inventing a stoa-specific property; `'fixed'` findings have no SARIF
  result to attach a state to and are not represented there (they are only
  in `AnalysisReport.baseline.fixed`).
- **Verified end-to-end** against a real small project (not just unit
  tests): first run with no baseline file → all `new`; `--update-baseline`
  writes it; second run against that file → all `known`; `--only-new` on
  that second run → zero findings in the output; removing the underlying
  issue and re-running → reported as `fixed`.
- **Never confuses an incomplete scan with a clean result** (follow-up
  "Analysis Integrity & Memory-Bounded Pipeline" spec; gating now driven by
  `coverage.status !== 'complete'`, see "Analysis Completion Integrity"
  above): when the memory guard stopped a scan early, `applyBaseline()`
  NEVER reports a baseline entry as `fixed` — a file the scan never reached
  was never actually re-checked, so "not reproduced" proves nothing about
  it (`fixedCount`/`fixed` are forced to `0`/`[]`, and
  `AnalysisReport.baseline.incomplete` is set so the whole comparison reads
  as provisional). `--update-baseline` goes further: `saveBaseline()`
  outright REFUSES to write at all (throws `IncompleteAnalysisError`) rather
  than overwrite a complete baseline with partial data — and this check
  lives inside `saveBaseline()` itself, not only earlier in the CLI, so
  there is no call path that bypasses it. `--only-new`/`--update-baseline`
  without `--baseline`, and a `--baseline` path that is a directory, are
  also rejected up front with a specific error before any analysis work
  runs. Verified through the REAL CLI end to end (not just unit tests): a
  blocked `--update-baseline` exits non-zero and leaves the existing
  baseline file byte-identical.

## Rule catalog (40 declarative rules + project rules)

Declarative rules (`rules/default/*.json`, 40), on by default:

| Rule | Principle | Dimension | Languages |
|------|-----------|-----------|-----------|
| R-COMPLEXITY-COGNITIVE | marcus.simplicity | complexity | TS, PHP, Dart, C/C++ |
| R-DEEP-NESTING | marcus.simplicity | complexity | TS, PHP, Dart, C/C++ |
| R-FN-TOO-MANY-PARAMS | marcus.purpose | responsibility-boundaries | TS, PHP, Dart, C/C++ |
| R-WIDE-PUBLIC-SURFACE | marcus.purpose | responsibility-boundaries | TS/JS |
| R-ERR-SWALLOWED | marcus.obstacle | error-handling | TS, PHP, Dart, C++ |
| R-SIDEEFFECT-NONDETERMINISM | marcus.control | side-effect-control | TS, PHP, Dart, C/C++ |
| R-CPP-UNRELEASED-ALLOCATION | marcus.control | robustness, error-handling | C/C++ (a `new`/`malloc`/`calloc`/`realloc` left with no release, no escape, anywhere in the function) |
| R-CPP-NEW-DELETE-MISMATCH | marcus.control | robustness, error-handling | C/C++ (the same pointer's `new[]`/`new` does not match its `delete[]`/`delete` form) |
| R-DEP-UNUSED | marcus.cooperation | dependencies | TS, PHP |
| R-DEEP-IMPORT | marcus.cooperation | dependencies | TS, PHP |
| R-TYPE-UNSOUND | marcus.judgment | decision-evidence, robustness | TS (opt-in `--typecheck`) |
| R-FLOATING-PROMISE | marcus.obstacle | error-handling, robustness | TS (opt-in `--typecheck`) |
| R-ORM-SYNCHRONIZE-ENABLED | marcus.control | side-effect-control, robustness | TS/JS |
| R-ORM-SYNC-WITH-MIGRATIONS | marcus.judgment | decision-evidence, robustness | TS/JS |
| R-ORM-ENTITY-NO-PK | marcus.judgment | robustness, decision-evidence | TS/JS, PHP (`@Entity` / `#[ORM\Entity]`) |
| R-ORM-EAGER-RELATION | marcus.control | side-effect-control, robustness | TS/JS, PHP (`@Entity` relations) |
| R-ORM-NULLABLE-NO-DEFAULT | marcus.obstacle | robustness, error-handling | TS/JS, PHP (NOT NULL add in `up()`) |
| R-MIGRATION-UNGUARDED-DDL | marcus.obstacle | robustness, error-handling | TS/JS, PHP (migration files only) |
| R-MIGRATION-NO-DOWN | marcus.judgment | robustness, decision-evidence | TS/JS, PHP (migration files only) |
| R-MIGRATION-DATA-LOSS | marcus.judgment | robustness, decision-evidence | TS/JS, PHP (drops in `up()`) |
| R-VALIDATION-MISSING-BACKEND | marcus.judgment | robustness | TS/JS (server handler reads `req`/`request` `.body`/`.query` with no recognized validation; risk signal) |
| R-VALIDATION-MASS-ASSIGNMENT | marcus.judgment | robustness | TS/JS (raw payload flows whole into `Object.assign`/a persistence call; risk signal) |
| R-A11Y-IMG-ALT | marcus.purpose | accessibility | HTML, JSX, Vue, Angular (static, WCAG 1.1.1) |
| R-A11Y-CONTROL-NAME | marcus.purpose | accessibility, usability | HTML, JSX (static, WCAG 4.1.2) |
| R-A11Y-FORM-LABEL | marcus.purpose | accessibility, usability | HTML, JSX (static, WCAG 1.3.1/4.1.2) |
| R-A11Y-LINK-NAME | marcus.purpose | accessibility, usability | HTML, JSX (static, WCAG 2.4.4/4.1.2) |
| R-A11Y-ARIA-HIDDEN-FOCUSABLE | marcus.cooperation | accessibility, usability | HTML, JSX, Vue, Angular (static, WCAG 4.1.2) |
| R-A11Y-ARIA-INVALID-ROLE | marcus.purpose | accessibility | HTML, JSX, Vue, Angular (static, related: WCAG 4.1.2) |
| R-A11Y-ARIA-UNKNOWN-ATTR | marcus.purpose | accessibility | HTML, JSX, Vue, Angular (static, related: WCAG 4.1.2) |
| R-A11Y-ARIA-INVALID-VALUE | marcus.purpose | accessibility | HTML, JSX, Vue, Angular (static, related: WCAG 4.1.2) |
| R-A11Y-POSITIVE-TABINDEX | marcus.cooperation | accessibility, usability | HTML, JSX, Vue, Angular (static, WCAG 2.4.3) |
| R-A11Y-HTML-LANG | marcus.purpose | accessibility | HTML (static, WCAG 3.1.1) |
| R-A11Y-META-VIEWPORT-ZOOM | marcus.cooperation | accessibility, usability | HTML (static, WCAG 1.4.4) |
| R-A11Y-ARIA-DANGLING-IDREF | marcus.purpose | accessibility | HTML (static, WCAG 1.3.1/4.1.2) |
| R-A11Y-DUPLICATE-ID | marcus.purpose | accessibility | HTML (static, related: WCAG 1.3.1/4.1.2) |
| R-A11Y-FRAME-TITLE | marcus.purpose | accessibility, usability | HTML, JSX, Vue, Angular (static, WCAG 4.1.2) |
| R-A11Y-CONTRAST-TEXT | marcus.cooperation | accessibility, usability | HTML, JSX, Vue, Angular (inline colours, WCAG 1.4.3) |
| R-A11Y-FLUTTER-IMAGE-LABEL | marcus.purpose | accessibility | Flutter/Dart (widget, `semanticLabel`/`excludeFromSemantics`) |
| R-A11Y-FLUTTER-ICONBUTTON-LABEL | marcus.purpose | accessibility, usability | Flutter/Dart (widget, `tooltip`) |
| R-A11Y-FLUTTER-TEXTFIELD-LABEL | marcus.purpose | accessibility, usability | Flutter/Dart (widget, `InputDecoration.labelText`) |

Procedural rules (`ProjectRule`, cross-file). Not listed in this table: the
eight Flutter lifecycle/layout rules (`R-FLUTTER-*`, always on, Dart) and the
SOLID rules `R-SOLID-LSP-CONTRACT-COMPATIBILITY`,
`R-SOLID-ISP-INTERFACE-COHESION`, `R-SOLID-DIP-CONCRETE-DEPENDENCY`
(`--solid`, experimental) — see `docs/en/rule-model.md` and the log entries
above:

| Rule | Principle | Dimension | Note |
|------|-----------|-----------|------|
| R-DEP-CYCLE | marcus.cooperation | dependencies | Tarjan SCC over relative imports, PHP `use` via PSR-4 and unconditional C/C++ quoted includes (1.1.0); type-only imports skipped |
| R-UNUSED-EXPORT | marcus.cooperation | dependencies | opt-in `--dead-exports`; only sound for whole-project scans |
| R-SOLID-DIP-LAYER-DIRECTION | marcus.cooperation, marcus.control | dependencies | opt-in `--solid`; **experimental**, semantic-heuristic 0.5, low; Dart: a UI library (resolved Flutter widget/State base) imports a data-access package or a project data-access module (stage 1, library level) |
| R-VALIDATION-CONTRACT-INVALID-ID | marcus.purpose | robustness | opt-in `--contracts <file>`; a `stoa:validation` annotation does not match the Trace ID format |
| R-VALIDATION-CONTRACT-UNKNOWN-ID | marcus.purpose | robustness | opt-in `--contracts`; valid ID, but not in the loaded contract |
| R-VALIDATION-CONTRACT-UNRESOLVED | marcus.judgment | robustness, decision-evidence | opt-in `--contracts`; construct not resolvable as a scalar Zod chain (Insufficient Evidence) |
| R-VALIDATION-CONTRACT-MISMATCH | marcus.judgment | robustness | opt-in `--contracts`; extracted conditions disagree with the contract |
| R-VALIDATION-CONTRACT-CONFLICT | marcus.judgment | robustness | opt-in `--contracts`; same Trace ID, conflicting implementations |
| R-VALIDATION-CONTRACT-NOT-IMPLEMENTED | marcus.judgment | robustness, decision-evidence | opt-in `--contracts`; contract entry with no annotation anywhere (low confidence, not proof of absence) |
| R-VALIDATION-CONTRACT-UNUSED-VALIDATOR | marcus.obstacle | robustness | opt-in `--contracts`; an annotated, resolvable validator is never invoked anywhere in its file |
| R-VALIDATION-CONTRACT-RAW-AFTER-VALIDATION | marcus.judgment | robustness | opt-in `--contracts`; a validator is invoked with request data, but a raw copy of the payload still reaches a persistence sink in the same function |
| R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED | marcus.judgment | robustness, decision-evidence | opt-in `--contracts`; the validated value is passed to a business/persistence-named call Stoa cannot resolve within the file |
| R-VALIDATION-CONTRACT-LAYER-UNRESOLVED | marcus.judgment | robustness, decision-evidence | opt-in `--contracts`; the contract claims the backend layer, but no implementation was proven fed by request data |
| R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED | marcus.judgment | robustness, decision-evidence | opt-in `--contracts`; the contract requires `security.serverSideValidation`, but no implementation was proven fed by request data |
| R-VALIDATION-CONTRACT-SAFEPARSE-UNGUARDED | marcus.judgment | robustness, decision-evidence | opt-in `--contracts`; a `.safeParse()` result's `.data` is used without a proven `result.success` check |

All ten quality dimensions (incl. accessibility, usability) have at least one rule.

## C/C++ memory-safety rules

The one place in the rule catalog where a language's OWN distinguishing risk
(manual memory management) is covered, rather than only the language-neutral
complexity/error-handling rules every adapter gets (`src/analysis/cpp/CppExtraction.ts`).
Tree-sitter has no symbol table or type checker — unlike the TypeScript side's
`SymbolResolution.ts`, there is no binder to resolve against, so matching is
approximated via a real SCOPE WALK over identifier text (`resolveBindingSite()`),
never across functions or files. Within that constraint, both rules are
deliberately conservative: a false negative is preferred over a false
positive (the same standing bias as the rest of this engine), confirmed by
dogfooding against eleven real external C/C++ repositories (not synthetic
fixtures only) before shipping.

- **Scope-aware, not text-only, identity** (follow-up "Analysis Integrity &
  Memory-Bounded Pipeline" spec): confirmed, before any fix, that the
  original pure-text matching produced ZERO findings for
  `int* p = new int(1); { int* p = new int(2); delete p; }` — the inner
  `delete p` silenced the OUTER leak. `resolveBindingSite()` now climbs
  outward through enclosing `{ }` blocks exactly like C++ name lookup does:
  the nearest enclosing block with an EARLIER same-named declaration wins.
  A declaration guarded by `#ifdef`/`#else` is treated as being at its
  surrounding block's scope level, not one level deeper (tree-sitter nests
  it that way; the compiler does not) — and when both mutually exclusive
  branches declare the same name in one block (tree-sitter parses both
  unconditionally), a later release is matched against EITHER branch, not
  just whichever came first in source order (confirmed as a real false
  positive in `vllm`'s `cumem_allocator.cpp` during this fix, now a
  regression test). Every declarator identifier in the function (not just
  this allocation's own) is excluded from ever being treated as a "use" of
  something else — without this, a shadowing declaration's own name would
  incorrectly resolve back to the outer allocation (it cannot shadow itself
  at its own declaration point) and be misread as that outer pointer being
  passed to another declaration.
- **Reassignment to `nullptr` or a new allocation is not an escape:**
  `p = nullptr;` or `p = new T(...);` neither frees the ORIGINAL object nor
  hands it anywhere — the handle is simply overwritten. Both are excluded
  from the escape check (unlike `other = p;`, which genuinely is an escape),
  so the original allocation is still correctly flagged as leaked if nothing
  freed it first.

- **Tracked:** a direct `Type* name = new ...;` / `Type* name = malloc/calloc/realloc(...);`
  (optionally cast-wrapped) in ONE statement. **Not tracked, documented as a
  gap, not guessed at:** a bare `Type* name;` followed by a separate
  assignment; multiple declarators in one statement (`int *a, *b;`);
  anything inside a lambda (consistent with the existing complexity-metric
  scoping — lambdas are not analyzed as their own unit at all); placement new
  (`new (buf) T(...)` constructs IN caller-owned storage — there is nothing
  of its own to release, so it is excluded from tracking entirely, not just
  from the leak check).
- **Escape analysis** (`R-CPP-UNRELEASED-ALLOCATION`): every other reference
  to the allocated identifier in the function is classified by climbing
  through value-preserving wrappers (a cast, parentheses, a braced aggregate
  initializer, a ternary branch — but NOT a dereference/member/subscript
  operator, which consumes the pointer value itself rather than passing it
  on) to find the nearest meaningful ancestor: a matching
  `delete`/`delete[]`/`free(...)` is a release; a call argument, a `return`,
  a reassignment (either side of `=`), or another declaration's initializer
  is an ESCAPE — ownership may have transferred, so no leak claim is made at
  all once one occurs. A `static` local is excluded up front (a
  process-lifetime "allocate once" singleton is a deliberate, if
  controversial, idiom — not a bug; found via dogfooding against
  `mimirmind`'s `bigBlockPool()`, explicitly commented `// intentionally
  leaked` in the source). Anything else (a dereference, `obj->field`,
  `arr[i]`, a null check) is an ordinary local use — it neither releases nor
  escapes the pointer, so an allocation that IS used internally but never
  released still correctly fires (recall this engine's narrow identifier-text
  matching does not sacrifice: "allocate, use, forget to free" is caught, not
  just "allocate and never touch again").
- **`R-CPP-NEW-DELETE-MISMATCH`** checks the array-ness of the allocation
  (`new T[n]` vs `new T`) against every matching `delete`/`delete[]` found
  for that identifier, independent of the escape analysis above (a mismatch
  is about the PAIR, not about whether the pointer also escapes elsewhere
  first). Found 4 genuine instances on first real-world use (legacy MFC C++
  in a hobby project's `SMADlg.cpp`: `new unsigned char[...]` freed with
  plain `delete` four times over).
- **Dogfooding fixed two real false-positive classes before this shipped**
  (both now locked in as regression tests in `test/Cpp.test.ts`): (1) a
  pointer returned inside a braced aggregate initializer
  (`return ComputeBuffer{raw, bytes, deleter};`) was not recognized as an
  escape — only a bare `return raw;` was; (2) placement new was being tracked
  as an ordinary allocation, flagging every use as an unreleased leak. Both
  found against real external repositories, not invented as hypotheticals.

## Validation Trace IDs & contract verification (first vertical slice)

Opt-in via `stoa analyze <path> --contracts <contract.json>`; without this
option the feature is **fully inert** (annotations are always extracted as
facts — cheap, mirroring the existing `stoa:allow-complexity` marker — but
never interpreted). A tampered or missing contract disables no other checks
and improves no status; a malformed contract — including a duplicate rule id
*within* the contract, checked beyond what the JSON Schema itself expresses —
fails fast (exit 1, concrete errors) instead of silently yielding 0 findings.

- **Validation Trace ID:** a stable, project-chosen business ID (e.g.
  `VC-ITEM-QUANTITY-001`; format `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+-[0-9]{3}$`, see
  `schemas/validation-contract.schema.json`). It is an analysis hint, **not**
  a security mechanism, and must **not** be confused with Stoa's own `R-*`
  rule, `finding:` or `fact:` ids — which is exactly why all twelve new Stoa
  rules deliberately use the `R-VALIDATION-CONTRACT-*` prefix, not `R-VC-*`.
- **Annotation:** `// stoa:validation <ID>` as a leading comment on a
  `const x = …` statement (`src/analysis/typescript/ValidationAnnotations.ts`,
  `getLeadingCommentRanges()`, the same mechanism as the existing marker).
  **TypeScript only**, and only a direct scalar Zod chain
  (`z.number()`/`z.string()`/`z.boolean()`/`z.enum([...])`) is resolved. Every
  recognized modifier has an **explicitly modeled** effect — none is
  silently treated as a no-op: `.int()` → `integer`; `.email()`/`.url()` →
  `format` — chaining both keeps every distinct format seen (Zod ANDs every
  check together, so a contract requiring one of them is satisfied as long as
  it is among the enforced set, never overwritten by whichever format
  modifier happens to appear last); `.positive()`/`.nonnegative()`/`.min()`
  are tightened to the strictest lower bound order-independently
  (`.positive()` exclusive, `.nonnegative()`/`.min()` inclusive — not "last
  modifier in the chain wins"); `.max()` is tightened the same way to the
  smallest upper bound across however many calls are chained; a combined
  range with no satisfiable value (e.g. `.min(10).max(5)`) is reported as
  **unresolved** rather than silently resolved to one bound;
  `.optional()`/`.nullable()`; `.trim()`/`.toLowerCase()`/`.toUpperCase()`;
  `z.enum([...])` → `allowedValues` (string literals only). Any other call
  (array schemas, a vts schema, `.refine()`, `.transform()`, `.default()`, …)
  is **unresolved** — never guessed at. A `z.object({...})` is additionally
  resolved **field by field**: Stoa compares the ONE field a contract rule
  actually names (`contractRule.field`) using the same scalar-chain
  resolution, without resolving or guessing at the rest of the object's
  shape. A field the schema doesn't declare at all, or whose own value isn't
  a recognized scalar chain, is unresolved by name (`Object.hasOwn`, not the
  `in` operator — a field literally named `constructor`/`toString` is never
  confused with an INHERITED `Object.prototype` property, and the fields map
  itself is a null-prototype object so a field literally named `__proto__`
  is never silently swallowed by the `__proto__` setter instead of being
  stored); a field that resolves is compared exactly like a top-level
  scalar schema would be, and participates in CONFLICT detection (two
  implementations sharing a trace ID, with differing conditions for that
  one field) the same way a scalar schema's conditions do — a field that is
  missing on one side is excluded from the comparison entirely, never
  silently treated as "the same" as a resolved sibling. This closed the gap
  where every realistic `z.object(...)` request-body schema — the common
  case — was unconditionally unresolved regardless of whether its one
  relevant field actually matched the contract. Object-level modifiers
  chained after the base `z.object({...})` are resolved incrementally,
  never guessed at for anything beyond this list: `.strict()` (the field set
  is unaffected), `.partial()` (every field becomes optional), `.extend({...})`
  (merges another plain object literal's fields in, overriding the base on
  a name clash), `.merge(<expr>)` (merges another schema's fields in the
  same way, where `<expr>` resolves inline OR through ONE identifier
  reference to a separately-declared `const base = z.object({...})` — the
  realistic shape for reusing a shared base schema). Any other chained call,
  a spread/shorthand/computed property name in the object literal, a nested
  `z.object(...)` field (no dotted/nested field paths), or
  `z.array(z.object({...}))` at the top level, stays unresolved.
- **Contract:** a JSON file validated against
  `schemas/validation-contract.schema.json` (reuses the existing ajv2020
  pattern from `KnowledgeValidation.ts` — no new format introduced). Fields:
  `integer`, `format` (`email`/`url`), `allowedValues` (a set, compared
  order-independently), alongside the existing `min`/`max`/`required`/
  `nullable`/`normalization`. Every field but `id`/`description`/`field`/
  `dataType` is optional; only the dimensions the contract actually declares
  are compared. Rule ids must be **unique within one contract** (checked
  beyond ajv; two entries sharing an id are always a contract defect, even if
  their conditions happen to agree — unlike the softer, code-side CONFLICT
  finding for two differing *implementations*).
- **Matching** (`src/rules/project/ValidationContractRule.ts`, one
  `ProjectRule`, the same pattern as `R-DEP-CYCLE`/`R-UNUSED-EXPORT` — hence
  no JSON rule file of its own, text hardcoded in TS, documented here in the
  table): invalid ID format; ID not in the contract; construct not
  resolvable; extracted conditions disagree with the contract (dataType/
  required/nullable/min/max/integer/format/allowedValues/normalization); the
  same ID with conflicting implementations (symmetric — Stoa does not decide
  which side is correct); a contract entry with no annotation at all (low
  confidence, anchored at the contract file itself since no source file
  applies).
- **Validator usage** (`src/analysis/typescript/ValidatorUsage.ts`, new facts
  `validation.annotatedValidatorUnused` / `validation.rawReuseAfterValidation`):
  no longer just the annotated schema's SHAPE, but whether it is actually
  invoked. An annotated, resolvable validator whose `.parse()`/`.safeParse()`
  never appears anywhere in its file is **unused**. When it IS invoked with
  request data (even a single plucked field like `req.body.quantity` counts —
  looser than the mass-assignment rule's strict whole-object check), but the
  SAME function ALSO routes a raw whole-object value into a sink
  (`Object.assign`/a persistence-verb call, reusing the exact same hardened
  detection behind `R-VALIDATION-MASS-ASSIGNMENT`), the validation is treated
  as not actually gating what gets saved. Both checks are **scoped to one
  file or one function** — not a project-wide dataflow graph; a schema
  exported and used only from another (possibly unanalyzed) file looks
  identical to a genuinely unused one from here (documented limit, confidence
  capped at 0.5).
- **Evidence Graph & validator dataflow analysis** (`src/evidence/EvidenceGraph.ts`,
  `src/analysis/typescript/ValidationDataflow.ts`, new fact
  `validation.dataflowGraph`): where the VALIDATED value goes after a
  validator call, not just whether the call happened — one small graph per
  invocation, always extracted (no contract needed), with node kinds
  (`request-source`/`input-value`/`validation-schema`/`validator-invocation`/
  `validation-result`/`validated-value`/`function`/`service`/`repository`/
  `persistence-sink`) and edge kinds (`receives`/`validates`/`returns`/
  `assigns`/`passes-to`/`transforms`/`persists`/`bypasses`), each edge
  carrying: source/target node, source file + code position, a short
  human-readable `basis` (the concrete AST shape matched — every edge
  traces back to specific code, not just an assertion), an explicit status
  (`verified`: a direct same-function argument relationship; `heuristic`: a
  relationship inferred across a call boundary; `unresolved`: something
  relevant was found but the relationship could not be established), an
  optional `limits` array (present whenever status isn't `verified` — what
  specifically keeps it from being proven), and `producedBy` (which
  analysis function established the edge, e.g. `"OneHopResolution.resolveOneHop"`
  — so a reader can go straight to the code, not just the prose). A
  `heuristic` edge is never reported as `verified`, enforced by
  construction — every edge's status is decided once, when it is added;
  nothing re-visits or upgrades an edge afterward, and the same
  (from, to, kind) is never added twice with two different statuses. Two
  capabilities: a same-function trace to a
  persistence-verb call (`verified`), and ONE cross-function hop — resolved
  by ts-morph symbol, WITHIN THE SAME FILE ONLY, to a function/method with a
  plain (non-destructured) parameter at the matching position — into a
  persistence-verb call inside that declaration's own body (`heuristic`;
  the `userService.create(result.data)` → `UserService.create(data)` →
  `this.repository.save(data)` shape). When the validated value is passed to
  a call that reads as business/persistence-layer by name
  (`service`/`repository`/`repo`/`manager`/`store`) but cannot be resolved
  within the file (an import, a dynamic/computed call, an interface with no
  single implementation), the edge is `unresolved` and — when the
  annotation's ID is in the loaded contract — surfaces as
  `R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED` (low confidence, explicitly
  "could not be traced", never claimed as a defect). Everything else (the
  callee clearly isn't a sink, or resolves in-file to something with no
  persistence call at all) is silently not reported — not every validated
  value is meant to reach persistence. No cross-file resolution, no
  destructured/rest FUNCTION PARAMETERS in the one-hop step, no spread
  arguments, no recursion beyond one hop, only the FIRST call receiving the
  tracked value is traced.
- **Symbol-based dataflow resolution** (`src/analysis/typescript/SymbolResolution.ts`,
  wired into `ValidationDataflow.ts` and `OneHopResolution.ts`): every "is
  this the SAME value" check in the dataflow tracers resolves via ts-morph's
  own binder (`Symbol` identity), never by comparing identifier TEXT — two
  different variables that merely share a spelling (shadowed in a nested
  block, an unrelated same-named local elsewhere in the function) are never
  treated as the same value. Handles: a plain `const alias = tracked` (one
  hop, bounded depth, `const` only — a mutable alias is not followed, since
  it could itself be reassigned away from the tracked value); destructuring
  the validated result (`const { data } = result` after `.safeParse()`, in
  addition to the existing `result.data` property-access form); a validated
  value passed as an argument to a function, matched to that function's OWN
  parameter by symbol, not by the parameter's spelling (the one-hop case).
  A binding that is reassigned ANYWHERE in its enclosing function (scanned
  over-inclusively — the safe direction) is never claimed to still carry the
  validated value past that point: tracing simply stops (no edge), rather
  than guessing which assignment "wins" without a real control-flow graph.
  Not handled yet, documented as a gap rather than silently assumed:
  tracing a validated value across a `return` statement into the function's
  own callers (the trace stops at the function boundary, acknowledging the
  return happened but claiming nothing about what the caller does with it).
- **safeParse() success/failure-path verification** (`src/analysis/typescript/SafeParseGuard.ts`):
  accessing `.data` after `.safeParse()` is not by itself proof the access
  is safe — `.safeParse()` returns a discriminated union, and `.data` is
  only sound once `result.success` is PROVEN true by the surrounding
  control flow. The `transforms` edge (validation-result → validated-value)
  now reflects this instead of always being `verified`: `verified` only for
  two sound shapes — an early-exit guard (`if (!result.success) { throw/return/… }`
  unconditionally terminating, so later code in the same block only runs on
  success) or a nested positive guard (`if (result.success) { …access… }`),
  each allowed to combine with other conditions via AND/OR as long as the
  combination stays logically sound (an AND-combined reject, or an
  OR-combined accept, is NOT sound and does not count). Otherwise
  `unresolved` — either nothing references `result.success` at all, or
  something does but not soundly — surfaced (contract-gated, like its
  siblings) as `R-VALIDATION-CONTRACT-SAFEPARSE-UNGUARDED` (medium severity,
  0.5 confidence: a real, demonstrable gap, not just "could not trace
  further"). Stoa never assumes safety just because SOME condition happens
  to precede the access.
- **Layer & security attribution** (`ValidationContractRule.ts`): a contract's
  `layers`/`security` fields are a CLAIM, not proof. When a rule claims the
  `backend` layer, or declares the one structured security flag Stoa can
  actually check (`security.serverSideValidation`), Stoa reuses the Validator
  Dataflow Analysis's own evidence (a `validation.dataflowGraph` fact only
  exists for an invocation proven fed by request data) to confirm the claim;
  an annotated implementation that was never shown running on the backend is
  `R-VALIDATION-CONTRACT-LAYER-UNRESOLVED` / `-SECURITY-UNVERIFIED` (low
  confidence). A `frontend`-only claim, and the other five `security` flags
  (`authenticationRequired`, `authorizationRequired`, `ownershipRequired`,
  `tenantIsolation`, `massAssignmentProtection`) are accepted and
  schema-validated but intentionally produce NO finding either way — Stoa
  has no session/auth/tenant model to verify them, and their absence from a
  finding list must never be read as "confirmed met".
- **Mass assignment extensions** (`BackendValidation.ts`): `R-VALIDATION-MASS-ASSIGNMENT`
  now also recognizes a DIRECT property assignment tainting an object (`entity.data = req.body`,
  not just a `const x = req.body` alias — a later `repo.save(entity)` is flagged
  the same way), a raw payload passed through ONE cross-function hop to a
  persistence-verb call (reusing the same one-hop resolver as the dataflow
  tracer, in `OneHopResolution.ts`, shared to avoid a second implementation
  of the same mechanics), and one narrow ORM-specific verb addition,
  `merge` (TypeORM `repository.merge(entity, req.body)`) — not `preload`/`set`,
  too generic (cache/Map/etc.) to add without a real false-positive cost. A
  single plucked field through a direct assignment stays out of scope, same
  as the existing single-field restriction elsewhere in this rule.
- **Deliberately out of this slice** (documented, not faked): verifying more
  than the ONE contract-named field of a `z.object()` schema (the rest of
  its shape is never inspected, even when resolvable); a nested `z.object()`
  field, a spread/shorthand/computed property name, or
  `z.array(z.object({...}))`; tracing a validated value across a `return`
  into the function's own callers; cross-file usage proof; API-endpoint/
  alternate-endpoint bypass detection; a frontend/backend layer heuristic
  for the conflict check; structured, machine-verified backend-only
  security requirements (`securityRequirements` stays free-text and purely
  informational — deliberately never surfaced as a verified security rule);
  languages other than TypeScript.
- Checked against real code: `stoa:validation` appears in none of the real
  repos used so far (expected — it is a project-specific marker that is new
  here), so the usage-tracing rules could only be verified against
  purpose-built fixtures, not a real annotated project (a documented limit).
  Fact extraction ran with no crash/regression against real Zod usage
  (kapalium `backend/`+`shared/`, 37 files — `shared/` exports Zod schemas
  across files, exactly the risky FP shape for the unused-validator check)
  and against stoa's own `src/` (58 files) — `0` findings without
  `--contracts` in every case, as designed.

## Facts produced

`file.lineCount`, `file.parseErrors` (Dart), `dart.importSpec`, `dart.classDecl`, `struct.typeDecl` (Dart, TS), `struct.importBindings` (TS), `ui.flutterWidgetTree`, `metric.exportCount`, `metric.cyclomaticComplexity`,
`metric.cognitiveComplexity`, `metric.nestingDepth`, `metric.parameterCount`,
`metric.functionLength`, `doc.hasComplexityRationale`, `ast.usesNondeterminism`,
`ast.emptyCatch`, `ast.catchSwallowsError`, `doc.catchHasRationale`, `deps.import`, `deps.importUnused`,
`deps.importDeep`, `deps.export`, `deps.importName`, `deps.reexport`, `orm.synchronizeEnabled`,
`orm.syncWithMigrations`, `orm.entityNoPrimaryKey`, `orm.eagerRelation`,
`migration.unguardedDdl`, `migration.noDown`, `migration.dataLoss`,
`migration.nullableNoDefault`, `ui.imageMissingAlt`, `ui.controlMissingName`,
`ui.controlMissingLabel`, `ui.linkMissingName`, `ui.ariaHiddenFocusable`,
`ui.invalidRole`, `ui.unknownAriaAttribute`, `ui.invalidAriaValue`,
`ui.positiveTabindex`, `ui.documentMissingLang`, `ui.viewportBlocksZoom`,
`ui.danglingAriaIdref`, `ui.duplicateId`, `ui.frameMissingTitle`,
`ui.lowContrastText`, `ui.flutterImageNoSemanticLabel`,
`ui.flutterIconButtonNoTooltip`, `ui.flutterTextFieldNoLabel`,
`validation.backendInputUnvalidated`, `validation.rawRequestMassAssignment`,
`validation.contractAnnotation`, `validation.annotatedValidatorUnused`,
`validation.rawReuseAfterValidation`, `validation.dataflowGraph`, `struct.anchor` (identity scheme 3: TS/JS top-level bindings, HTML/template elements with an `id`), plus (opt-in) `external.tsc` and
`external.floatingPromise`.

## Quality assurance

- **node:test suite** (`npm test`, `test/*.test.ts`): 668 tests, 0 failed,
  0 skipped, as of the 2026-11-05 run (rules pos./neg., extraction, schema validation,
  i18n, determinism, SARIF, evaluation, semantic groundedness, privacy,
  finding-model separation, semantic models, identities, metrics).
- **Golden corpus** (`test/corpus/project/`, TS+PHP) with ground truth;
  evaluation currently **precision 100% · recall 100%** (TP 44) with a
  per-language breakdown (`byLanguage`). Per-rule precision gate (AC-5).
- **SOLID corpus** (`test/corpus/solid/`, Dart + TS): the four registered
  SOLID rules, 100%/100% (TP 7, FP 0, FN 0) both with and without a declared
  architecture (`expected.json`, `expected-architecture.json`); without
  `--solid` it produces no finding; every produced identity is unique
  (`test/SolidCorpus.test.ts`).
- C/C++ is covered by **adapter and rule tests** and was dogfooded on external
  repositories, but has **no** golden corpus with precision/recall.
- **Important:** these numbers hold only for the small, curated corpus and are
  **not** a general reliability guarantee for arbitrary projects.
- **UI/UX corpus** (`test/fixtures/html/`, static HTML) with positive, negative
  and deliberately-no-warning cases; evaluation 100%/100% (TP 37) per rule. The
  semantic (LLM) assessment is kept separate and is not required here.
- **JSX corpus** (`test/fixtures/jsx/`): the eleven ported a11y rules evaluated on
  React/JSX intrinsics; 100%/100% (TP 14), with positive, dynamic-value/children,
  spread, wrapping-label, htmlFor, style-object, component and clean cases.
- **Vue corpus** (`test/fixtures/vue/`): the eight ported a11y rules evaluated on a
  `.vue` template; 100%/100% (TP 8), with bindings (`:`/`v-bind`/`@`), `{{…}}`,
  a dynamic `:style`, a `<style>` block and a component, plus a clean component.
- **Angular corpus** (`test/fixtures/angular/`): the eight ported a11y rules on a
  `*.component.html`; 100%/100% (TP 8), with `[x]`/`[attr.x]`/`(event)`/`*ngIf`
  bindings and a dynamic `[style.color]`, plus a clean template — and a test that
  the Angular dialect (not plain HTML) ran.
- **Flutter corpus** (`test/fixtures/flutter/`): the three widget a11y rules on a Dart
  widget tree; 100%/100% (TP 6), with `Image.network`/`Image(...)` lacking a label,
  an `IconButton` without `tooltip`, a `TextField()` with no decoration, one with a
  label-less `InputDecoration`, and an IconButton inside a label-less `Semantics`,
  plus negative cases (present `semanticLabel`, `excludeFromSemantics: true`,
  `tooltip`, `labelText`, `hintText`, a variable decoration, `IconButton.styleFrom`,
  and an Image/IconButton/TextField each named by a `Semantics(label: …)`) and a
  clean widget.
- **A11y correctness corpus** (`test/fixtures/a11y-correctness/`): regression tests
  for the name/focus/ARIA correctness pass, exercised through the real analysis path
  (HTML, JSX, Vue). Pinned: text inside an `aria-hidden` subtree is not a name;
  `aria-labelledby` is resolved against its targets in HTML (empty value, missing or
  empty targets → no name; reference chains with a cycle guard); `role=presentation`
  does not exempt a focusable control from needing a name; strict tabindex and
  `contenteditable` focus; contrast is judged even under `aria-hidden`/
  `role=presentation` (the text is still visually rendered).
- **Backend-validation corpus** (`test/fixtures/backend-validation/`): positive
  (handler reads `req.body`/`req.query` with no validation; the raw payload flows
  into `Object.assign`/a persistence call — directly or spread) and negative cases
  (Zod `.parse`, a vts wrapper + `schema.validate`, a manual 400 guard, a Fastify
  route schema, params-only, a manual allow-list). A handler can satisfy
  `R-VALIDATION-MISSING-BACKEND` (it rejects malformed input) and still trigger
  `R-VALIDATION-MASS-ASSIGNMENT` (it saves the untouched raw payload) — both rules
  are tested as genuinely separate concerns. A `throw`/400-style rejection only
  counts as validation if the condition guarding it actually references the
  request (directly, or via a strict `const body = req.body` alias) — a
  `throw` gated by an unrelated condition (e.g. a DB-lookup result, as in
  `if (!user) throw …` where `user` came from `repository.findById(...)`) is
  no longer mistaken for an input check (regression fixture
  `unrelated-throw.ts`). A validator reached only via a verified AST
  relationship — e.g. `const v = schema.safeParse.bind(schema)` — is also
  recognized even when its own name matches no naming heuristic. Also checked manually against
  **five real TS backends** (audiomesh, headbangbear — both a `{bodySchema}`
  wrapper pattern; kapalium = Zod; helionet_pro = vts; loki = Express with no
  schema): `R-VALIDATION-MISSING-BACKEND` **0 false positives** after two
  hardening rounds (down from 29 earlier false alarms from `params` lookups,
  unrecognized wrapper schema options, and single-field plucks);
  `R-VALIDATION-MASS-ASSIGNMENT` **1 finding, verified true positive** (loki:
  `req.body` is only checked `typeof === 'object'`, then saved raw), **0 false
  positives** on the other four.
- **Validation/dataflow golden corpus** (`test/fixtures/validation-dataflow-corpus/`,
  `ValidationDataflowCorpus.test.ts`): a dedicated, self-contained corpus
  mirroring the existing `test/corpus/` precision/recall pattern (not a
  second ground-truth mechanism), covering 20 explicitly required test
  groups in one place — correct validation, missing validation, an unused
  validator, a validator called but its result ignored (raw reused after
  validation), validation declared in a function that is never called,
  cross-function handoffs (both a validated-and-traced good path and a raw,
  unvalidated bad path), `.max()` merging, format AND-merging, an
  unresolvable Zod modifier, an AST-verified `.bind()` alias, a generic
  exception unrelated to the request, mass assignment via spread, security
  requirements Stoa cannot verify (asserted to produce NOTHING), conflicting
  FE/BE implementations under one trace ID, symbol-based shadowing (a
  shadowed `result` in a nested block correctly produces NOTHING, proving
  `SymbolResolution.ts` end-to-end rather than only in its unit tests),
  `.safeParse()` used without a proven success check
  (`R-VALIDATION-CONTRACT-SAFEPARSE-UNGUARDED`), an object-field conflict
  between two `z.object()` schemas sharing a trace ID, a field literally
  named `constructor` (correctly produces NOTHING, proving the
  prototype-safety fix end-to-end), and a nested `z.object()` field (stays
  unresolved rather than guessed at). 100%/100% (TP 20).
  Building this corpus caught one real bug before it shipped further: the
  unused-validator and raw-after-validation checks (`ValidatorUsage.ts`)
  shared the dataflow tracer's now-fixed-elsewhere gate requiring a
  schema's scalar shape to be resolvable — which a `z.object(...)` request
  body (the realistic case) never is, silently making both checks dead code
  for it; only bare scalar schemas in the pre-existing fixtures ever
  exercised them. Fixed the same way as the dataflow tracer's equivalent fix.
- Dogfooding: stoa analyzes its own `src/`.
- **Findings comparison** (`scripts/compare-findings.ts`): the check behind
  every "reports byte-identical" in this document. `snapshot <dir>` writes
  each target's findings as JSON lines (report order, paths relative to the
  target) plus `snapshot.json` with the identity scheme; `diff <before>
  <after>` compares two directories file by file and, where one differs,
  pairs the findings by identity (`src/FindingDiff.ts`, the evaluator's and
  the baseline's key) and reports per target `same`, `order`, `moved`
  (positions only), `CHANGED` (`+` added, `-` removed, `~` changed content
  with the fields) or `INTEGRITY` (an identity held twice); snapshots of two
  schemes are paired by position and a changed identity is listed as `=`.
  Exit 1 on any difference.
  `--jobs N` checks parallel extraction against the sequential run. The
  default targets (`scripts/compare-targets.json`) cover this repository
  only; your own projects go in `.stoa/compare-targets.json` (ignored by git
  like all of `.stoa/`, together with their architecture configs) and are
  passed with `--targets .stoa/compare-targets.json`. Grammars are loaded as in the CLI.

- **Parallel extraction comparison** (`scripts/compare-jobs.ts`): runs
  `analyze` sequentially and with `--jobs` 1/2/4/8 (configurable), records
  wall time, peak RSS, CPU time and load, and compares findings, identities,
  order, coverage and exit code with the sequential run; `--cache` and
  `--errors` add the fact-cache and error-behaviour checks (see "Parallel
  extraction compared"). Targets as above.
- **Memory per pipeline phase** (`scripts/measure-phases.ts`): every target
  in a fresh `node --expose-gc` process; after a full collection it samples
  heap, external memory and RSS at start, after ingestion, after the graphs,
  after the rules, with the result alive and after it is released, plus the
  phase timings and the peak RSS; JSON lines, a Markdown table, `--out` for
  the rows. Targets as above (`scripts/CompareTargets.ts`, shared by all
  three scripts).
- **External validation** (`scripts/external-validation.ts`): `fetch`
  checks the projects of `validation/external/` out at their commit into
  `.stoa/external/` and verifies the SHA; `sample` prints the unlabeled
  findings of the deterministic sample as label skeletons; `report` counts
  per project, rule and language (precision only over TP/FP, recall only in
  `fnScope`, stale labels apart). See "External validation" and
  `validation/external/README.md`.

## Deviations from the concept (deliberate, documented)

- **PHP parser:** `php-parser`/glayzzle (pure JS, in-process) instead of a
  `nikic/php-parser` subprocess (OQ-3) — deterministic & testable.
- **Type checker / floating promises:** in-process via the TS compiler API rather
  than an ESLint subprocess — the same check, no fragile external process.
- **Localization:** `LocalizedText` fields on rules/principles + an i18n table.
- **include/exclude:** now effective (simplified in M1).
- **Dart/C/C++ via tree-sitter:** `web-tree-sitter` (WASM, in-process,
  deterministic) rather than native bindings/subprocesses — consistent with the
  glayzzle choice; the prebuilt `tree-sitter-{dart,c,cpp}.wasm` avoid an
  emscripten build.

## Not yet done

C/C++ include paths (`-I`, `compile_commands.json`) — a quoted include is
resolved only next to the including file; Dart edges in R-DEP-CYCLE /
R-UNUSED-EXPORT (Dart imports exist as `dart.importSpec` in the ModuleGraph,
but the two rules read only TS/PHP/C/C++ edges); R-UNUSED-EXPORT for PHP
(PSR-4 resolution exists since identity spec phase 4, export/import-name
facts for PHP do not); a git-diff/PR mode (the stored-snapshot baseline
exists, see "Baseline / diff mode"); a suppression workflow beyond the
baseline; a generic ESLint fact adapter; context facts (`flag.generatedCode`, `hasTests`)
for richer suppression; LLM-output evaluation at scale.

**From the external validation (2026-11-05, see "External validation"):** all defects listed for fixing are fixed since — the else-if nesting, R-UNUSED-EXPORT, the PHP R-DEP-UNUSED, generated code, PHP 8.4 syntax and the Dart closure attribution (2026-11-06/07). The single FP patterns of other rules listed there remain open.

**Open from the evaluator-integrity track (2026-11-04):** in the TS
extraction, the parse
itself (≈ 15 %; examined without a safe lever, see "The TypeScript parse";
files can now be processed in parallel, opt-in, see "Parallel extraction") and ts-morph's wrapper creation (≈ 9 %, needed by the
extraction's navigation — wrapping lazily was measured without gain, see
"Wrapping only what is queried"; the second walk around it is gone, see
"Building the node index in one walk"); not building the SymbolGraph under
`--solid` when no type declarations exist (measured 2.7 ms, low priority).

**Cross-layer validation — limits (first vertical slice):**
`R-VALIDATION-MISSING-BACKEND` (the "Missing Backend Validation" category) and
`R-VALIDATION-MASS-ASSIGNMENT` (the "Untrusted Property / Mass Assignment"
category) deliberately check only **one** layer (the backend trust boundary),
not the full frontend → API → backend → persistence chain sketched in the
analysis vision. There are **no** facts yet for frontend form constraints, API
contracts/DTOs, Zod/vts schema value ranges, or endpoint data flow — a genuine
frontend/backend *constraint mismatch* (differing value ranges/required-ness
between layers) is **not** reliably detectable with the current fact model and
is not claimed. Mass assignment is further limited to the statically recognized
sinks `Object.assign` and calls named like a persistence verb (`save`/`create`/
`update`/`insert`/`upsert`/`persist`/`replace`); whether a schema meant as an
allow-list itself permits extra keys (e.g. Zod `.passthrough()`) is not checked.
TypeScript/JavaScript only; PHP/Dart backends are not covered. See each rule's
`missingContext` for the detection limits within the one layer (e.g.
`preValidation` hooks, global middleware).

**Cross-layer analysis — readiness for an end-to-end chain (assessment, not a
new feature):** the long-term goal is a provable Frontend Input → Frontend
Validation → API Request → Backend Request → Backend Validation → Validated
Data → Service → Repository → Database chain. Today, only **one ring** of
that chain is actually evidence-graph-proven: Backend Request → Backend
Validation → Validated Data → (same-file, or one same-file hop into a)
Service/Repository call (`ValidationDataflow.ts`/`OneHopResolution.ts`/
`SafeParseGuard.ts`, symbol-based, with an honest `verified`/`heuristic`/
`unresolved` status on every edge — see above). Everything on either side of
that ring is either unmodeled or only a human-asserted claim, never
independently observed:
- **Frontend Input / Frontend Validation:** no frontend-specific facts exist
  at all. A contract's `layers: ["frontend"]` is accepted and
  schema-validated, but — unlike the `backend` claim, which Stoa actually
  confirms via dataflow evidence that the invocation was fed by request
  data — there is no analogous frontend-side proof; a `frontend` claim
  produces no finding either way (documented above, under Layer & security
  attribution).
- **API Request:** there are no facts for the request layer itself (HTTP
  method, route, request/response DTO shape). Nothing links "this frontend
  file calls `fetch('/api/users')`" to "this backend file routes
  `router.post('/users', handler)`" — this is the single largest missing
  building block for a real end-to-end link, and nothing in the current
  implementation claims otherwise.
- **Service → Repository → Database:** the one-hop resolver is same-file
  only; a validated value handed to a service imported from another file is
  not traced at all. Even where it is traced, Stoa only proves the value
  reaches a call that *looks like* a persistence verb by name
  (`save`/`create`/`repository.*`/…) — it has no model of what that call
  actually writes, to which table or column, so nothing is proven about the
  Database itself, only up to the repository-call boundary.
- **FE/BE conflict detection** (`R-VALIDATION-CONTRACT-CONFLICT`) compares
  two schemas that share a human-chosen Validation Trace ID — it is evidence
  that two *annotated* implementations disagree, not proof that those two
  schemas correspond to the same real API request. The trace ID is a
  deliberate, explicit, opt-in annotation precisely so that **frontend and
  backend are never considered linked merely because they validate a
  field with the same name** — matching field names alone is not, and must
  not become, a substitute for a real request/response link.

In short: actually-linked (backend request → backend validation →
persistence, within the limits above), plausible-but-unproven (a `frontend`
layer claim, the other `security` flags), non-existent (API-request/DTO
facts, cross-file service resolution, any model of the database itself), and
non-analyzable with the current fact model (whether two trace-ID-matched
schemas really describe the same endpoint) are four genuinely different
states today, and Stoa's own findings already distinguish the first from the
rest — but a full, provable end-to-end chain is not implemented, and nothing
here claims it is.

**UI/UX — limits and planned:** static analysis only. Colour contrast
(WCAG 1.4.3) is checked only for the provable inline case (both colours on the
element); the **cascade/rendered** contrast — inherited or stylesheet colours,
images/gradients behind text, translucent colours — is **not** statically
decidable. Likewise **not** reliably decidable and therefore omitted: visible
focus, focus order/traps (beyond the static positive-tabindex signal), target
size, dynamic states — these need a rendered page/interaction (a planned
visual-analysis slice with browser automation). **React/JSX** is covered for 10
of the 14 rules (via the TS adapter's JSX walk), including the name-computation
rules (control/link name, form label) with dynamic-aware name resolution. The
four document/cross-element rules (`-HTML-LANG`, `-META-VIEWPORT-ZOOM`,
`-ARIA-DANGLING-IDREF`, `-DUPLICATE-ID`) are **not** ported to JSX: `<html lang>`
and `<meta viewport>` live in the app shell (e.g. a Next.js `_document`/`Head`,
not component JSX), and id/idref resolution across components with dynamic ids is
not statically sound. **Vue SFC** is covered for the 8 attribute/contrast rules
(shared template extraction with a Vue binding dialect); **Angular** external
`*.component.html` templates reuse it with an Angular dialect
(`[x]`/`[attr.x]`/`(x)`/`*ngX`). **Flutter/Dart** is checked not through markup but
through the widget tree (three widget-own checks: `Image` `semanticLabel`/
`excludeFromSemantics`, `IconButton` `tooltip`, `TextField`/`TextFormField`
`InputDecoration.labelText`) — without resolving ancestor `Semantics(...)` wrappers.
Next static steps: inline Angular `template:`
strings and Vue/Angular name-computation rules; further ARIA checks (e.g. `aria-*`
attributes invalid for the element's role).
(Implemented: `R-A11Y-FORM-LABEL`,
`R-A11Y-LINK-NAME`, `R-A11Y-ARIA-HIDDEN-FOCUSABLE`, `R-A11Y-ARIA-INVALID-ROLE`,
`R-A11Y-ARIA-UNKNOWN-ATTR`, `R-A11Y-ARIA-INVALID-VALUE`,
`R-A11Y-POSITIVE-TABINDEX`, `R-A11Y-HTML-LANG`, `R-A11Y-META-VIEWPORT-ZOOM`,
`R-A11Y-ARIA-DANGLING-IDREF`, `R-A11Y-DUPLICATE-ID`, `R-A11Y-FRAME-TITLE`.)

**Accessible name — static approximation:** name computation is a conservative
static approximation, **not** a reproduction of the browser accessibility tree. It
counts: a non-empty `aria-label`; visible text content **excluding** `aria-hidden`
subtrees; a nested `img[alt]`/`svg > title`; and — in HTML only — `aria-labelledby`
resolved against its targets in the same document (an empty value, missing targets,
or only-empty target text do **not** count as a name; reference chains are followed
with a cycle guard). In JSX, Vue and Angular `aria-labelledby` targets are **not**
resolved (no statically resolvable references), so a non-empty value is
conservatively treated as a name there (an empty value is not). Runtime/dynamic
content is treated as neither a proven defect nor proven correctness. Focusability
is derived from a strict integer `tabindex`, `contenteditable` and native
interactivity; `role=presentation`/`none` does **not** blanket-remove an element
from the a11y tree (the role is ignored on a focusable control, while a decorative
image stays valid).

**Technical anomaly vs WCAG violation:** for `R-A11Y-ARIA-UNKNOWN-ATTR`,
`-ARIA-INVALID-VALUE`, `-ARIA-INVALID-ROLE` and `-DUPLICATE-ID` the *static fact* is
proven (undefined attribute, out-of-range token, duplicate id), but the concrete
WCAG violation depends on context. The related SC are therefore cited as *related
guidance* (message/docs: "related: WCAG …"), not as a proven violation; each rule's
`missingContext` spells out the distinction. WCAG 4.1.1 (Parsing), which once
covered duplicate ids, was removed in WCAG 2.2.
