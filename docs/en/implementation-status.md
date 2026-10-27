# Implementation Status

> As of 2026-10-26. This page describes what is **actually implemented**. The
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
  (WASM, in-process). Purely static — no rendering, CSS cascade or contrast;
  those checks are deliberately **out of scope** here (see limitations). The
  first vertical slice of the UI/UX area.
- **UI/UX (React/JSX):** the TypeScript adapter additionally walks JSX elements
  (ts-morph, same parse) and emits the same `ui.*` facts, so **10 of the a11y
  rules** fire on `.jsx/.tsx` intrinsic elements — including the name-computation
  rules (control/link name, form label). Dynamic attribute values (`{expr}`) and
  dynamic children (`{label}`) are treated as present-but-unknown, a spread
  (`{...props}`) and a dynamic `id`/`type` suppress the relevant checks, and React
  components (`<Button/>`) are skipped — all to avoid false positives.
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

## Rule catalog (34)

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
| R-A11Y-IMG-ALT | marcus.purpose | accessibility | HTML, JSX (static, WCAG 1.1.1) |
| R-A11Y-CONTROL-NAME | marcus.purpose | accessibility, usability | HTML, JSX (static, WCAG 4.1.2) |
| R-A11Y-FORM-LABEL | marcus.purpose | accessibility, usability | HTML, JSX (static, WCAG 1.3.1/4.1.2) |
| R-A11Y-LINK-NAME | marcus.purpose | accessibility, usability | HTML, JSX (static, WCAG 2.4.4/4.1.2) |
| R-A11Y-ARIA-HIDDEN-FOCUSABLE | marcus.cooperation | accessibility, usability | HTML, JSX (static, WCAG 4.1.2) |
| R-A11Y-ARIA-INVALID-ROLE | marcus.purpose | accessibility | HTML, JSX (static, WCAG 4.1.2) |
| R-A11Y-ARIA-UNKNOWN-ATTR | marcus.purpose | accessibility | HTML, JSX (static, WCAG 4.1.2) |
| R-A11Y-ARIA-INVALID-VALUE | marcus.purpose | accessibility | HTML, JSX (static, WCAG 4.1.2) |
| R-A11Y-POSITIVE-TABINDEX | marcus.cooperation | accessibility, usability | HTML, JSX (static, WCAG 2.4.3) |
| R-A11Y-HTML-LANG | marcus.purpose | accessibility | HTML (static, WCAG 3.1.1) |
| R-A11Y-META-VIEWPORT-ZOOM | marcus.cooperation | accessibility, usability | HTML (static, WCAG 1.4.4) |
| R-A11Y-ARIA-DANGLING-IDREF | marcus.purpose | accessibility | HTML (static, WCAG 1.3.1/4.1.2) |
| R-A11Y-DUPLICATE-ID | marcus.purpose | accessibility | HTML (static, WCAG 1.3.1/4.1.2) |
| R-A11Y-FRAME-TITLE | marcus.purpose | accessibility, usability | HTML, JSX (static, WCAG 4.1.2) |

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
`ui.danglingAriaIdref`, `ui.duplicateId`, `ui.frameMissingTitle`, plus (opt-in)
`external.tsc` and `external.floatingPromise`.

## Quality assurance

- **132 node:test cases** green (rules pos./neg., extraction, schema validation,
  i18n, determinism, SARIF, evaluation, semantic groundedness, privacy,
  finding-model separation).
- **Golden corpus** (`test/corpus/`, **TS+PHP only**) with ground truth;
  evaluation currently **precision 100% · recall 100%** (TP 44) with a
  per-language breakdown (`byLanguage`). Per-rule precision gate (AC-5). Dart and
  C/C++ are covered by **adapter tests**, **not yet** by the golden corpus.
- **Important:** these numbers hold only for the small, curated corpus and are
  **not** a general reliability guarantee for arbitrary projects.
- **UI/UX corpus** (`test/fixtures/html/`, static HTML) with positive, negative
  and deliberately-no-warning cases; evaluation 100%/100% (TP 34) per rule. The
  semantic (LLM) assessment is kept separate and is not required here.
- **JSX corpus** (`test/fixtures/jsx/`): the ten ported a11y rules evaluated on
  React/JSX intrinsics; 100%/100% (TP 12), with positive, dynamic-value/children,
  spread, wrapping-label, htmlFor, component and clean cases.
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

**UI/UX — limits and planned:** static analysis only. **Not** reliably decidable
statically, and therefore deliberately omitted: colour contrast (WCAG 1.4.3),
visible focus, focus order/traps (beyond the static positive-tabindex signal),
target size, dynamic states — these need a rendered page/interaction (a planned
visual-analysis slice with browser automation). **React/JSX** is covered for 10
of the 14 rules (via the TS adapter's JSX walk), including the name-computation
rules (control/link name, form label) with dynamic-aware name resolution. The
four document/cross-element rules (`-HTML-LANG`, `-META-VIEWPORT-ZOOM`,
`-ARIA-DANGLING-IDREF`, `-DUPLICATE-ID`) are **not** ported to JSX: `<html lang>`
and `<meta viewport>` live in the app shell (e.g. a Next.js `_document`/`Head`,
not component JSX), and id/idref resolution across components with dynamic ids is
not statically sound. Next static steps: further ARIA checks (e.g. `aria-*`
attributes invalid for the element's role); further platforms (Vue, Angular)
behind their own adapters.
(Implemented: `R-A11Y-FORM-LABEL`,
`R-A11Y-LINK-NAME`, `R-A11Y-ARIA-HIDDEN-FOCUSABLE`, `R-A11Y-ARIA-INVALID-ROLE`,
`R-A11Y-ARIA-UNKNOWN-ATTR`, `R-A11Y-ARIA-INVALID-VALUE`,
`R-A11Y-POSITIVE-TABINDEX`, `R-A11Y-HTML-LANG`, `R-A11Y-META-VIEWPORT-ZOOM`,
`R-A11Y-ARIA-DANGLING-IDREF`, `R-A11Y-DUPLICATE-ID`, `R-A11Y-FRAME-TITLE`.)
