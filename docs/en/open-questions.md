# Open Questions, Risks & Assumptions

> Status: Concept phase. Collects unresolved decisions (with preliminary
> recommendation), risks, and explicit assumptions.
>
> **Decisions marked ✅ are now implemented** — the concrete current state is in
> [implementation-status.md](./implementation-status.md).

## 1. Open Decisions (with preliminary recommendation)

| ID | Question | Options | Preliminary recommendation |
|----|----------|---------|----------------------------|
| OQ-1 | **First target language** | TS/JS · PHP | **✅ Implemented:** TS/JS first; PHP built as the second adapter (M6). |
| OQ-2 | **Core runtime** | TS (Var. B) · Hybrid (Var. C) | **✅ Implemented:** TS core, schema-neutral (exit to Hybrid still open; see [technology-decision.md](./technology-decision.md)). |
| OQ-3 | **PHP parser** | Subprocess (`nikic/php-parser`) · pure-JS parser (`php-parser`/glayzzle) · own parser | **Decided (M6): `php-parser`/glayzzle** — in-process, no PHP/Composer, deterministically testable. Fact schema identical, so revisable. |
| OQ-4 | **Interprocedural data flow** | local only · project-wide | **✅ Implemented (local):** metrics/facts per function are local. Project-wide data flow remains a later stage. |
| OQ-5 | **Default single score** | on · off | **✅ Decided:** no default single score; findings carry dimensions. An aggregated dimension profile is not built yet. |
| OQ-6 | **Cohesion metric** | LCOM variant · own heuristic | open; calibrate with experts/empirical data on the corpus (risk of false positives). |
| OQ-7 | **Principle naming** | `marcus.*` · `stoic.*` | **✅ Implemented:** `marcus.*`. Rename to `stoic.*` only once Epictetus is added as a source (open). |
| OQ-8 | **LLM default** | local · external · off | **Off** (implemented): no-op default; optional Anthropic adapter (Opus 4.8), vendor-neutral, groundedness-validated, outside the deterministic core. |
| OQ-9 | **License of the engine** | — | **✅ Decided:** MIT. Translation licenses handled separately (only public-domain texts verbatim). |
| OQ-10 | **Documentation language** | DE · EN | **✅ Implemented:** docs in `docs/de` **and** `docs/en` (1:1); plus localized output (`--lang en|de`). |
| OQ-11 | **Project name** | “stoa” · other | provisionally “stoa”; check the final name + trademark/naming conflicts. |

## 2. Risks

| ID | Risk | Impact | Mitigation |
|----|------|--------|------------|
| R-1 | **Philosophy as decoration** – analogies feel contrived, no real added value. | Project loses its reason for existence. | Every mapping justified + marked; principles without a viable hypothesis discarded ([foundation §5](./philosophical-foundation.md#5-what-cannot-be-meaningfully-translated)). |
| R-2 | **False positives** in heuristic rules (complexity/cohesion/side effects). | Users lose trust. | Precision gate, “experimental” status, context suppression, separate confidence. |
| R-3 | **Sourcing errors** (wrong attribution/citation). | Credibility. | Evidence register + verification status + expert review; modern © translations (Hays) not verbatim. |
| R-4 | **False precision** of a score. | Perverse incentives (Goodhart). | No default single score; profile + uncertainty band. |
| R-5 | **Language independence** of the fact schema only verified for real late. | Costly rework. | PHP adapter early after the MVP (M6) as a test; deliberately keep the schema neutral. |
| R-6 | **LLM fabricates facts**. | Wrong findings. | Groundedness requirement, marked provenance, can be switched off, own eval rubric. |
| R-7 | **Duplication** of ESLint/PHPStan without added value. | Redundancy. | Integrate tools as a fact source instead of rebuilding; comparison in the eval. |
| R-8 | **Determinism leaks** (clock/randomness/path order). | Not reproducible. | Reproducibility test in CI; time/environment only in metadata. |
| R-9 | **Lack of context** for “responsibility/necessity”. | Misjudgments. | Low confidence, delegation to semantics, explicit `missingContext`. |

## 3. Assumptions (to be confirmed)

- **A-1** Target environment is TS/JS **and** PHP (derived from `.idea/` configuration;
  not confirmed by the user).
- **A-2** Primary interface is a CLI (not IDE plugin/server) for the MVP.
- **A-3** Users accept external tools as a dependency (`tsc` present).
- **A-4** There will, in perspective, be access to a knowledgeable person for the
  philosophical expert review.
- **A-5** Analyzed projects are statically resolvable enough (limited dynamic
  imports/reflection) for `deps` facts to be meaningful.

## 4. Deliberately Left Open (out of scope of the concept phase)

- Concrete thresholds per rule (will be calibrated on the corpus, not guessed).
- Exact `severityWeight`/`scale` numbers of the scoring (to be determined empirically).
- Monorepo/package structure of the implementation (npm workspaces assumed).
- Performance budget / limits of project size.

## 5. Next Decisions Before Implementation Begins

> ✅ Done during implementation: OQ-1/OQ-2 confirmed (TS/JS + TS core); the AC-5
> precision gate is enforced in the tests; the golden corpus is defined
> (`test/corpus/`). **Still open:** the expert-review process for the
> philosophical interpretations (who, when). Current state:
> [implementation-status.md](./implementation-status.md).
