# UI/UX Analysis — Final Report

> Status report for the "Stoa – UI/UX Analysis Engine" work. It describes what
> was built, how it honours the stated constraints, what it deliberately does
> **not** do, and where human/user testing remains necessary. Counts are those of
> the implementation as committed; see [implementation-status.md](./implementation-status.md)
> for the living totals.

## 1. Mandate and guiding constraint

Extend stoa to analyse user interfaces **without presenting subjective design
opinion as objective fact**. Stoa does not claim to know whether a design is
beautiful. It reports what is **technically provable** from the source, estimates
— cautiously — what could impede comprehensibility/operability, and **discloses
where human or user testing is required**. No invented, false-precision "UX
scores".

Hard constraints held throughout:

1. Deterministic analysis, runnable **without an LLM**.
2. Every finding rests on a **verifiable fact** (a concrete element + its evidence).
3. Recommendations carry **no unproven technical claims** (each rule states its drawbacks and missing context).
4. Semantic interpretation stays **separate** from the technical facts (principle references, not baked into the fact).
5. Analysed source is **never modified**.
6. Results are **reproducible and tested** (byte-stable; golden + UI corpus).

## 2. Inventory (what was reused, not reinvented)

The UI/UX work added **one** new adapter and a set of rules on top of the existing
engine — no new architecture, no new finding model:

- **Pipeline** (ingestion → fact extraction → rule engine → findings → reporters) — unchanged.
- **LanguageAdapter** contract — a new `HtmlAdapter` (tree-sitter-html, WASM, in-process) implements it exactly like the TS/PHP/Dart/C-C++ adapters.
- **Declarative rule model** (`rules/default/*.json`) — the a11y rules are ordinary rules referencing the `marcus.*` knowledge base; no code-level special-casing.
- **Finding model, reporters** (Markdown/JSON/SARIF 2.1.0), **evaluator**, **i18n** — reused as-is. Two quality dimensions (`accessibility`, `usability`) were added to the existing union/enum/labels.

## 3. What the analysis areas map to

The brief named five areas (A readability/contrast, B function comprehensibility,
C operability/accessibility, D visual hierarchy/consistency, E interaction/state).
Honest mapping of the current **static HTML** slice:

| Area | Static coverage | Notes |
|------|-----------------|-------|
| A — readability / contrast | **Partial** | Text contrast (WCAG 1.4.3) is computed deterministically from inline-declared colour pairs (`R-A11Y-CONTRAST-TEXT`); the cascade/rendered case (inheritance, stylesheets, images, translucency) still needs a visual slice. |
| B — function comprehensibility | **Partial** | Accessible names for controls/links/images/frames; label association; language of the document. "Is the name *good*?" is not judged. |
| C — operability / accessibility | **Strong** | The bulk of the 14 rules: names, labels, roles, ARIA state/attribute validity, zoom, dangling references, duplicate ids. |
| D — visual hierarchy / consistency | **None (by design)** | Heading-order/spacing/consistency depend on rendering and intent; not provable from markup without overreach. |
| E — interaction / state | **Partial** | Positive-tabindex focus-order signal; focusable-yet-aria-hidden. Full focus order/traps/dynamic state need interaction. |

## 4. Delivered rules (static HTML a11y pack, 14)

Each is a declarative rule, context-aware (emits a fact only on a genuine
violation), anchored to a WCAG 2.2 success criterion, and carries EN/DE message,
rationale, remediation **and** a `missingContext` note.

| Rule | WCAG | What it proves |
|------|------|----------------|
| R-A11Y-IMG-ALT | 1.1.1 | `<img>` with no `alt` (decorative `alt=""`/`aria-hidden`/`role=presentation` are correct) |
| R-A11Y-CONTROL-NAME | 4.1.2 | `<button>` with no accessible name |
| R-A11Y-FORM-LABEL | 1.3.1/4.1.2 | labelable field with no associated label (placeholder is not a label) |
| R-A11Y-LINK-NAME | 2.4.4/4.1.2 | `<a href>` with no accessible name |
| R-A11Y-ARIA-HIDDEN-FOCUSABLE | 4.1.2 | focusable element hidden with `aria-hidden="true"` |
| R-A11Y-ARIA-INVALID-ROLE | 4.1.2 | `role` whose tokens are no defined WAI-ARIA role |
| R-A11Y-ARIA-UNKNOWN-ATTR | 4.1.2 | `aria-*` attribute name not in WAI-ARIA 1.2 |
| R-A11Y-ARIA-INVALID-VALUE | 4.1.2 | enumerated ARIA state/property with an out-of-range value |
| R-A11Y-POSITIVE-TABINDEX | 2.4.3 | `tabindex` > 0 overriding natural focus order |
| R-A11Y-HTML-LANG | 3.1.1 | `<html>` with no `lang` |
| R-A11Y-META-VIEWPORT-ZOOM | 1.4.4 | viewport meta disabling/capping zoom |
| R-A11Y-ARIA-DANGLING-IDREF | 1.3.1/4.1.2 | `aria-labelledby`/`-describedby` pointing at an absent id |
| R-A11Y-DUPLICATE-ID | 1.3.1/4.1.2 | an `id` used more than once |
| R-A11Y-FRAME-TITLE | 4.1.2 | `<iframe>`/`<frame>` with no accessible name |

WCAG principles touched: Perceivable (1.1.1, 1.3.1, 1.4.4), Operable (2.4.3,
2.4.4), Understandable (3.1.1), Robust (4.1.2).

## 5. How the constraints are evidenced

- **Deterministic / no LLM:** the HTML adapter parses in-process (WASM); no clock/randomness/network. The semantic (LLM) layer stays optional and separate.
- **Facts, not opinion:** every rule triggers on a `ui.*` fact that names a concrete element and its start-tag evidence. "No accessible name" is computed (text / `aria-label(ledby)` / `title` / nested `img[alt]`/`svg>title`), not guessed from attribute presence.
- **Context-aware, not naive:** decorative `alt=""`, `aria-hidden`, `role=presentation`, `tabindex="-1"`, placeholder-is-not-a-label, first-valid-ARIA-token, empty/dynamic values, prefix module roles (`doc-*`/`graphics-*`) are all handled so legitimate markup is **not** flagged.
- **No false precision:** no numeric UX score anywhere. Severity/confidence are derived per the existing model; confidence is capped by fact certainty.
- **Honest limits:** each rule's `missingContext` states what it does **not** decide (e.g. runtime-injected ids, BCP 47 validity, whether a title is descriptive).

## 6. Evaluation and quality gates

- **UI/UX corpus** (`test/fixtures/html/`): positive, negative and deliberately-no-warning cases per rule. Current evaluation **precision 100% / recall 100%** on that corpus; a per-rule precision gate is enforced.
- Every rule ships **positive and negative** tests; the whole suite is green.
- The pre-existing **golden corpus** (TS + PHP) is **unchanged** (TP 44, 100%/100%) — the UI work did not perturb existing results.
- **Important honesty caveat:** these numbers describe a small, curated corpus. They are **not** a general reliability guarantee for arbitrary pages. Real pages will surface false positives/negatives the corpus does not contain.

## 7. Deliberate limitations (where human/user testing is needed)

Statically **not** reliably decidable, therefore omitted rather than guessed:

- **Cascade/rendered colour contrast** (1.4.3) — inline colour pairs are checked; inherited/stylesheet colours, images behind text and translucent colours need rendering.
- **Visible focus, focus order/traps, dynamic states** (beyond the positive-tabindex signal) — need interaction with a rendered page.
- **Target size, reflow, motion** — need layout.
- **Whether a name/label/title is *meaningful*** — a human judgement; stoa checks presence, not quality.
- **Heading hierarchy / visual consistency** — intent-dependent; would be opinion, not fact.

These are the honest boundary: stoa reports the provable and points at where a
**rendered/interactive (visual) slice** or **human review** must take over.

## 8. Suggested next steps

1. **Visual-analysis slice** (browser automation) for the cascade/rendered contrast (beyond inline pairs) and visible focus — the biggest remaining coverage gap, and genuinely out of static reach. Designed as a concept in [visual-analysis-layer.md](./visual-analysis-layer.md) (optional, environment-dependent, separated from the deterministic core); not yet built.
2. **React/JSX** — landed: the TypeScript adapter walks JSX and emits the same facts, so 11 of the 14 rules fire on `.jsx/.tsx`, including name computation (dynamic-aware) and contrast from style={{…}} object literals. The four document/cross-element rules stay HTML-only (app-shell / dynamic-id reasons). **Vue SFC** templates are also covered for the 8 attribute/contrast rules (shared template extraction with a binding dialect); **Angular** `*.component.html` too.
3. **Table semantics / heading order** only if a low-false-positive, context-aware formulation is found — otherwise leave to the visual slice.

Nothing here changes stoa's stance: it states what it can prove, estimates
cautiously, and says plainly where it cannot see.
