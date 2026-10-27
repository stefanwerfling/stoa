# Rule Model – Definition & Execution of the Rule Engine

> Status: Concept phase. Defines how rules are structured, how they
> are executed deterministically and how they are coupled to principles.
> Data basis: Facts from [architecture.md](./architecture.md#a-source-analysis).

## 1. Principles

- **Rules check technically, not philosophically.** A rule evaluates facts.
  The philosophical interpretation is added via the referenced principles
  (separation from [knowledge-model.md](./knowledge-model.md)).
- **Determinism.** Same facts + same rule version + same config ⇒
  identical findings. No clock, no randomness, no network dependency.
- **Facts instead of AST.** Rules only see the neutral fact schema, never the
  raw language-specific AST → language independence, easy testability. Adapters
  for TS/JS (ts-morph), PHP (glayzzle) plus Dart/Flutter and C/C++
  (tree-sitter/WASM) emit the same facts, so the metric and error-handling rules
  apply across languages unchanged.
- **Context beats threshold.** A rule must never evaluate a metric on its own as a
  deficiency; it must take context/exception signals into account (guiding principle L4).
- **No style as deficiency.** Rules that merely reflect subjective style preference
  are impermissible (non-goal N4).

## 2. Fact Schema (Input of the Rules)

Facts are normalized, language-neutral observations. Minimal form:

```jsonc
{
  "id": "fact:...",
  "kind": "metric.cognitiveComplexity", // stable fact kind
  "subject": {                           // what the fact refers to
    "file": "src/user.ts",
    "symbol": "formatAddress",
    "kindOf": "function",
    "range": { "startLine": 10, "startCol": 1, "endLine": 48, "endCol": 2 }
  },
  "value": 25,                           // depending on kind: number | bool | string | struct
  "evidence": [                          // derived from
    { "source": "ast", "detail": "nesting depth 5" }
  ],
  "certainty": "syntactic",              // syntactic | semantic-heuristic | external-tool
  "producedBy": { "adapter": "typescript", "version": "0.1.0" }
}
```

`certainty` is decisive: it limits the maximum finding confidence
(a purely heuristic fact cannot trigger a high-confidence rule).

## 3. Rule Definition

A rule must, per the mandate, specify: *which feature*, *which condition*,
*which principles*, *which evidence*, *when no finding*, *which severity/
certainty*. Model:

```jsonc
{
  "id": "R-COMPLEXITY-COGNITIVE",
  "version": "1.0.0",
  "title": "Excessive cognitive complexity",
  "feature": "metric.cognitiveComplexity",   // examined feature (fact kind)
  "appliesTo": ["function", "method"],
  "principles": ["marcus.simplicity"],         // principle references (KB)
  "dimensions": ["complexity", "understandability"],

  "trigger": {                                 // when a finding is triggered
    "all": [
      { "fact": "metric.cognitiveComplexity", "op": ">=", "value": 15 }
    ]
  },

  "requiredEvidence": [                         // without these facts, no finding
    "metric.cognitiveComplexity", "metric.nestingDepth"
  ],

  "suppressWhen": {                             // when NO finding is justified
    "any": [
      { "fact": "flag.generatedCode", "op": "==", "value": true },
      { "fact": "flag.hasTests", "op": "==", "value": true,
        "and": [{ "fact": "metric.cognitiveComplexity", "op": "<", "value": 30 }] },
      { "fact": "shape.isFlatSwitch", "op": "==", "value": true }
    ]
  },

  "severity": {                                 // derived, not fixed
    "base": "medium",
    "escalateWhen": [
      { "fact": "metric.cognitiveComplexity", "op": ">=", "value": 30, "to": "high" },
      { "fact": "metric.churn", "op": ">=", "value": 10, "to": "high" }
    ]
  },

  "confidence": {
    "base": 0.7,
    "capBy": "certainty",                       // syntactic→1.0, heuristic→0.6, external→0.9
    "reduceWhen": [
      { "fact": "doc.hasComplexityRationale", "op": "==", "value": true, "by": 0.3 }
    ]
  },

  "message": "Cognitive complexity {value} in {symbol} impedes understanding.",
  "remediationRef": "fix:reduce-cognitive-complexity",
  "tests": "tests/rules/R-COMPLEXITY-COGNITIVE/"   // mandatory: test catalog
}
```

### Field Meaning (Brief)
| Field | Purpose |
|------|-------|
| `feature` / `requiredEvidence` | which feature; without the named facts **no** run (avoids guessing) |
| `trigger` | conditions that produce a candidate |
| `suppressWhen` | explicit non-finding conditions (context!) |
| `severity` / `confidence` | derived **separately**; confidence capped by `certainty` |
| `principles` / `dimensions` | coupling to KB & evaluation model |
| `tests` | mandatory test catalog per rule |

## 4. Execution Model

```mermaid
flowchart TB
    FS[(Fact Store)] --> SEL[1. Rule selection\nby feature/requiredEvidence]
    SEL --> TRG[2. check trigger]
    TRG -->|no match| DROP[discard]
    TRG -->|match| SUP[3. check suppressWhen]
    SUP -->|suppressed| DROP
    SUP -->|remains| SEV[4. derive severity]
    SEV --> CONF[5. derive confidence\n+ cap by certainty]
    CONF --> EMIT[6. create finding\n+ attach principle interpretation]
    EMIT --> DEDUP[7. de-duplication\nper location/problem]
```

**Properties:**
- **Order-independent**: rules only read the fact store; no
  order dependency between rules (pure function `facts → findings`).
- **Stable sorting** of the findings (file, line, rule ID) for byte-stable
  output.
- **No rule may produce facts** – only read (layer rule).

## 5. Rule Set `default@1` (implemented)

> The actually-implemented rule set (34 rules). Overview, facts and opt-in flags:
> [implementation-status.md](./implementation-status.md).

Declarative rules (`rules/default/*.json`, on by default):

| Rule ID | Feature (Fact) | Principle | Dimension | Character |
|---------|----------------|-----------|-----------|-----------|
| `R-COMPLEXITY-COGNITIVE` | `metric.cognitiveComplexity` (+ `nestingDepth`) | `marcus.simplicity` | Complexity | syntactic |
| `R-DEEP-NESTING` | `metric.nestingDepth` | `marcus.simplicity` | Complexity | syntactic |
| `R-FN-TOO-MANY-PARAMS` | `metric.parameterCount` | `marcus.purpose` | Responsibility boundaries | syntactic |
| `R-WIDE-PUBLIC-SURFACE` | `metric.exportCount` | `marcus.purpose` | Responsibility boundaries | syntactic (TS/JS only) |
| `R-ERR-SWALLOWED` | `ast.catchSwallowsError` | `marcus.obstacle` | Error handling | syntactic |
| `R-SIDEEFFECT-NONDETERMINISM` | `ast.usesNondeterminism` | `marcus.control` | Side-effect control | heuristic |
| `R-DEP-UNUSED` | `deps.importUnused` | `marcus.cooperation` | Dependencies | syntactic |
| `R-DEEP-IMPORT` | `deps.importDeep` | `marcus.cooperation` | Dependencies | syntactic |
| `R-TYPE-UNSOUND` | `external.tsc` | `marcus.judgment` | Decision-evidence, robustness | external-tool, opt-in `--typecheck` |
| `R-FLOATING-PROMISE` | `external.floatingPromise` | `marcus.obstacle` | Error handling, robustness | external-tool, opt-in `--typecheck` |

Persistence / ORM (TypeORM, TS/JS only, on by default):

| Rule ID | Feature (Fact) | Principle | Dimension | Character |
|---------|----------------|-----------|-----------|-----------|
| `R-ORM-SYNCHRONIZE-ENABLED` | `orm.synchronizeEnabled` | `marcus.control` | Side-effect control, robustness | heuristic |
| `R-ORM-SYNC-WITH-MIGRATIONS` | `orm.syncWithMigrations` | `marcus.judgment` | Decision-evidence, robustness | heuristic |
| `R-ORM-ENTITY-NO-PK` | `orm.entityNoPrimaryKey` | `marcus.judgment` | Robustness, decision-evidence | syntactic (`@Entity` / `#[ORM\Entity]`) |
| `R-ORM-EAGER-RELATION` | `orm.eagerRelation` | `marcus.control` | Side-effect control, robustness | syntactic (TypeORM + Doctrine) |
| `R-ORM-NULLABLE-NO-DEFAULT` | `migration.nullableNoDefault` | `marcus.obstacle` | Robustness, error handling | heuristic (NOT NULL add in `up()`) |
| `R-MIGRATION-UNGUARDED-DDL` | `migration.unguardedDdl` | `marcus.obstacle` | Robustness, error handling | heuristic (migration files only) |
| `R-MIGRATION-NO-DOWN` | `migration.noDown` | `marcus.judgment` | Robustness, decision-evidence | syntactic (migration files only) |
| `R-MIGRATION-DATA-LOSS` | `migration.dataLoss` | `marcus.judgment` | Robustness, decision-evidence | heuristic (drops in `up()`) |

UI/UX – accessibility (HTML, static, on by default):

| Rule ID | Feature (Fact) | Principle | Dimension | Character |
|---------|----------------|-----------|-----------|-----------|
| `R-A11Y-IMG-ALT` | `ui.imageMissingAlt` | `marcus.purpose` | Accessibility | syntactic (WCAG 1.1.1) |
| `R-A11Y-CONTROL-NAME` | `ui.controlMissingName` | `marcus.purpose` | Accessibility, usability | syntactic (WCAG 4.1.2) |
| `R-A11Y-FORM-LABEL` | `ui.controlMissingLabel` | `marcus.purpose` | Accessibility, usability | syntactic (WCAG 1.3.1/4.1.2) |
| `R-A11Y-LINK-NAME` | `ui.linkMissingName` | `marcus.purpose` | Accessibility, usability | syntactic (WCAG 2.4.4/4.1.2) |
| `R-A11Y-ARIA-HIDDEN-FOCUSABLE` | `ui.ariaHiddenFocusable` | `marcus.cooperation` | Accessibility, usability | syntactic (WCAG 4.1.2) |
| `R-A11Y-ARIA-INVALID-ROLE` | `ui.invalidRole` | `marcus.purpose` | Accessibility | syntactic (WCAG 4.1.2) |
| `R-A11Y-ARIA-UNKNOWN-ATTR` | `ui.unknownAriaAttribute` | `marcus.purpose` | Accessibility | syntactic (WCAG 4.1.2) |
| `R-A11Y-ARIA-INVALID-VALUE` | `ui.invalidAriaValue` | `marcus.purpose` | Accessibility | syntactic (WCAG 4.1.2) |
| `R-A11Y-POSITIVE-TABINDEX` | `ui.positiveTabindex` | `marcus.cooperation` | Accessibility, usability | syntactic (WCAG 2.4.3) |
| `R-A11Y-HTML-LANG` | `ui.documentMissingLang` | `marcus.purpose` | Accessibility | syntactic (WCAG 3.1.1) |
| `R-A11Y-META-VIEWPORT-ZOOM` | `ui.viewportBlocksZoom` | `marcus.cooperation` | Accessibility, usability | syntactic (WCAG 1.4.4) |
| `R-A11Y-ARIA-DANGLING-IDREF` | `ui.danglingAriaIdref` | `marcus.purpose` | Accessibility | syntactic (WCAG 1.3.1/4.1.2) |
| `R-A11Y-DUPLICATE-ID` | `ui.duplicateId` | `marcus.purpose` | Accessibility | syntactic (WCAG 1.3.1/4.1.2) |
| `R-A11Y-FRAME-TITLE` | `ui.frameMissingTitle` | `marcus.purpose` | Accessibility, usability | syntactic (WCAG 4.1.2) |

> **UI/UX (HTML):** static analysis via tree-sitter-html.
> `R-A11Y-IMG-ALT` reports `<img>` with no `alt` (decorative `alt=""`,
> `aria-hidden`, `role=presentation` count as correct). `R-A11Y-CONTROL-NAME`
> reports a `<button>` with no accessible name (text, `aria-label(ledby)`,
> `title`, or a named child `img[alt]`/`svg>title`). `R-A11Y-FORM-LABEL` reports
> labelable fields (`input`/`select`/`textarea`) with no associated label
> (`<label for>` by id, a wrapping `<label>`, `aria-label(ledby)`/`title`); a
> placeholder does **not** count; `hidden`/`submit`/`button`/`reset`/`image` are
> not labelable and are excluded. `R-A11Y-LINK-NAME` reports an `<a href>` with
> no accessible name (same name sources as the button); an `<a>` with no `href`
> is not a link and is skipped. `R-A11Y-ARIA-HIDDEN-FOCUSABLE` reports an element
> that is itself focusable yet `aria-hidden="true"` (`tabindex="-1"` removes it
> from the tab order → correctly hidden, not flagged; only the element itself,
> not aria-hidden containers). `R-A11Y-ARIA-INVALID-ROLE` reports an element
> whose `role` has tokens but none is a defined WAI-ARIA role — a typo
> (`role="buton"`) or an author-forbidden abstract role (`role="widget"`); the
> first valid token wins (ARIA fallback), `doc-*`/`graphics-*` module roles are
> accepted by prefix and an empty `role` is a no-op. `R-A11Y-ARIA-UNKNOWN-ATTR`
> reports an `aria-*` attribute whose name is not a defined WAI-ARIA 1.2 state or
> property — a typo (`aria-labeledby`) or an invented name; valid attributes and
> non-`aria-*` names (`data-aria-*`, `class`) are left alone, and only the name is
> checked (not whether it is allowed on the role or carries a valid value).
> `R-A11Y-ARIA-INVALID-VALUE` reports a token-enumerated ARIA state/property whose
> value is outside its defined token set (`aria-hidden="yes"`, `aria-live="rude"`);
> free-form value types (IDREF/string/number) are not checked, and empty values
> (default fallback) and values with interpolation markers (`{ } < $`, likely
> template output) are skipped to avoid false positives. `R-A11Y-POSITIVE-TABINDEX`
> reports a clean positive-integer `tabindex` (> 0), which forces the element ahead
> of the natural DOM focus order; `tabindex="0"`/negative, non-integer and dynamic
> values are left alone (WCAG 2.4.3). `R-A11Y-HTML-LANG` reports an `<html>`
> element with no (or empty) `lang`/`xml:lang` so assistive tech cannot choose the
> pronunciation; fragments without an `<html>` element are not flagged and the tag
> value is not validated against BCP 47 (WCAG 3.1.1). `R-A11Y-META-VIEWPORT-ZOOM`
> reports a `<meta name="viewport">` whose `content` disables zoom
> (`user-scalable=no`) or caps it below 200% (a clean numeric `maximum-scale` < 2);
> non-numeric/dynamic scale values and other metas are left alone (WCAG 1.4.4).
> `R-A11Y-ARIA-DANGLING-IDREF` reports an `aria-labelledby`/`aria-describedby`
> token that names an id absent from the same document, so the intended name or
> description silently resolves to nothing; resolvable references, `aria-controls`
> and runtime-injected ids are out of scope (WCAG 1.3.1/4.1.2).
> `R-A11Y-DUPLICATE-ID` reports every element whose `id` occurs more than once in
> the document — an id must be unique, and a duplicate makes a label-for / aria
> reference resolve to whichever element the user agent picks first; unique ids and
> ids across separately-included documents are out of scope.
> `R-A11Y-FRAME-TITLE` reports an `<iframe>`/`<frame>` with no accessible name of
> its own (a non-empty `title`, `aria-label` or `aria-labelledby`); a frame marked
> `aria-hidden` is exempt (WCAG 4.1.2).
> The category (accessibility) maps to the
> `accessibility` dimension. Contrast, visible focus and rendered states are
> **not** statically decidable and are deliberately omitted.

> `R-MIGRATION-UNGUARDED-DDL` fires only in migration files (a class that
> `implements MigrationInterface`) and covers two paths: raw SQL
> (`CREATE/DROP TABLE`, `ADD/DROP COLUMN` without `IF [NOT] EXISTS`) and the
> query-builder API (`createTable`/`dropTable` without `ifNotExist`/`ifExist`,
> `addColumn`/`dropColumn` without a surrounding `hasColumn()` check).
> Deliberately conservative (confidence 0.7): `IF [NOT] EXISTS` is a safety net,
> not a substitute for a clean baseline, and the true DB state is only known at
> run time (→ a CI migration dry-run against a fresh DB).

> `R-MIGRATION-NO-DOWN` reports a migration class with no `down()` or an empty
> `down()` (not reversible). A deliberately throwing `down()` (an explicitly
> one-way migration) counts as a documented decision and is not flagged.

> `R-MIGRATION-DATA-LOSS` reports destructive steps in `up()` (`DROP TABLE`/
> `DROP COLUMN` or `dropTable`/`dropColumn`) — regardless of an `IF EXISTS`
> guard, because the guard prevents the crash, not the data loss. Scoped to
> `up()` so expected drops in `down()` (reversing a create) are not flagged; it
> complements `R-MIGRATION-UNGUARDED-DDL` (existence guard) with the data-loss
> perspective.

> `R-ORM-NULLABLE-NO-DEFAULT` reports a `NOT NULL` column added in `up()` with no
> `DEFAULT` (raw SQL `ADD COLUMN … NOT NULL`, or `addColumn` with an explicit
> `isNullable: false` and no `default`) — it breaks against a populated table.
> Auto-increment/generated columns and an absent explicit `isNullable` are left
> out (conservative).

> **Doctrine (PHP):** the four migration rules (`R-MIGRATION-UNGUARDED-DDL`,
> `R-MIGRATION-DATA-LOSS`, `R-MIGRATION-NO-DOWN`, `R-ORM-NULLABLE-NO-DEFAULT`)
> also fire for Doctrine migrations (`extends AbstractMigration`). The raw SQL is
> read from `$this->addSql('…')`; the SQL checks are language-neutral (shared
> `MigrationSql` module). The **DBAL Schema API** is covered too
> (`$schema->dropTable()`/`$table->dropColumn()` in `up()` → data-loss;
> `$table->addColumn(…, ['notnull' => true])` with no `default` → nullable);
> it has no `IF [NOT] EXISTS` concept, so the unguarded rule applies to raw SQL
> only. `R-ORM-ENTITY-NO-PK` (`@Entity` without `@Id`) and
> `R-ORM-EAGER-RELATION` (a relation with `fetch EAGER`) also fire — via both
> **PHP 8 attributes** (`#[ORM\Entity]`, `#[ORM\ManyToOne(fetch: 'EAGER')]`) and
> **annotation docblocks** (`@ORM\Entity`, the older style; `fetch="EAGER"`). The
> TypeORM query-builder path remains TS-side by nature.

Procedural rules (`ProjectRule`, cross-file):

| Rule ID | Basis | Principle | Dimension | Character |
|---------|-------|-----------|-----------|-----------|
| `R-DEP-CYCLE` | module graph from `deps.import` (Tarjan SCC) | `marcus.cooperation` | Dependencies | syntactic |
| `R-UNUSED-EXPORT` | `deps.export` × `deps.importName` | `marcus.cooperation` | Dependencies | heuristic, opt-in `--dead-exports` |

> **Not yet implemented** (documented as ideas): `R-RESP-MIXED-CONCERNS`
> (layer/namespace mixing, `marcus.purpose`) and `R-ARCH-LAYER-VIOLATION`
> (import against a declared layer rule, `marcus.judgment`).

> Pure style rules (indentation, quotation marks, name length) are
> **excluded**. Such checks remain with ESLint/CS-Fixer.

## 6. Versioning & Determinism Guarantees

- **Rule version (semver)** per rule; **rule set version** (`default@1`) bundles
  rules + thresholds. Reports stamp both (reproducibility).
- Thresholds (`value` limits) are **part of the rule version** – a
  threshold change is a version change, not a silent config drift.
- **Config overrides** are allowed, but are disclosed in the report (so that
  "why does my result differ?" remains answerable).

## 7. Testability (Mandatory per Rule)

Every rule has a test catalog with at least:
- **≥ 1 positive fixture** (correctly triggers a finding),
- **≥ 1 negative fixture** (correctly triggers *no* finding — checks
  `suppressWhen`/counterexamples),
- **Snapshot** of the produced finding (fields, severity, confidence).

See [evaluation.md](./evaluation.md#3-tests-und-referenzkorpus).

## 8. Limits of the Rule Model

- Rules are only as good as the facts. Missing interprocedural data flows
  limit, for example, `R-SIDEEFFECT-IN-PURE`.
- Context rules (`suppressWhen`) need reliable context facts
  (tests present? generated? documented?) — their quality must itself be tested.
- Semantic judgments ("is the abstraction really superfluous?") do **not** belong in
  deterministic rules, but in the optional LLM layer (as a separately
  marked, evidence-required addition).
