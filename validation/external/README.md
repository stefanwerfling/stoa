# External validation corpus

stoa run over third-party open-source projects, pinned to a commit, with
findings classified by hand. Results and conclusions are recorded in
`docs/en/implementation-status.md` / `docs/de/implementation-status.md`
("External validation").

## Three kinds of test data, kept apart

| Kind | Where | Ground truth? | Run by |
|---|---|---|---|
| Golden regression corpora | `test/corpus`, `test/fixtures` | yes — every expected finding listed | `npm test` |
| Dogfooding targets | `scripts/compare-targets.json`, repository targets | no — compared run against run | `scripts/compare-findings.ts`, `scripts/measure-phases.ts` |
| External validation | `validation/external/` (this directory) | no — only the findings a reviewer classified count | `scripts/external-validation.ts` |

Nothing here becomes a golden corpus automatically. Promoting a project or a
finding to a golden corpus is a decision of its own.

## Layout

```
validation/external/<name>/manifest.json   repository, tag, full commit SHA, licence, how stoa analyzes it
validation/external/<name>/labels.json     the manual review (see below)
.stoa/external/<name>/                     the checkout (git-ignored; source is never copied into the repository)
```

## Usage

```bash
npx tsx scripts/external-validation.ts fetch                 # clone every project at its commit (shallow, sparse where configured)
npx tsx scripts/external-validation.ts sample ky             # unlabeled part of the deterministic sample (5 per rule) as label skeletons
npx tsx scripts/external-validation.ts sample ky --per-rule 100000   # every finding as a skeleton
npx tsx scripts/external-validation.ts report --out report.json      # per project, rule and language
```

`fetch` checks that `HEAD` is the pinned commit; `sample` and `report`
refuse a checkout at any other commit.

## Label file

| Field | Meaning |
|---|---|
| `identity` | finding-identity scheme the labels are keyed by; must equal the running scheme |
| `reviewer` | who classified and how — a model review says so (`… (model review, not confirmed by a human)`) |
| `reviewedAt`, `sampling` | when, and how the labeled findings were chosen |
| `labels[]` | `{file, rule, symbol, verdict, reason}` — `verdict` is `TP`, `FP` or `unclear` |
| `fnScope` | `{files, rules}` — files read in full for missed findings (`rules: ["*"]` = every rule) |
| `falseNegatives[]` | `{file, rule, line, reason}` — misses found in `fnScope` |

## Criteria

- **TP:** the finding's claim is true in the code, and the code is the kind
  of code the rule is meant for. For metric rules: the threshold is really
  met by a hand count; a wrong reported value is noted in `reason`.
- **FP:** the claim is wrong (including a metric that only crosses the
  threshold through a counting error), or the code is not what the rule is
  for (generated code, an override whose signature is dictated elsewhere,
  an HTTP client's outgoing body).
- **unclear:** not decidable with confidence; counted, but kept out of
  precision.

## What the numbers mean

- **Precision** = TP / (TP + FP) over labeled findings only. Unlabeled
  findings and `unclear` labels are not in it, and nothing is
  extrapolated. The sample is stratified (N per rule, some rules reviewed
  in full), so a project total is the precision *of the reviewed set*,
  not an estimate for all findings.
- **Recall** = TP / (TP + FN) inside `fnScope` only, where every produced
  finding must be labeled (the report fails otherwise). It rests on a few
  files and says nothing about the rest of a project.
- **Stale labels** (identities the run no longer produces) are listed and
  counted nowhere else.
