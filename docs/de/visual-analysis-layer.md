# Visueller Analyse-Layer — Design-Konzept (noch nicht umgesetzt)

> Status: **nur Konzept.** Dieses Dokument entwirft einen optionalen,
> browser-gestützten Layer für die Prüfungen, die statisch wirklich nicht
> erreichbar sind (Kaskaden-/gerenderter Kontrast, sichtbarer Fokus,
> Fokusreihenfolge, Zielgrößen, Reflow). Nichts davon ist gebaut; festgehalten
> wird, *wie* es gebaut würde, damit es — falls übernommen — stoas Grundsätzen
> treu bleibt. Der statische Kern
> ([implementation-status.md](./implementation-status.md)) ist unberührt.

## 1. Warum überhaupt ein getrennter Layer

stoas Kern ist **deterministisch**: gleiche Eingabe + Versionen + Config ⇒
byte-identische Befunde, ohne Uhr, Zufall oder Netz. Die statischen UI/UX-Regeln
halten das ein — z. B. berechnet `R-A11Y-CONTRAST-TEXT` Kontrast nur aus Farben,
die gemeinsam am Element deklariert sind, weil das ein belegbarer Fakt ist.

Mehrere WCAG-Prüfungen lassen sich so nicht entscheiden; sie brauchen eine
**gerenderte** Seite:

- **Kaskaden-/gerenderter Kontrast** (1.4.3) — vererbte oder Stylesheet-Farben,
  Bilder oder Verläufe hinter Text, transluzente Farben über echtem Hintergrund.
- **Sichtbarer Fokus** (2.4.7) — gibt es einen wahrnehmbaren Fokusindikator, wenn
  ein Element fokussiert ist?
- **Fokusreihenfolge / -fallen** (2.4.3, 2.1.2) — die tatsächliche Tab-Folge und ob
  der Fokus wieder entkommen kann.
- **Zielgrößen** (2.5.8), **Reflow** (1.4.10), **Textabstände** (1.4.12) — alle
  hängen vom Layout ab.

Rendering bringt genau das, was der Kern verbietet: eine Browser-Engine, Fonts,
Timing und Layout, die je Umgebung variieren. Daher muss dies ein **getrennter,
opt-in Layer** sein — nie Teil des deterministischen `analyze()`.

## 2. Vorbild im Code

Zwei bestehende Schichten modellieren bereits „optional, getrennt, ehrlich
markiert":

- **`--semantic anthropic`** — `augmentWithSemantics()` läuft *nach* der
  deterministischen Analyse; Default ist ein `NoopSemanticAdapter`; LLM-Ausgabe
  wird geerdet und markiert, nie in die Facts eingebacken.
- **`--typecheck`** — erzeugt Facts mit `certainty: "external-tool"`, was die
  Konfidenz jeder davon ausgelösten Regel deckelt.

Der visuelle Layer sollte dieselbe **Form** nutzen: ein Provider-Interface, ein
No-op-Default, ein opt-in realer Provider, ein getrennter Augmentierungsschritt
und als `external-tool` markierte Facts.

## 3. Architektur-Skizze

```
analyze(options)                      // deterministisch, unverändert
   └── Report (statische Befunde)

augmentWithVisual(report, options)    // NEU, optional, async, Seitenkanal
   └── VisualAnalysisProvider.measure(target) → VisualMeasurement[]
         ├── NoopVisualProvider          (Default; liefert [])
         └── BrowserVisualProvider       (opt-in; steuert echten Browser)
```

- **`VisualAnalysisProvider`** (Interface): `measure(target): Promise<VisualMeasurement[]>`.
  Eine Messung ist ein einfacher, serialisierbarer Datensatz:
  `{selectorPath, kind, value, environment}` — z. B.
  `kind: "computedContrast", value: {ratio: 3.1, fg, bg, fontPx, bold}`.
- **`BrowserVisualProvider`**: öffnet `target` (URL oder gebaute HTML-Datei) im
  Browser, liest `getComputedStyle` / den Accessibility-Baum / Fokuszustand und
  liefert Messungen. Er trägt die gesamte Nicht-Determiniertheit.
- **Fact-Brücke**: Messungen werden zu gewöhnlichen `ui.*`-Facts mit
  `certainty: "external-tool"` und `evidence`, das die gemessenen Werte nennt,
  sodass die **bestehenden Regeln unverändert feuern**, wo zutreffend —
  `ui.lowContrastText` aus einem *berechneten* Verhältnis nutzt dieselbe Regel
  `R-A11Y-CONTRAST-TEXT`. Neue Facts (`ui.focusNotVisible`, `ui.focusTrap`,
  `ui.targetTooSmall`) bekommen eigene Regeln.
- **Wiederverwendung**: die Luminanz-/Ratio-Mathematik in
  `src/analysis/Contrast.ts` ist bereits rein — der Browser-Provider löst die
  Farben auf, der geteilte Code bewertet sie.

## 4. Der Determinismus-Vertrag (ehrlich, nicht byte-stabil)

Das Kernversprechen („byte-identische Befunde") **kann** hier nicht gelten, und
das Design muss das aussprechen statt es vorzutäuschen:

- Jeder visuelle Befund protokolliert seine **Umgebung** (Browsername+Version,
  Viewport-Größe, Device-Pixel-Ratio, verfügbare Fonts, Farbschema).
  Reproduzierbarkeit ist **bedingt**: *gleiche Umgebung ⇒ gleiches Ergebnis*,
  nicht *überall gleiche Bytes*.
- Visuelle Facts tragen `certainty: "external-tool"` → gedeckelte Konfidenz, plus
  ein Reporter-Badge, das sie als umgebungsabhängig kennzeichnet.
- Der Layer ist **standardmäßig aus** und läuft nie im deterministischen Pfad,
  sodass die Golden-/CI-Tore byte-stabil bleiben. Ein visueller Lauf ist ein
  getrenntes, gekennzeichnetes Artefakt.

So bleibt der Leitgrundsatz intakt: stoa benennt weiterhin nur Fakten — jetzt „in
*dieser* Umgebung gemessene" Fakten — und legt weiterhin die Grenze offen.

## 5. CLI-Skizze

```
stoa visual <pfad-oder-url> [--browser chromium] [--viewport 1280x720]
                            [--format markdown|json|sarif] [--env-report]
```

- `<pfad-oder-url>`: eine URL oder ein lokaler HTML-Einstieg, den der Provider
  ausliefert.
- Die Ausgabe enthält einen **Umgebungsblock** (damit ein Leser sie reproduzieren
  kann).
- Exit-Code-Politik wie bei `eval`: Befunde brechen den Build nicht, sofern nicht
  verlangt — denn eine Umgebungsabweichung darf nicht wie eine Regression aussehen.

## 6. Was zuerst gemessen würde (kleinster nützlicher Schnitt)

1. **Berechneter Textkontrast** (1.4.3) — das gerenderte Gegenstück zur statischen
   Regel; der größte einzelne Abdeckungsgewinn. Nutzt `Contrast.ts`.
2. **Sichtbarer Fokus** (2.4.7) — jedes fokussierbare Element fokussieren, den
   fokussierten vs. unfokussierten computed style vergleichen
   (Outline-/Box-Shadow-/Border-/Background-Differenz); keine wahrnehmbare
   Änderung ⇒ `ui.focusNotVisible`.

Alles andere (Fokusreihenfolge/-fallen, Zielgrößen, Reflow) ist ein späteres
Inkrement.

## 7. Risiken und offene Fragen

- **Provider-Laufzeit.** In diesem Repo ist die einzige verfügbare
  Browser-Automatisierung eine interaktive Claude-in-Chrome-Sitzung — **nicht**
  headless/CI-reproduzierbar. Ein echter Einsatz würde eine Headless-Engine (z. B.
  ein Playwright-gesteuertes chromium) als Dev-/CI-Abhängigkeit festlegen. Bis
  dahin bleibt der Layer ein Konzept.
- **Dynamische Seiten.** SPAs brauchen ein „settled"-Signal; der Provider muss
  definieren (und protokollieren), wann eine Seite bereit ist, sonst sind
  Ergebnisse selbst in einer Umgebung nicht reproduzierbar.
- **Scope-Creep.** Der Layer darf nicht zum generischen Visual-Regression-Tool
  werden; er bleibt an WCAG-verankerte, messbare Fakten gebunden — kein
  ästhetisches Urteil.
- **Welche Element-Identität?** Befunde brauchen einen stabilen Verweis zurück in
  den Quelltext; ein gerenderter DOM-Knoten lässt sich nur lose auf die Quelle
  abbilden (besonders nach dem Build). Der `selectorPath` der Messung ist
  Best-Effort und muss als solcher gekennzeichnet werden.

## 8. Ausdrücklich nicht umgesetzt

Weder Provider noch CLI-Befehl noch Fact-Brücke sind implementiert. Dies ist das
Design, dem wir folgen würden, *falls* der visuelle Layer übernommen wird; es wird
jetzt festgehalten, damit die statische Arbeit eine klare, grundsätzliche
Fortsetzung hat statt eines Ad-hoc-Anbaus.
