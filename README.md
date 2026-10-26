# stoa – Stoic Code Analysis Engine

A deterministic static-analysis engine that maps **source-checked** principles
from Marcus Aurelius' *Meditations* onto software-quality criteria. Philosophy
provides the *interpretation frame* for findings that are always grounded in a
concrete technical observation — the core is classic static analysis, not an LLM.
An LLM is an optional, switchable adapter.

> **Status:** concept phase complete; MVP in progress. Done: M1 (skeleton,
> schemas, knowledge base, CLI), M2 (real ts-morph fact extraction), M3 (the
> deterministic rule engine with its first rules), M5 (golden corpus +
> precision/recall evaluation), M6 (PHP adapter — same rules, same facts, proving
> the schema is language-neutral), a cross-file dependency-cycle rule
> (R-DEP-CYCLE), SARIF 2.1.0 output for CI / code scanning, and the optional
> semantic (LLM) layer — off by default, vendor-neutral, grounded and validated,
> and never part of the deterministic core. Next is hardening (richer context
> facts, PSR-4 PHP import resolution), plus a robustness pack — non-determinism
> (clock/RNG), unused imports, and an opt-in in-process TypeScript type-check
> fact source — that fills the side-effect-control and decision-evidence
> dimensions. See [docs/en/roadmap.md](docs/en/roadmap.md).

## Documentation

Full specification (ten documents), available in both languages:

- 🇩🇪 [docs/de/](docs/de/) — German (original)
- 🇬🇧 [docs/en/](docs/en/) — English (1:1 translation)

Start with `vision`, then `philosophical-foundation`, `architecture`,
`knowledge-model`, `rule-model`, `finding-model`, `evaluation`,
`technology-decision`, `roadmap`, `open-questions`.

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
node dist/Cli.js analyze ./src --format sarif   # SARIF 2.1.0 for CI / code scanning

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
