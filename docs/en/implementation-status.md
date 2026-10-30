# Implementation Status

> As of 2026-10-29. This page describes what is **actually implemented**. The
> other `docs/` documents describe the **design intent** (concept phase) and
> remain valid as rationale; where the implementation deviates, this page wins.

## Realized architecture

- **TypeScript core** (variant B), deterministic, runnable without an LLM.
- **Language adapters:** TypeScript/JavaScript (via `ts-morph` / the TS compiler
  API), **PHP** (via `php-parser`/glayzzle, fully in-process — no subprocess) and
  **Dart/Flutter** and **C/C++** (both via tree-sitter / `web-tree-sitter`,
  WASM, in-process; metric/complexity facts, error-handling for Dart and C++ —
  C has no try/catch).
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
- **Pipeline:** ingestion → fact extraction → rule engine → findings → reporter.
  No clock/randomness/network in the core; same input + versions + language ⇒
  byte-identical findings.
- **Optional, switchable layers:** type-checker facts (`--typecheck`), dead-export
  analysis (`--dead-exports`), LLM interpretation (`--semantic anthropic`).

## CLI

```
stoa analyze <path> [--format markdown|json|sarif] [--lang en|de]
                    [--include <glob>]... [--exclude <glob>]...
                    [--typecheck] [--dead-exports] [--semantic noop|anthropic]
                    [--config <file>] [--knowledge <dir>] [--rules <dir>]
stoa eval <path> --expected <file> [--format markdown|json]
```

- **Formats:** Markdown (human), JSON (machine), SARIF 2.1.0 (CI / code scanning).
- **Languages:** `en` (default) and `de`; rule/principle text, reporter labels and
  dimension names are localized via `LocalizedText` (en fallback).
- **File selection:** `include`/`exclude` globs (picomatch); `node_modules`/`.git`
  are hard-pruned; a single named file bypasses the globs.
- `knowledge/` and `rules/` resolve relative to the installed package — the CLI
  runs from any directory after `npm link`/install.

## Rule catalog (40)

Declarative rules (`rules/default/*.json`), on by default:

| Rule | Principle | Dimension | Languages |
|------|-----------|-----------|-----------|
| R-COMPLEXITY-COGNITIVE | marcus.simplicity | complexity | TS, PHP, Dart, C/C++ |
| R-DEEP-NESTING | marcus.simplicity | complexity | TS, PHP, Dart, C/C++ |
| R-FN-TOO-MANY-PARAMS | marcus.purpose | responsibility-boundaries | TS, PHP, Dart, C/C++ |
| R-WIDE-PUBLIC-SURFACE | marcus.purpose | responsibility-boundaries | TS/JS |
| R-ERR-SWALLOWED | marcus.obstacle | error-handling | TS, PHP, Dart, C++ |
| R-SIDEEFFECT-NONDETERMINISM | marcus.control | side-effect-control | TS, PHP, Dart, C/C++ |
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

Procedural rules (`ProjectRule`, cross-file):

| Rule | Principle | Dimension | Note |
|------|-----------|-----------|------|
| R-DEP-CYCLE | marcus.cooperation | dependencies | Tarjan SCC over relative imports; type-only imports skipped |
| R-UNUSED-EXPORT | marcus.cooperation | dependencies | opt-in `--dead-exports`; only sound for whole-project scans |

All ten quality dimensions (incl. accessibility, usability) have at least one rule.

## Facts produced

`file.lineCount`, `metric.exportCount`, `metric.cyclomaticComplexity`,
`metric.cognitiveComplexity`, `metric.nestingDepth`, `metric.parameterCount`,
`metric.functionLength`, `doc.hasComplexityRationale`, `ast.usesNondeterminism`,
`ast.emptyCatch`, `ast.catchSwallowsError`, `deps.import`, `deps.importUnused`,
`deps.importDeep`, `deps.export`, `deps.importName`, `orm.synchronizeEnabled`,
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
plus (opt-in) `external.tsc` and
`external.floatingPromise`.

## Quality assurance

- **163 node:test cases** green (rules pos./neg., extraction, schema validation,
  i18n, determinism, SARIF, evaluation, semantic groundedness, privacy,
  finding-model separation).
- **Golden corpus** (`test/corpus/`, **TS+PHP only**) with ground truth;
  evaluation currently **precision 100% · recall 100%** (TP 44) with a
  per-language breakdown (`byLanguage`). Per-rule precision gate (AC-5). Dart and
  C/C++ are covered by **adapter tests**, **not yet** by the golden corpus.
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
  are tested as genuinely separate concerns. Also checked manually against
  **five real TS backends** (audiomesh, headbangbear — both a `{bodySchema}`
  wrapper pattern; kapalium = Zod; helionet_pro = vts; loki = Express with no
  schema): `R-VALIDATION-MISSING-BACKEND` **0 false positives** after two
  hardening rounds (down from 29 earlier false alarms from `params` lookups,
  unrecognized wrapper schema options, and single-field plucks);
  `R-VALIDATION-MASS-ASSIGNMENT` **1 finding, verified true positive** (loki:
  `req.body` is only checked `typeof === 'object'`, then saved raw), **0 false
  positives** on the other four.
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

Further Dart/C/C++ facts (imports/deps); baseline/suppression workflow; diff/PR
mode; PSR-4 resolution so R-DEP-CYCLE / R-UNUSED-EXPORT cover PHP; a generic
ESLint fact adapter; context facts (`flag.generatedCode`, `hasTests`) for richer
suppression; LLM-output evaluation at scale.

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
