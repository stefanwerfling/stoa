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
  `--solid`); otherwise it is not built at all.
- Memory-bounded pipeline with `coverage.status` `complete`/`partial`/`failed`
  and exit codes 0/2/1; per-file fact cache (`--cache`); baseline/diff mode
  (`--baseline`, `--only-new`, `--update-baseline`).
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

**Not implemented:** C/C++ include/dependency facts; Dart edges in
`R-DEP-CYCLE`/`R-UNUSED-EXPORT` (Dart imports are extracted as
`dart.importSpec` and used by the ModuleGraph and the DIP layer rule, but the
two dependency rules read only TS/PHP edges); PSR-4 PHP resolution; a
git-diff/PR mode; rendered (browser) accessibility checks; API-request/DTO
facts for an end-to-end FE/BE chain; validation on independent external
corpora.

**Known limitations (open):**
- Extraction dominates runtime and memory (see the measurement entry below).
  The TS adapter no longer wraps every token, builds no type checker for
  export questions, answers the per-kind node queries from one index per
  file and walks each function once (together ≈ −74 % extraction time, see
  "Fewer token walks", "One node index per file", "One walk per function");
  parsing, releasing and wrapping all nodes once now dominate.

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
  from Flutter SDK 3.29.2 and re-checked against a local SDK by a test) — a name
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
  (`FLUTTER_FRAMEWORK_MEMBERS`, SDK 3.29.2: `State`, `StatelessWidget`,
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
  three follow-ups). Kept as it was (byte-identical): an expression body
  (`() => Math.random()`) is not inspected itself, only its children — such
  an arrow is not flagged and a top-level `&&` in it is not counted. Tests:
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
  x`, `export =`) — only then is ts-morph asked. Facts are byte-identical:
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
                    [--baseline <file>] [--update-baseline] [--only-new]
                    [--min-confidence <0..1>] [--certainty <list>]... [--no-experimental]
                    [--config <file>] [--knowledge <dir>] [--rules <dir>]
stoa eval <path> --expected <file> [--format markdown|json] [--solid] [--architecture <file>]
                    [--contracts <file>] [--knowledge <dir>] [--rules <dir>]
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
  current phase (`analysis`/`evaluation`), files processed/selected, facts
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
- `--baseline <file>` / `--update-baseline` / `--only-new` — see "Baseline /
  diff mode" below. Off by default; omitting `--baseline` leaves every
  finding exactly as before (no `baselineStatus`, no `AnalysisReport.baseline`).
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
| R-DEP-CYCLE | marcus.cooperation | dependencies | Tarjan SCC over relative imports; type-only imports skipped |
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
`validation.rawReuseAfterValidation`, `validation.dataflowGraph`, plus (opt-in) `external.tsc` and
`external.floatingPromise`.

## Quality assurance

- **node:test suite** (`npm test`, `test/*.test.ts`): 550 tests, 0 failed,
  as of the 2026-11-04 run (rules pos./neg., extraction, schema validation,
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

C/C++ include/dependency facts; Dart edges in R-DEP-CYCLE / R-UNUSED-EXPORT
(Dart imports exist as `dart.importSpec` in the ModuleGraph, but the two rules
read only TS/PHP edges); a git-diff/PR mode (the stored-snapshot baseline
exists, see "Baseline / diff mode"); a suppression workflow beyond the
baseline; PSR-4 resolution so R-DEP-CYCLE / R-UNUSED-EXPORT cover PHP; a
generic ESLint fact adapter; context facts (`flag.generatedCode`, `hasTests`)
for richer suppression; LLM-output evaluation at scale.

**Open from the evaluator-integrity track (2026-11-04):** in the TS
extraction, parsing and releasing (≈ 28 % of the profile) and wrapping every
node once for the index (≈ 12 %) — the per-family and per-function walks are
merged ("One node index per file", "One walk per function"); an expression
body is not inspected itself (see there; changing it changes facts); not building the SymbolGraph under
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
