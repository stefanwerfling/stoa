# Philosophical Foundation – Sources, Interpretations, Limits

> Status: Concept phase. This document establishes the **methodological rules**
> of source work and documents the passages verified so far.
>
> **Verification note (honesty about the test setup):** The English wordings
> cited below (George Long, 1862, public domain) were checked, as part of the
> concept phase, against the *MIT Internet Classics Archive*
> (`classics.mit.edu/Antoninus/…`). The canonical **section numbering**
> (e.g. 8.47) follows the established counting; individual inline numerals could
> not be visually confirmed in every case (see
> [§6 Uncertainties](#6-documented-uncertainties)). Before any
> productive use, each passage must be finally verified against a clearly marked
> Long edition (MIT/Wikisource/Gutenberg).

## 1. Methodology of Source Work

The requirements from the project brief are implemented as **binding rules**:

1. **Three-level separation.** Every statement is assigned to one of three levels
   and marked accordingly:
   - `SOURCE` – documented original thought (with book.section + translation).
   - `TRANSLATION` – wording of a named translation (translator + year).
   - `INTERPRETATION` – the project's own reading (clearly marked as such).
2. **No invention.** No passage, chapter assignment, or statement is invented.
   What is not documented is not asserted.
3. **Documented citation.** Quotations carry `book.section`, translator, and source.
4. **Confidence of the assignment.** Every principle assignment carries an
   **attribution confidence** (how certain is it that the thought comes from
   Marcus Aurelius) and an **interpretation confidence** (how sustainable is the
   technical transfer). Both kept separate.
5. **Copyright.** Only public domain wordings are stored verbatim
   (see [§3](#3-copyright-status-of-the-translations)).
6. **No full-text storage as prompt/index.** **No** undifferentiated book text
   is stored; instead a structured, citable knowledge base with individual
   citations and interpretations (data model:
   [knowledge-model.md](./knowledge-model.md)).
7. **Critical stance.** Not every thought can be meaningfully translated into a
   technical rule. Such cases are explicitly recorded in
   [§5 "What *cannot* be translated"](#5-what-cannot-be-meaningfully-translated).

### Warning about a fundamental error

Marcus Aurelius writes **ethics and conduct of life**, not software engineering.
Every transfer is an **analogy**, not a proof. The engine must never derive from
it that a piece of code is "unstoic" and therefore objectively bad. Philosophy
provides an *interpretive frame for findings that are technically grounded
anyway* – not the other way around. (Product guiding principles L2, L5.)

## 2. Verified Passages (Evidence Register)

Wording = **George Long, 1862 (public domain)**. The non-English column is a
**working translation of the project** marked as such (level
`INTERPRETATION`/`TRANSLATION` – *not* a cited third-party translation); for
citable text see the public domain edition in [§3](#3-copyright-status-of-the-translations).

| Passage | Long (public domain, EN) | Working translation (project, EN) | Status |
|------------|-----------------------|----------------------------------|--------|
| **4.24** | „Occupy thyself with few things, says the philosopher, if thou wouldst be tranquil.— But consider if it would not be better to say, Do what is necessary…" | "Concern yourself with few things … if you want tranquility. — But better: *Do what is necessary.*" | CONFIRMED |
| **4.7** | „Take away thy opinion, and then there is taken away the complaint, 'I have been harmed.' Take away the complaint … and the harm is taken away." | "Remove the judgment, and the complaint 'I have been wronged' is gone; remove the complaint, and the harm is gone." | CONFIRMED |
| **8.47** | „If thou art pained by any external thing, it is not this thing that disturbs thee, but thy own judgement about it; and it is in thy power to wipe out this judgement now." | "If something external pains you, it is not the thing but your judgment about it; and it is in your power to erase that judgment now." | CONFIRMED |
| **5.20** | „…the mind converts and changes every hindrance to its activity into an aid; and so that which is a hindrance is made a furtherance to an act; and that which is an obstacle on the road helps us on this road." | "…the mind turns every hindrance to its activity into a furtherance; what stands in the way becomes a means of acting." | CONFIRMED (Long wording) |
| **6.54** | „That which is not good for the swarm, neither is it good for the bee." | "What is not good for the swarm is not good for the bee either." | CONFIRMED |
| **2.1** | „…we are made for co-operation, like feet, like hands, like eyelids…" | "…we are made for cooperation, like feet, hands, eyelids…" | CONFIRMED |
| **5.1** | „In the morning when thou risest unwillingly, let this thought be present— I am rising to the work of a human being." | "When you rise unwillingly in the morning, think: I am rising to the work of a human being." | CONFIRMED |
| **8.19** | „Everything exists for some end, a horse, a vine. Why dost thou wonder? Even the sun will say, I am for some purpose…" | "Everything exists for a purpose – a horse, a vine … even the sun: I am here for a purpose." | CONFIRMED |
| **12.17** | „If it is not right, do not do it: if it is not true, do not say it." | "If it is not right, do not do it; if it is not true, do not say it." | CONFIRMED |
| **12.22** | „Consider that everything is opinion, and opinion is in thy power. Take away then, when thou choosest, thy opinion…" | "Consider: everything is opinion, and opinion is in your power. Take it away whenever you wish…" | CONFIRMED |
| **6.8** | „the ruling faculty … makes itself such as it is and such as it wills to be, and it makes everything which happens appear to itself such as it wills." | "The ruling faculty shapes itself and interprets every event as it wills." | CONFIRMED |
| **5.19** | „Things themselves touch not the soul … nor can they turn or move the soul…" | "Things themselves do not touch the soul … they do not move the soul." | CONFIRMED |

### Important corrections (documented because they are easily got wrong)

- **5.20 – do not cite the popular version.** The well-known phrasing
  *"The impediment to action advances action. What stands in the way becomes the
  way."* comes from the **modern, copyright-protected** translation by
  **Gregory Hays (2002)** and was popularized by Ryan Holiday. It is **not**
  public domain. We cite exclusively the Long wording above.
- **2.1 ≠ 2.5.** "do every act of thy life as if it were the last" is **2.5**;
  the list "Begin the morning … the busy-body, the ungrateful…" is **2.1**.
  (2.1 also contains the cooperation sentence that we use.)
- **6.2** was **not** verified and is therefore **not** used as evidence.

## 3. Copyright Status of the Translations

| Edition | Language | Status | Use in *stoa* |
|---------|---------|--------|-------------------|
| Greek original (antiquity) | GR | public domain | reference |
| **George Long, 1862** | EN | **public domain** | **primary citable base text** |
| Méric Casaubon, 1634 | EN | public domain | usable (archaic) |
| Jackson 1906 / Collier 1701 / Rendall 1898 | EN | public domain | optional |
| **Gregory Hays, 2002** | EN | **© protected** | **not verbatim** |
| Robin Hard, Hammond, Farquharson | EN | © protected | not verbatim |
| **A. von Gleichen-Russwurm** (translator † 1947) | DE | **public domain** (Gutenberg 15028; DE PD since 2018) | **citable DE base text** |
| Wittstock / Cless (19th c.) | DE | *very likely* public domain | only after checking the specific edition |
| **Otto Kiefer** (translator † 1957) | DE | **probably still © (until end of 2027)** | **do not** treat as public domain |
| Reclam / Krapinger et al. | DE | © protected | not verbatim |

**Consequence for the knowledge base:** only Long (EN) is stored verbatim and –
if German full text is desired – Gleichen-Russwurm (DE). Everything else only as
a citation reference or as the project's own working translation.

## 4. Derived Principles (Overview)

Six principles form the MVP knowledge base. Each is fully worked out in
[knowledge-model.md](./knowledge-model.md#example-principles)
(interpretation, hypothesis, analysis, examples, limits).

| Principle ID | Short name | Cited passages | Attribution confidence | Technical field |
|------------|----------|--------------|------------------------|------------------|
| `marcus.simplicity` | Moderation / doing the necessary | 4.24 | high | Unnecessary complexity |
| `marcus.purpose` | Purpose & task | 8.19; 5.1 | medium–high | Unclear responsibilities |
| `marcus.control` | What is one's own / the faculty of judgment | **primarily Epictetus Ench. 1**; Marcus Aurelius: 12.22, 6.8, 5.19, 8.56 | **low for Marcus Aurelius** | Uncontrolled side effects |
| `marcus.obstacle` | Obstacle → furtherance | 5.20 | high | Error suppression |
| `marcus.cooperation` | Serving the whole | 6.54; 2.1 | high | Unnecessary/wrong dependencies |
| `marcus.judgment` | Examining judgments | 4.7; 8.47; 12.17 | high | Architecture ↔ behavior; **meta-principle** |

### Important honesty note on `marcus.control`

The **"dichotomy of control"** (to concern oneself only with what is in our
power) is, in its clear form, **Epictetus, *Encheiridion* 1** – **not** Marcus
Aurelius. Marcus Aurelius shares the basic Stoic attitude and expresses related
things (12.22, 6.8, 5.19, 8.56), but does not formulate the dichotomy as a
doctrine. For this reason `marcus.control` carries a **low attribution
confidence to Marcus Aurelius** and refers to Epictetus as the primary source.
This is exactly the type of uncertain assignment that the methodology is meant
to make visible – and at the same time a test case for the planned
**multi-work extensibility** (Epictetus as a second source, see
[knowledge-model.md](./knowledge-model.md)).

## 5. What *cannot* be meaningfully translated

Explicitly documented **non-transfers** (preventing overextension):

- **Death/transience** (e.g. 2.5, 4.48): ethically central, but no sustainable,
  non-trivial code rule. (Risk of flat analogies such as "dead code = memento
  mori".) → **no rule.**
- **Dealing with difficult people** (2.1 opening): social/team-related, not
  derivable from source code. → **no rule.**
- **Equanimity toward praise/blame**: not statically measurable. → **no rule.**
- **Cosmic reason / Logos**: metaphysical; any technical correspondence would be
  pure projection. → **no rule.**

This list is part of quality assurance: a principle without a sustainable,
documentable technical hypothesis does **not** become a rule.

## 6. Documented Uncertainties

1. **Inline section numbers** in Book 8 (8.19/8.47/8.56) follow the canonical
   counting; the wording is confirmed, individual numerals were not visually
   cross-checked. → finally verify before productive use.
2. **6.2** unconfirmed → not used.
3. **Specific printed editions** of Wittstock/Cless: PD by age very likely, but
   not individually confirmed.
4. A Gutenberg edition attempted earlier (ebook 2680) delivered divergent,
   truncated text; it is **not** used as evidence. The basis is a
   MIT/Wikisource/clearly marked Long edition.

## 7. Process for new evidence/principles

1. Record the passage + public domain translation; mark the level
   (`SOURCE`/`TRANSLATION`/`INTERPRETATION`).
2. Assign attribution and interpretation confidence separately.
3. Formulate a technical hypothesis + at least one counterexample; otherwise
   discard (→ §5).
4. Expert review of the interpretation (see [evaluation.md](./evaluation.md#6-expert-review)).
5. Versioning in the knowledge base (change history).
