# Technology Decision – Architecture Comparison & Recommendation

> Status: Concept phase. Contains a **reasoned preliminary recommendation**,
> not a final decision. Points to be clarified: see
> [open-questions.md](./open-questions.md).

## 1. Context / observed conditions

From the existing repository and the IDE configuration (`.idea/`), the
technical context of the project environment can be inferred:

- A **PHP ecosystem** with strong static analysis is already established:
  PHPStan, Psalm, PHP_CodeSniffer, PHPMD, PHP-CS-Fixer are configured.
- **Node.js / TypeScript** is also set up (JS library mapping
  "Node.js Core").
- The repository itself is still empty (only `LICENSE` MIT, `README.md`), so
  there are **no** existing code conventions that would force a choice.

Two conclusions follow:
1. The team is **familiar with static analysis** – *stoa* should **integrate**
   these tools, not replace them (non-goal N3).
2. The obvious **first target languages** are TypeScript/JavaScript and PHP.

## 2. Variants to be compared

- **Variant A – C++20 core**: native engine, own/attached parsers,
  rule engine, KB, API.
- **Variant B – TypeScript/JavaScript core**: engine in TS, established parsers
  (TypeScript Compiler API, ts-morph), tight workflow integration.
- **Variant C – Hybrid**: native analysis core (e.g. Rust/C++) + language-specific
  adapters; data exchange via a stable fact schema.

## 3. Evaluation by criteria

Scale: ++ very good · + good · ○ neutral · − weak · −− very weak.

| Criterion | A: C++20 | B: TypeScript | C: Hybrid |
|-----------|:--------:|:-------------:|:---------:|
| Runtime performance | ++ | ○ | ++ |
| Memory footprint | ++ | − | + |
| Parser availability (TS/JS) | − | ++ | + |
| Parser availability (PHP) | ○ | + (nikic via bridge) | + |
| Integration into dev workflows (CI, npm, editor) | − | ++ | + |
| Maintainability (team context) | − | ++ | ○ |
| Testability | + | ++ | ○ |
| Extensibility (new languages) | ○ | + | ++ |
| Integration effort for existing tools | ○ | ++ | + |
| Development effort to MVP | −− | ++ | − |
| Suitability for later languages (long term) | + | ○ | ++ |

### Rationale for the most important rows

- **Parser availability** is the decisive point. For TS/JS, the
  **TypeScript Compiler API** (plus `ts-morph` as an ergonomic wrapper) provides
  a full-fledged, type-enriched AST "for free". For PHP,
  `nikic/php-parser` exists as the de-facto standard; it can be used from a TS
  core via subprocess/bridge. Building or maintaining a parser of one's own in
  C++ contradicts non-goal N3.
- **Performance** clearly favors A/C, but is **not** the bottleneck for the
  MVP: analyses run per file and are easily parallelizable and cacheable.
  "Do not commit on the basis of supposed performance advantages" (requirement
  from the project brief) applies here.
- **Development effort/maintainability** strongly favor B given the team context
  (TS/PHP, no C++ visible).
- **Long-term language diversity** is the greatest strength of C: a
  language-agnostic core with adapters. However, this is a **later**
  optimization, not an MVP need.

## 4. Recommendation

> **Preliminary recommendation: Variant B (TypeScript core) for the MVP, with an
> architecture that deliberately keeps the transition to Variant C (Hybrid)
> open.**

Rationale based on the actual requirements (not on performance):

1. **Target language first = TypeScript/JavaScript.** The fastest path to a
   robust deterministic core leads through the mature TS toolchain. *stoa*
   can also analyze itself (dogfooding).
2. **PHP as the first second adapter** (high value in the given context) via
   `nikic/php-parser` as a subprocess bridge that delivers facts into the same
   schema. This validates the language independence of the fact schema early.
3. **External tools as fact sources**: `tsc`, ESLint, (later) PHPStan/Psalm
   are read in via adapters instead of being reimplemented.
4. **Exit clause toward C**: fact/rule/finding schemas are defined
   language- and runtime-neutral as JSON. If performance later becomes a
   problem (very large codebases), the fact extractor can be reimplemented
   natively per language, without touching the rule engine, KB, and reporter.

### Consequences / guardrails for the implementation

- The **core remains free of TS-AST types**: rules see only the neutral
  fact schema. This prevents Variant B from becoming a one-way street.
- **No** hard binding to an LLM provider (adapter, see
  [architecture.md](./architecture.md#d-semantic-analysis-optional)).
- The decision is **revisable**: it primarily concerns the fact extractor,
  not the analysis semantics.

## 5. Existing tools to be integrated

| Purpose | Tool | Role in *stoa* |
|-------|----------|-----------------|
| TS/JS parsing & types | TypeScript Compiler API, `ts-morph` | primary AST source (TS) |
| TS/JS lint diagnostics | ESLint (+ typed rules) | fact source, filtered (no style) |
| TS/JS type errors | `tsc --noEmit` | fact source (robustness/error handling) |
| PHP parsing | `nikic/php-parser` | AST source (PHP adapter) |
| PHP analysis | PHPStan, Psalm | fact source (later) |
| Complexity measures | own AST metrics (where appropriate oriented toward established definitions) | facts |
| CI output | SARIF | reporter target format |

> License note: integration is done via their CLIs/APIs; the respective
> licenses (MIT/BSD etc.) must be checked before bundling. No adoption of
> rule contents/texts without a license check.

## 6. Open technical points

See [open-questions.md](./open-questions.md): among others monorepo structure
(npm workspaces), subprocess vs. in-process bridge for PHP, limits of the
interprocedural analysis in TS without full program resolution.
