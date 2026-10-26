# stoa – Stoic Code Analysis Engine

A deterministic static-analysis engine that maps **source-checked** principles
from Marcus Aurelius' *Meditations* onto software-quality criteria. Philosophy
provides the *interpretation frame* for findings that are always grounded in a
concrete technical observation — the core is classic static analysis, not an LLM.
An LLM is an optional, switchable adapter.

> **Status:** concept phase complete; the MVP is being built. M1 (project
> skeleton, schemas, knowledge-base data, runnable CLI) is in place. The
> deterministic rule set lands in M3. See [docs/en/roadmap.md](docs/en/roadmap.md).

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

## License

MIT © Stefan Werfling. Translation copyrights are handled separately; see
[docs/en/philosophical-foundation.md](docs/en/philosophical-foundation.md).
