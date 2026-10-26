# Vision – Stoic Code Analysis Engine (working title: *stoa*)

> Status: concept phase. This document describes goals, non-goals and
> use cases. It deliberately contains **no** implementation requirements.
> Open decisions are collected in [open-questions.md](./open-questions.md).
> The project name is provisional.

## 1. Summary

*stoa* is a standalone, deterministic code analysis engine. It
translates selected, source-verified thoughts from Marcus Aurelius'
*Meditations* into traceable, technical review criteria for
source code and architecture.

The core is **not** an LLM. The core is a classic static analysis
(AST, control-flow, dependency analysis) with a versioned
rule engine. Philosophy here provides solely the **interpretive frame**
("why is this finding relevant?"), not the finding itself. An LLM is
an optional, clearly bounded supplement for tasks that structural
analysis alone cannot perform reliably.

## 2. Problem

Static analysis tools (ESLint, PHPStan, Psalm, SonarQube, …) deliver
many individual, technically correct findings. Developers,
however, often experience these findings as:

- **disconnected** – every rule stands on its own, a common thread is missing;
- **weakly justified in evaluative terms** – "Cyclomatic Complexity 14 > 10" explains *that*,
  but not convincingly *why* and *with what consequence*;
- **stylistic rather than substantive** – subjective preferences appear as
  objective defects.

*stoa* does not try to invent better linter rules. *stoa* tries to lay a
**consistent, justified evaluation frame** over technical findings
and to prioritize findings where they actually affect maintainability,
understandability and robustness.

## 3. Vision

> An analysis engine that transparently links technical observations with a
> justified understanding of quality – traceable, reproducible
> and honest about its limits.

To this end, *stoa* combines seven building blocks:

1. a **structured, citable** philosophical knowledge base;
2. an **explicit translation** of principles into software criteria
   (including documented limits and counterexamples);
3. **static code and structure analysis** via language adapters;
4. a **deterministic, versioned rule engine**;
5. an **optional semantic evaluation** by an LLM (switchable off);
6. a **transparent finding model** with separate severity and confidence;
7. **justified but non-binding** improvement suggestions.

## 4. Guiding principles of the product

These principles apply to *stoa* itself – regardless of which code it
analyzes.

| # | Guiding principle | Meaning for the product |
|---|-------------|---------------------------|
| L1 | **Determinism first** | The core delivers identical findings for the same input and the same version. LLM portions are separate, marked and switchable off. |
| L2 | **Evidence before evaluation** | Every finding names the concrete technical observation (file, location, metric). The philosophical interpretation is downstream and marked as interpretation. |
| L3 | **Severity ≠ confidence** | How serious a problem would be and how certain we are that we detected it are two separate axes. |
| L4 | **Context beats threshold** | No rule evaluates a metric in isolation as "bad". Long functions, many parameters etc. are only *signals*. |
| L5 | **No philosophy as fact** | *stoa* never presents philosophical evaluations as objective truth. Attributions are justified but marked as interpretation. |
| L6 | **Source fidelity** | No invented passages, chapters or statements. Uncertain attributions are flagged. See [philosophical-foundation.md](./philosophical-foundation.md). |
| L7 | **Suggestion instead of intervention** | *stoa* analyzes and recommends. It does not change source code without explicit approval. |
| L8 | **Extensible, not nailed down** | Bound neither to Marcus Aurelius nor to one programming language. Source, interpretation, rule and language adapter are separate. |

## 5. Target groups and use cases

### Target groups
- **Individual developers / small teams** who want to look at their codebase with a justified
  quality view (the context of this project: PHP and
  TypeScript/Node ecosystem).
- **Tech leads / reviewers** who want to prioritize review focus areas.
- **Teaching contexts** in which the *why* part of code quality is conveyed.

### Use cases (UC)

| ID | Use case | Description | MVP? |
|----|----------------|--------------|------|
| UC-1 | **Project scan (CLI)** | `stoa analyze ./src` produces a reproducible report with findings, evidence and suggestions. | ✅ |
| UC-2 | **Single-file analysis** | Fast feedback on a file, e.g. in the editor workflow. | ✅ |
| UC-3 | **Diff/PR analysis** | Evaluate only changed files/lines, for CI and pull requests. | ◻ (expansion stage) |
| UC-4 | **Quality profile** | Multi-dimensional profile instead of a single grade; trend over commits. | ◻ |
| UC-5 | **Semantic deep dive** | Optional LLM assessment of selected findings (e.g. "is this abstraction really superfluous?"). | ◻ (optional) |
| UC-6 | **Baseline / suppression** | Accept existing findings as a baseline, report only regressions. | ◻ |
| UC-7 | **Own knowledge base** | Teams add their own principles/sources and rules. | ◻ |

## 6. Non-goals

Explicitly **not** a goal of this project:

- **N1** – Feeding Marcus Aurelius quotes into an LLM prompt and presenting the answer as
  a "Stoic analysis". That is exactly what *stoa* is meant to replace.
- **N2** – Claiming a philosophically "objectively correct" code evaluation.
  Code quality here is a **technical operationalization**, not a
  measurable natural quantity.
- **N3** – Reimplementing existing established tools (compiler, ESLint, PHPStan, Psalm).
  *stoa* **integrates** and **interprets** their results,
  where sensible.
- **N4** – Being yet another pure style linter. Style preferences without
  demonstrable quality impact are not a finding (see L4).
- **N5** – Automatic, unsupervised rewriting of code.
- **N6** – Complete semantic program verification or proof of
  correctness.
- **N7** – A single "score" that presses complex quality into one number and
  creates false precision (an aggregated value is *optional* and always accompanied by
  its profile).

## 7. Distinction from existing tools

| Tool class | What it does | What *stoa* does differently/additionally |
|-----------------|------------|----------------------------------|
| Linter (ESLint) | Style + simple error patterns | Links findings with quality dimensions + a justified frame; deliberately filters out pure style rules. |
| Type checker (tsc, PHPStan, Psalm) | Type/null safety | Uses their diagnostics as an **evidence source**, but interprets them in the context of error handling/robustness. |
| SonarQube | Broad metric/smell collection, scores | More transparent derivation, separate severity/confidence, no optimizing-for-one-number, explicit counterexamples per rule. |
| LLM code review | Free-text assessment | Deterministic core + marked, evidence-required LLM supplement instead of a pure free-text opinion. |

## 8. Success criteria (conceptual)

The project is successful as a concept when:

- every example rule has a **positive and a negative** example
  (finding justified / not justified);
- every philosophical attribution carries a **traceable source** and an
  **explicit confidence**;
- the deterministic core delivers meaningful results **without an LLM**;
- false positives are **measurable** against a reference corpus
  (see [evaluation.md](./evaluation.md)).

Concrete, verifiable acceptance criteria for the MVP are in
[roadmap.md](./roadmap.md#2-acceptance-criteria).

## 9. Related documents

- [philosophical-foundation.md](./philosophical-foundation.md) – sources & methodology
- [architecture.md](./architecture.md) – components & data flows
- [knowledge-model.md](./knowledge-model.md) – data model of the knowledge base
- [rule-model.md](./rule-model.md) – rules & execution
- [finding-model.md](./finding-model.md) – findings & evaluation
- [evaluation.md](./evaluation.md) – validation & quality measurement
- [technology-decision.md](./technology-decision.md) – architecture comparison
- [roadmap.md](./roadmap.md) – MVP & milestones
- [open-questions.md](./open-questions.md) – open decisions & risks
