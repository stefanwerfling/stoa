# Implementation Status

> As of 2026-10-31. This page describes what is **actually implemented**. The
> other `docs/` documents describe the **design intent** (concept phase) and
> remain valid as rationale; where the implementation deviates, this page wins.

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
- **Pipeline:** ingestion → fact extraction → rule engine → findings → reporter.
  No clock/randomness/network in the core; same input + versions + language ⇒
  byte-identical findings.
- **Optional, switchable layers:** type-checker facts (`--typecheck`), dead-export
  analysis (`--dead-exports`), LLM interpretation (`--semantic anthropic`).

## CLI

```
stoa analyze <path> [--format markdown|json|sarif] [--lang en|de]
                    [--include <glob>]... [--exclude <glob>]...
                    [--typecheck] [--dead-exports] [--contracts <file>]
                    [--semantic noop|anthropic] [--memory-stats] [--cache]
                    [--baseline <file>] [--update-baseline] [--only-new]
                    [--config <file>] [--knowledge <dir>] [--rules <dir>]
stoa eval <path> --expected <file> [--format markdown|json] [--contracts <file>]
                    [--knowledge <dir>] [--rules <dir>]
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
- `--memory-stats` prints one progress line to stderr every 100 files
  (`files processed/selected | heap used/limit | rss`) plus a final totals
  line; stdout (the report itself) is unaffected. Off by default — the
  defaults below need no tuning for a typical run.
- `--cache` stores/reuses per-file facts under `<root>/.stoa/cache` across
  runs (see "Per-file fact cache" below) — off by default; omitting it is
  byte-for-byte the previous behavior.
- `--baseline <file>` / `--update-baseline` / `--only-new` — see "Baseline /
  diff mode" below. Off by default; omitting `--baseline` leaves every
  finding exactly as before (no `baselineStatus`, no `AnalysisReport.baseline`).

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
  produced are kept (nothing is discarded), and
  `coverage.analysisIncomplete`/`coverage.stoppedAtFile` mark the report as
  genuinely partial — a truncated run is never presented as a complete one.
  No `global.gc()` call anywhere — this guard is a last resort on top of the
  bounded object lifetimes above, not a substitute for them.
- **Deliberately not done, and why:** no new concurrency/backpressure
  mechanism — the file-processing loop was already fully synchronous with no
  parallelism to bound in the first place, so Section 7 of the originating
  spec's premise did not apply; adding concurrency now would be unneeded
  complexity, not a fix for an observed problem. No `.gitignore` parsing — the
  extended default-exclude list already covers the dominant real-world memory
  risk (build output, caches, vendor directories) without it, and correct
  multi-level `.gitignore` semantics (nested files, negation patterns) is its
  own scoped feature. (Incremental/cached analysis WAS later added narrowly —
  see "Per-file fact cache" below — once a cache boundary that could be
  reliably invalidated was identified.)
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
  degrades to recomputing that one file, by design.
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

Procedural rules (`ProjectRule`, cross-file):

| Rule | Principle | Dimension | Note |
|------|-----------|-----------|------|
| R-DEP-CYCLE | marcus.cooperation | dependencies | Tarjan SCC over relative imports; type-only imports skipped |
| R-UNUSED-EXPORT | marcus.cooperation | dependencies | opt-in `--dead-exports`; only sound for whole-project scans |
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
`SymbolResolution.ts`, matching here is necessarily by identifier TEXT within
one function body (never across functions, never across files). Within that
constraint, both rules are deliberately conservative: a false negative is
preferred over a false positive (the same standing bias as the rest of this
engine), confirmed by dogfooding against eleven real external C/C++
repositories (not synthetic fixtures only) before shipping.

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
`validation.contractAnnotation`, `validation.annotatedValidatorUnused`,
`validation.rawReuseAfterValidation`, `validation.dataflowGraph`, plus (opt-in) `external.tsc` and
`external.floatingPromise`.

## Quality assurance

- **249 node:test cases** green (rules pos./neg., extraction, schema validation,
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
