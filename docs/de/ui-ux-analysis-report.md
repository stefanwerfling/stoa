# UI/UX-Analyse — Abschlussbericht

> Statusbericht zur Arbeit „Stoa – UI/UX-Analyse-Engine". Er beschreibt, was gebaut
> wurde, wie die genannten Vorgaben eingehalten werden, was bewusst **nicht**
> geprüft wird und wo menschliches bzw. Nutzer-Testing nötig bleibt. Die Zahlen
> sind die des committeten Stands; die laufenden Gesamtwerte stehen in
> [implementation-status.md](./implementation-status.md).

## 1. Auftrag und Leitgrundsatz

stoa um die Analyse von Benutzeroberflächen erweitern, **ohne subjektive
Designmeinung als objektive Tatsache darzustellen**. stoa behauptet nicht zu
wissen, ob ein Design schön ist. Es meldet, was aus dem Quelltext **technisch
belegbar** ist, schätzt — vorsichtig — ab, was Verständlichkeit/Bedienbarkeit
beeinträchtigen könnte, und **legt offen, wo menschliches oder Nutzer-Testing
nötig ist**. Keine erfundenen, scheinpräzisen „UX-Scores".

Durchgehend eingehaltene harte Vorgaben:

1. Deterministische Analyse, **ohne LLM** lauffähig.
2. Jeder Befund beruht auf einem **verifizierbaren Fact** (konkretes Element + Evidenz).
3. Empfehlungen enthalten **keine unbewiesenen technischen Behauptungen** (jede Regel nennt Nachteile und fehlenden Kontext).
4. Semantische Deutung bleibt von den technischen Facts **getrennt** (Prinzip-Referenzen, nicht in den Fact eingebacken).
5. Analysierter Quelltext wird **nie verändert**.
6. Ergebnisse sind **reproduzierbar und getestet** (byte-stabil; Golden- + UI-Korpus).

## 2. Bestandsaufnahme (wiederverwendet, nicht neu erfunden)

Die UI/UX-Arbeit ergänzte **einen** neuen Adapter und einen Satz Regeln auf der
bestehenden Engine — keine neue Architektur, kein neues Finding-Modell:

- **Pipeline** (Ingestion → Fact-Extraktion → Regel-Engine → Befunde → Reporter) — unverändert.
- **LanguageAdapter**-Vertrag — ein neuer `HtmlAdapter` (tree-sitter-html, WASM, in-process) implementiert ihn genau wie die TS/PHP/Dart/C-C++-Adapter.
- **Deklaratives Regelmodell** (`rules/default/*.json`) — die A11y-Regeln sind gewöhnliche Regeln mit Bezug auf die `marcus.*`-Wissensbasis; keine Sonderbehandlung im Code.
- **Finding-Modell, Reporter** (Markdown/JSON/SARIF 2.1.0), **Evaluator**, **i18n** — unverändert übernommen. Zwei Qualitätsdimensionen (`accessibility`, `usability`) wurden in die bestehende Union/Enum/Labels aufgenommen.

## 3. Zuordnung der Analysebereiche

Der Auftrag nannte fünf Bereiche (A Lesbarkeit/Kontrast, B Funktions­verständlich­keit,
C Bedienbarkeit/Zugänglichkeit, D visuelle Hierarchie/Konsistenz, E Interaktion/Zustand).
Ehrliche Zuordnung des aktuellen **statischen HTML**-Schnitts:

| Bereich | Statische Abdeckung | Anmerkung |
|---------|---------------------|-----------|
| A — Lesbarkeit / Kontrast | **Teilweise** | Textkontrast (WCAG 1.4.3) wird deterministisch aus inline deklarierten Farbpaaren berechnet (`R-A11Y-CONTRAST-TEXT`); der Kaskaden-/gerenderte Fall (Vererbung, Stylesheets, Bilder, Transparenz) braucht weiterhin einen visuellen Schnitt. |
| B — Funktions­verständlich­keit | **Teilweise** | Zugängliche Namen für Controls/Links/Bilder/Frames; Label-Zuordnung; Dokumentsprache. „Ist der Name *gut*?" wird nicht beurteilt. |
| C — Bedienbarkeit / Zugänglichkeit | **Stark** | Der Großteil der 14 Regeln: Namen, Labels, Rollen, ARIA-Zustand/-Attribut-Gültigkeit, Zoom, ins Leere zeigende Referenzen, doppelte ids. |
| D — visuelle Hierarchie / Konsistenz | **Keine (bewusst)** | Überschriftenordnung/Abstände/Konsistenz hängen von Rendering und Absicht ab; aus dem Markup nicht ohne Überanspruch belegbar. |
| E — Interaktion / Zustand | **Teilweise** | positives-tabindex-Signal zur Fokusreihenfolge; fokussierbar-aber-aria-hidden. Vollständige Fokusreihenfolge/-fallen/dynamische Zustände brauchen Interaktion. |

## 4. Gelieferte Regeln (statisches HTML-A11y-Paket, 14)

Jede ist eine deklarative, kontextbewusste Regel (erzeugt einen Fact nur bei
echter Verletzung), an ein WCAG-2.2-Erfolgskriterium gebunden und trägt
EN/DE-Meldung, Begründung, Abhilfe **und** einen `missingContext`-Hinweis.

| Regel | WCAG | Was sie belegt |
|-------|------|----------------|
| R-A11Y-IMG-ALT | 1.1.1 | `<img>` ohne `alt` (dekoratives `alt=""`/`aria-hidden`/`role=presentation` korrekt) |
| R-A11Y-CONTROL-NAME | 4.1.2 | `<button>` ohne zugänglichen Namen |
| R-A11Y-FORM-LABEL | 1.3.1/4.1.2 | beschriftbares Feld ohne zugeordnetes Label (Placeholder ist kein Label) |
| R-A11Y-LINK-NAME | 2.4.4/4.1.2 | `<a href>` ohne zugänglichen Namen |
| R-A11Y-ARIA-HIDDEN-FOCUSABLE | 4.1.2 | fokussierbares Element mit `aria-hidden="true"` verborgen |
| R-A11Y-ARIA-INVALID-ROLE | 4.1.2 | `role`, deren Tokens keine definierte WAI-ARIA-Rolle sind |
| R-A11Y-ARIA-UNKNOWN-ATTR | 4.1.2 | `aria-*`-Attributname nicht in WAI-ARIA 1.2 |
| R-A11Y-ARIA-INVALID-VALUE | 4.1.2 | enumerierter ARIA-Zustand/-Eigenschaft mit unzulässigem Wert |
| R-A11Y-POSITIVE-TABINDEX | 2.4.3 | `tabindex` > 0 überschreibt natürliche Fokusreihenfolge |
| R-A11Y-HTML-LANG | 3.1.1 | `<html>` ohne `lang` |
| R-A11Y-META-VIEWPORT-ZOOM | 1.4.4 | Viewport-Meta deaktiviert/begrenzt Zoom |
| R-A11Y-ARIA-DANGLING-IDREF | 1.3.1/4.1.2 | `aria-labelledby`/`-describedby` zeigt auf fehlende id |
| R-A11Y-DUPLICATE-ID | 1.3.1/4.1.2 | eine `id` mehrfach verwendet |
| R-A11Y-FRAME-TITLE | 4.1.2 | `<iframe>`/`<frame>` ohne zugänglichen Namen |

Berührte WCAG-Prinzipien: Wahrnehmbar (1.1.1, 1.3.1, 1.4.4), Bedienbar (2.4.3,
2.4.4), Verständlich (3.1.1), Robust (4.1.2).

## 5. Wie die Vorgaben belegt sind

- **Deterministisch / kein LLM:** Der HTML-Adapter parst in-process (WASM); keine Uhr/kein Zufall/kein Netz. Die semantische (LLM-)Schicht bleibt optional und getrennt.
- **Facts statt Meinung:** Jede Regel löst auf einem `ui.*`-Fact aus, der ein konkretes Element und seine Start-Tag-Evidenz benennt. „Kein zugänglicher Name" wird berechnet (Text / `aria-label(ledby)` / `title` / verschachteltes `img[alt]`/`svg>title`), nicht aus Attribut-Präsenz geraten.
- **Kontextbewusst, nicht naiv:** dekoratives `alt=""`, `aria-hidden`, `role=presentation`, `tabindex="-1"`, Placeholder-ist-kein-Label, erstes-gültiges-ARIA-Token, leere/dynamische Werte, Präfix-Modulrollen (`doc-*`/`graphics-*`) werden alle behandelt, sodass legitimes Markup **nicht** gemeldet wird.
- **Keine Scheinpräzision:** nirgends ein numerischer UX-Score. Schwere/Konfidenz werden nach dem bestehenden Modell abgeleitet; Konfidenz durch Fact-Sicherheit gedeckelt.
- **Ehrliche Grenzen:** der `missingContext` jeder Regel nennt, was sie **nicht** entscheidet (z. B. zur Laufzeit eingefügte ids, BCP-47-Gültigkeit, ob ein Titel beschreibend ist).

## 6. Evaluation und Qualitätstore

- **UI/UX-Korpus** (`test/fixtures/html/`): positive, negative und bewusst-nicht-warnende Fälle je Regel. Aktuelle Eval **Precision 100 % / Recall 100 %** auf diesem Korpus; ein Precision-Gate je Regel wird erzwungen.
- Jede Regel liefert **positive und negative** Tests; die gesamte Suite ist grün.
- Der bestehende **Golden-Korpus** (TS + PHP) ist **unverändert** (TP 44, 100 %/100 %) — die UI-Arbeit hat vorhandene Ergebnisse nicht gestört.
- **Wichtiger Ehrlichkeitsvorbehalt:** Diese Zahlen beschreiben einen kleinen, kuratierten Korpus. Sie sind **keine** allgemeine Zuverlässigkeitsgarantie für beliebige Seiten. Reale Seiten werden Fehlalarme/Auslassungen zeigen, die der Korpus nicht enthält.

## 7. Bewusste Grenzen (wo Nutzer-/menschliches Testing nötig ist)

Statisch **nicht** zuverlässig entscheidbar, daher ausgelassen statt geraten:

- **Kaskaden-/gerenderter Farbkontrast** (1.4.3) — inline Farbpaare werden geprüft; vererbte/Stylesheet-Farben, Bilder hinter Text und transluzente Farben brauchen Rendering.
- **Sichtbarer Fokus, Fokusreihenfolge/-fallen, dynamische Zustände** (über das positive-tabindex-Signal hinaus) — brauchen Interaktion mit einer gerenderten Seite.
- **Zielgrößen, Reflow, Bewegung** — brauchen Layout.
- **Ob ein Name/Label/Titel *aussagekräftig* ist** — menschliches Urteil; stoa prüft Präsenz, nicht Qualität.
- **Überschriftenhierarchie / visuelle Konsistenz** — absichtsabhängig; wäre Meinung, nicht Tatsache.

**Zugänglicher Name — was statisch gewertet wird:** Die Namensberechnung ist eine
konservative Annäherung, keine Nachbildung des Browser-Accessibility-Trees. Als Name
zählen nicht-leeres `aria-label`, sichtbarer Text **ohne** `aria-hidden`-Subbäume,
verschachteltes `img[alt]`/`svg > title` und — nur in HTML — `aria-labelledby`, das
gegen seine Ziele im Dokument aufgelöst wird (leerer Wert, fehlende/leere Ziele →
kein Name; Referenzketten mit Zyklus-Schutz). In JSX/Vue/Angular bleiben
`aria-labelledby`-Ziele unaufgelöst (ein nicht-leerer Wert gilt konservativ als Name,
ein leerer nicht). `role=presentation`/`none` nimmt ein fokussierbares Control nicht
von der Namenspflicht aus; Fokusierbarkeit folgt aus striktem Integer-`tabindex`,
`contenteditable` und nativer Interaktivität.

**Drei Stufen der Aussagekraft.** stoa unterscheidet sauber zwischen (1) einer
*statisch bewiesenen technischen Auffälligkeit*, (2) einem daraus *abgeleiteten
Risiko* und (3) einem *begründbaren WCAG-Verstoß*. Ein fehlendes `alt`, ein fehlender
zugänglicher Name oder ein zu geringer Inline-Kontrast fällt unter (3) (die SC wird
als Verstoß genannt). Ein **unbekanntes ARIA-Attribut, ein ungültiger ARIA-Wert/eine
ungültige Rolle oder eine doppelte id** ist Stufe (1)/(2): der Fakt ist bewiesen, der
konkrete WCAG-Bezug ist kontextabhängig und wird daher als *„verwandt: WCAG …"*
geführt, nicht als bewiesener Verstoß (siehe `missingContext` der jeweiligen Regel;
WCAG 4.1.1 Parsing wurde in WCAG 2.2 entfernt).

Das ist die ehrliche Grenze: stoa meldet das Belegbare und zeigt, wo ein
**gerenderter/interaktiver (visueller) Schnitt** oder **menschliche Prüfung**
übernehmen muss.

## 8. Vorgeschlagene nächste Schritte

1. **Visueller Analyse-Schnitt** (Browser-Automatisierung) für den Kaskaden-/gerenderten Kontrast (über Inline-Paare hinaus) und sichtbaren Fokus — die größte verbleibende Abdeckungslücke und statisch wirklich nicht erreichbar. Als Konzept entworfen in [visual-analysis-layer.md](./visual-analysis-layer.md) (optional, umgebungsabhängig, vom deterministischen Kern getrennt); noch nicht gebaut.
2. **React/JSX** — erfolgt: Der TypeScript-Adapter durchläuft JSX und erzeugt dieselben Facts, sodass 11 der 14 Regeln auf `.jsx/.tsx` feuern, inklusive Namensberechnung (dynamikbewusst) und Kontrast aus style={{…}}-Objektliteralen. Die vier Dokument-/Cross-Element-Regeln bleiben HTML-only (App-Shell-/dynamische-id-Gründe). **Vue-SFC**-Templates sind ebenfalls für die 8 Attribut-/Kontrast-Regeln abgedeckt (geteilte Template-Extraktion mit Binding-Dialekt); **Angular** `*.component.html` ebenfalls.
3. **Tabellensemantik / Überschriftenordnung** nur, falls eine fehlalarmarme, kontextbewusste Formulierung gefunden wird — sonst dem visuellen Schnitt überlassen.

Nichts davon ändert stoas Haltung: Es benennt, was es beweisen kann, schätzt
vorsichtig und sagt klar, wo es nicht sehen kann.
