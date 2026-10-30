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
                    [--typecheck] [--dead-exports] [--contracts <file>]
                    [--semantic noop|anthropic]
                    [--config <file>] [--knowledge <dir>] [--rules <dir>]
stoa eval <path> --expected <file> [--format markdown|json] [--contracts <file>]
                    [--knowledge <dir>] [--rules <dir>]
```

- **Formats:** Markdown (human), JSON (machine), SARIF 2.1.0 (CI / code scanning).
- **Languages:** `en` (default) and `de`; rule/principle text, reporter labels and
  dimension names are localized via `LocalizedText` (en fallback).
- **File selection:** `include`/`exclude` globs (picomatch); `node_modules`/`.git`
  are hard-pruned; a single named file bypasses the globs.
- `knowledge/` and `rules/` resolve relative to the installed package — the CLI
  runs from any directory after `npm link`/install.
- `--contracts <file>` is accepted by BOTH `analyze` and `eval` (previously
  silently ignored by `eval`) — a malformed/unreadable contract fails fast
  (exit 1) for either command, never a silently-degraded result.

## Rule catalog (38)

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

- **216 node:test cases** green (rules pos./neg., extraction, schema validation,
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
