# stoa – Stoic Code Analysis Engine

A deterministic static-analysis engine that maps **source-checked** principles
from Marcus Aurelius' *Meditations* onto software-quality criteria. Philosophy
provides the *interpretation frame* for findings that are always grounded in a
concrete technical observation — the core is classic static analysis, not an LLM.
An LLM is an optional, switchable adapter.

> **Status:** past the MVP. The deterministic core (ingestion → facts → rule
> engine → findings → reports), a knowledge base of 6 source-checked principles,
> 38 rules across 10 quality dimensions (incl. a TypeORM/Doctrine persistence pack,
> a robustness pack and a UI/UX accessibility pack), SARIF 2.1.0 / JSON / Markdown
> output, localized output (`--lang en|de`), a golden-corpus evaluator with a
> per-language breakdown, and an optional, off-by-default, grounded semantic (LLM)
> layer are implemented. See [docs/en/roadmap.md](docs/en/roadmap.md) and, for what
> is actually built and tested, [docs/en/implementation-status.md](docs/en/implementation-status.md).
>
> **Maturity, honestly tiered:**
> - *Implemented and unit-tested:* TypeScript/JavaScript (`ts-morph`), PHP
>   (`php-parser`/glayzzle), Dart and C/C++ (tree-sitter / `web-tree-sitter`,
>   in-process WASM); the evaluator (with a per-language/category breakdown); the
>   grounded semantic layer. 38 rules, including two backend-trust-boundary checks
>   (`R-VALIDATION-MISSING-BACKEND`, `R-VALIDATION-MASS-ASSIGNMENT`) — a first,
>   deliberately single-layer slice of cross-layer validation consistency (see
>   implementation-status for scope).
> - *UI/UX accessibility, per surface (static):* **HTML** (tree-sitter-html, all 14
>   WCAG-anchored rules); **React/JSX** (ts-morph, 11 of 14); **Vue SFC** and
>   **Angular** templates (8 attribute/contrast rules via a shared binding-aware
>   extraction); **Flutter/Dart** widgets (3 widget-tree rules: Image/IconButton/
>   TextField labelling). Accessible-name, focusability and ARIA semantics are a
>   conservative static approximation, not a browser accessibility-tree replica.
> - *Contrast:* **static inline only** — computed when both text and background
>   colour are declared together on an element's inline style (WCAG 1.4.3). The
>   cascade/rendered contrast, visible focus and dynamic states are deliberately out
>   of scope for the static analyser and designed as a future, opt-in visual slice.
> - *In the golden corpus (precision/recall measured):* **TypeScript and PHP
>   only.** Dart and C/C++ are covered by adapter tests; the HTML/JSX/Vue/Angular/
>   Flutter a11y packs each have their own **curated** corpus at 100/100 — curated,
>   not external.
> - *Evaluated on independent external projects:* **not yet** — `stoa eval` works
>   on any project, but no externally-validated corpus ships here.
> - *Validation Trace IDs / cross-layer contracts:* opt-in (`--contracts <file>`),
>   TypeScript-only — 12 procedural checks comparing `// stoa:validation <ID>`-annotated
>   Zod schemas (scalar chains and field-by-field `z.object()`, including
>   `.strict()`/`.partial()`/`.extend()`/`.merge()`) against an external,
>   schema-validated contract. Cross-function dataflow to a persistence sink is
>   resolved by real ts-morph symbol identity (not name text), so shadowed/aliased/
>   reassigned variables cannot be mistaken for the validated one; `.safeParse()`
>   is only treated as a proven guard when control-flow analysis can show the
>   failure path is actually rejected (see implementation-status for exact scope
>   and the `heuristic`/`unresolved` evidence statuses this produces instead of a
>   false `verified`).
> - *Planned / not yet validated:* baseline & diff/PR mode, richer context facts,
>   PSR-4 PHP import resolution, Dart/C/C++ dependency facts.
>
> Golden- and a11y-corpus precision/recall reflect those small, curated corpora
> only; they are **not** a general reliability guarantee for arbitrary code.
>
> **Memory on large repositories:** a per-file analysis lifetime (ts-morph
> SourceFiles and tree-sitter trees are released right after their own facts
> are extracted — see implementation-status), a configurable file-size
> discovery filter (default 1 MB — generated/bundled files carry no analytical
> value and are excluded the same way a glob exclude is), and a memory guard
> that stops ingestion (and marks the report incomplete) before V8's own heap
> limit is reached, rather than crashing. Measured on a real ~300-file
> repository: peak RSS 909 MB → 451 MB, wall time 145s → 5.7s. An opt-in
> `--cache` narrows this further for repeated runs — a per-file fact cache,
> invalidated by content hash and by the running engine's own code (never by
> a rule/contract, which stay fresh on every run by construction); measured
> warm-cache run on the same repository: 0.84s / 203 MB.

## Documentation

Full specification, available in both languages:

- 🇩🇪 [docs/de/](docs/de/) — German (original)
- 🇬🇧 [docs/en/](docs/en/) — English (1:1 translation)

Start with `vision`, then `philosophical-foundation`, `architecture`,
`knowledge-model`, `rule-model`, `finding-model`, `evaluation`,
`technology-decision`, `roadmap`, `open-questions`.

For what is **actually built** (rule catalog, CLI flags, facts, deviations from
the concept), see `implementation-status` ([en](docs/en/implementation-status.md) ·
[de](docs/de/implementation-status.md)).

For the **UI/UX analysis** work (static HTML accessibility pack — scope, honest
limits, where human/user testing is needed), see `ui-ux-analysis-report`
([en](docs/en/ui-ux-analysis-report.md) · [de](docs/de/ui-ux-analysis-report.md)).
The design concept for the optional, browser-backed checks (cascade/rendered
contrast, visible focus — not yet built) is in `visual-analysis-layer`
([en](docs/en/visual-analysis-layer.md) · [de](docs/de/visual-analysis-layer.md)).

## Quick start

```bash
npm install
npm run build        # compile src/ to dist/
npm test             # unit + schema tests (node:test)
npm run lint         # eslint (synaipse flat-config style)

# analyze a path (markdown by default)
npm run analyze -- analyze ./src
node dist/Cli.js analyze ./src --format json
node dist/Cli.js analyze ./src --lang de            # localized output (en default)
node dist/Cli.js analyze ./src --typecheck          # + in-process TypeScript type checker as a fact source
node dist/Cli.js analyze . --include 'src/**/*.ts' --exclude '**/*.test.ts'  # glob file selection
node dist/Cli.js analyze ./src --format sarif   # SARIF 2.1.0 for CI / code scanning
node dist/Cli.js analyze . --memory-stats       # progress + heap/RSS to stderr every 100 files
node dist/Cli.js analyze . --cache              # cache per-file facts under .stoa/cache for faster re-runs

# evaluate the engine against the golden corpus (precision/recall)
node dist/Cli.js eval test/corpus/project --expected test/corpus/expected.json

# optional: augment findings with a grounded LLM second opinion (off by default;
# needs ANTHROPIC_API_KEY or an `ant auth login` profile). Deterministic output
# is unchanged — the LLM only adds an advisory, validated note to flagged findings.
node dist/Cli.js analyze ./src --semantic anthropic
```

## Project layout

```
docs/{de,en}/     specification (concept phase)
schemas/          JSON Schemas: fact, rule, finding, principle
knowledge/marcus/ the knowledge base (source + 6 principles, source-checked)
src/              engine: ingestion, adapters, rule engine, reporting, CLI
test/             node:test suites + fixtures
```

## Design commitments

- **Deterministic core** — same input + versions ⇒ byte-identical findings.
- **Severity and confidence are separate axes.**
- **No philosophy presented as fact** — interpretations are flagged and sourced;
  only public-domain translations (George Long) are quoted verbatim.
- **Context beats threshold** — no metric is a defect on its own.
- **Localized output** — `--lang en|de`; rule/principle text and report labels are
  translatable (`LocalizedText`, en fallback). Language is part of the run config,
  so output stays deterministic.

## License

MIT © Stefan Werfling. Translation copyrights are handled separately; see
[docs/en/philosophical-foundation.md](docs/en/philosophical-foundation.md).
