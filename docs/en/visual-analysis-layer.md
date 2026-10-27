# Visual Analysis Layer — Design Concept (not yet implemented)

> Status: **concept only.** This document designs an optional, browser-backed
> layer for the checks that are genuinely out of static reach (cascade/rendered
> contrast, visible focus, focus order, target size, reflow). Nothing here is
> built yet; it records *how* it would be built so that, if adopted, it stays
> faithful to stoa's principles. The static engine
> ([implementation-status.md](./implementation-status.md)) is unaffected.

## 1. Why a separate layer at all

stoa's core is **deterministic**: same input + versions + config ⇒ byte-identical
findings, with no clock, randomness, or network. The static UI/UX rules honour
this — e.g. `R-A11Y-CONTRAST-TEXT` computes contrast only from colours declared
together on an element, because that is a provable fact.

Several WCAG checks cannot be decided that way; they need a **rendered** page:

- **Cascade/rendered contrast** (1.4.3) — inherited or stylesheet colours, images
  or gradients behind text, translucent colours over a real backdrop.
- **Visible focus** (2.4.7) — is there a perceivable focus indicator when an
  element is focused?
- **Focus order / traps** (2.4.3, 2.1.2) — the actual tab sequence and whether
  focus can escape.
- **Target size** (2.5.8), **reflow** (1.4.10), **text spacing** (1.4.12) — all
  depend on layout.

Rendering introduces exactly what the core forbids: a browser engine, fonts,
timing, and layout that vary by environment. Therefore this must be a **separate,
opt-in layer** — never part of the deterministic `analyze()`.

## 2. Precedent in the codebase

Two existing layers already model "optional, separated, honestly-marked":

- **`--semantic anthropic`** — `augmentWithSemantics()` runs *after* the
  deterministic analysis; default is a `NoopSemanticAdapter`; LLM output is
  grounded and marked, never folded into the facts.
- **`--typecheck`** — emits facts with `certainty: "external-tool"`, which caps
  the confidence of any rule they trigger.

The visual layer should follow the **same shape**: a provider interface, a no-op
default, an opt-in real provider, a separate augmentation step, and facts marked
`external-tool`.

## 3. Architecture sketch

```
analyze(options)                      // deterministic, unchanged
   └── Report (static findings)

augmentWithVisual(report, options)    // NEW, optional, async, side-channel
   └── VisualAnalysisProvider.measure(target) → VisualMeasurement[]
         ├── NoopVisualProvider          (default; returns [])
         └── BrowserVisualProvider       (opt-in; drives a real browser)
```

- **`VisualAnalysisProvider`** (interface): `measure(target): Promise<VisualMeasurement[]>`.
  A measurement is a plain, serialisable record: `{selectorPath, kind, value, environment}`
  — e.g. `kind: "computedContrast", value: {ratio: 3.1, fg, bg, fontPx, bold}`.
- **`BrowserVisualProvider`**: opens `target` (a URL or a built HTML file) in a
  browser, reads `getComputedStyle` / the accessibility tree / focus state, and
  returns measurements. It owns all the non-determinism.
- **Fact bridge**: measurements become ordinary `ui.*` facts with
  `certainty: "external-tool"` and `evidence` citing the measured values, so the
  **existing rules fire unchanged** where applicable — `ui.lowContrastText` from a
  *computed* ratio reuses the very same `R-A11Y-CONTRAST-TEXT` rule. New facts
  (`ui.focusNotVisible`, `ui.focusTrap`, `ui.targetTooSmall`) get their own rules.
- **Reuse**: the luminance/ratio math in `src/analysis/Contrast.ts` is already
  pure — the browser provider resolves the colours, the shared code judges them.

## 4. The determinism contract (honest, not byte-stable)

The core promise ("byte-identical findings") **cannot** hold here, and the design
must say so rather than pretend:

- Every visual finding records its **environment** (browser name+version, viewport
  size, device-pixel-ratio, available fonts, colour scheme). Reproducibility is
  **conditional**: *same environment ⇒ same result*, not *same bytes everywhere*.
- Visual facts carry `certainty: "external-tool"` → capped confidence, and a
  reporter badge that marks them as environment-dependent.
- The layer is **off by default** and never runs in the deterministic path, so the
  golden/CI gates stay byte-stable. A visual run is a separate, labelled artefact.

This keeps the guiding rule intact: stoa still only states facts — now "measured
in *this* environment" facts — and still discloses the boundary.

## 5. CLI sketch

```
stoa visual <path-or-url> [--browser chromium] [--viewport 1280x720]
                          [--format markdown|json|sarif] [--env-report]
```

- `<path-or-url>`: a URL, or a local HTML entry that the provider serves.
- Output includes an **environment block** (so a reader can reproduce it).
- Exit code policy mirrors `eval`: findings do not fail the build unless asked —
  because an environment mismatch must not look like a regression.

## 6. What it would measure first (smallest useful slice)

1. **Computed text contrast** (1.4.3) — the rendered counterpart of the static
   rule; the single biggest coverage gain. Reuses `Contrast.ts`.
2. **Visible focus** (2.4.7) — focus each focusable element, compare the focused
   vs unfocused computed style (outline/box-shadow/border/background delta); no
   perceivable change ⇒ `ui.focusNotVisible`.

Everything else (focus order/traps, target size, reflow) is a later increment.

## 7. Risks and open questions

- **Provider runtime.** In this repo the only browser automation available is an
  interactive Claude-in-Chrome session — **not** headless/CI-reproducible. A real
  deployment would pin a headless engine (e.g. a Playwright-driven chromium) as a
  dev-/CI-dependency. Until then the layer stays a concept.
- **Dynamic pages.** SPAs need a "settled" signal; the provider must define when a
  page is ready (and record it), or results are not reproducible even in one env.
- **Scope creep.** The layer must resist becoming a generic visual-regression tool;
  it stays bound to WCAG-anchored, measurable facts — no aesthetic judgement.
- **Which element identity?** Findings need a stable locator back to source; a
  rendered DOM node maps to source only loosely (especially post-build). The
  measurement's `selectorPath` is best-effort and must be labelled as such.

## 8. Explicitly not done

No provider, CLI command, or fact bridge is implemented. This is the design we
would follow *if* the visual layer is adopted; it is recorded now so the static
work has a clear, principled continuation rather than an ad-hoc bolt-on.
