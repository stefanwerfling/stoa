# Umsetzungsstand

> Stand: 2026-10-27. Diese Seite beschreibt, was **tatsächlich implementiert** ist.
> Die übrigen `docs/`-Dokumente beschreiben die **Entwurfsabsicht** (Konzeptphase)
> und bleiben als Begründung gültig; wo die Umsetzung abweicht, zählt diese Seite.

## Realisierte Architektur

- **TypeScript-Kern** (Variante B), deterministisch, ohne LLM lauffähig.
- **Sprachadapter:** TypeScript/JavaScript (via `ts-morph` / TS-Compiler-API),
  **PHP** (via `php-parser`/glayzzle, rein in-process — kein Subprozess) und
  **Dart/Flutter** und **C/C++** (beide via tree-sitter / `web-tree-sitter`,
  WASM, in-process; Metrik-/Komplexitäts-Facts, Fehlerbehandlung bei Dart und
  C++ — C hat kein try/catch).
- **UI/UX-Adapter (HTML):** statische Barrierefreiheits-Analyse via
  tree-sitter-html (WASM, in-process). Rein statisch — kein Rendering, keine
  CSS-Kaskade. Textkontrast wird **nur** aus Farben geprüft, die gemeinsam im
  Inline-style eines Elements stehen (ein belegbarer Fakt); Kaskaden-/gerenderter
  Kontrast bleibt out-of-scope (siehe Grenzen). Erster vertikaler Schnitt des
  UI/UX-Bereichs.
- **UI/UX (React/JSX):** Der TypeScript-Adapter durchläuft zusätzlich JSX-Elemente
  (ts-morph, derselbe Parse) und erzeugt dieselben `ui.*`-Facts, sodass **11 der
  A11y-Regeln** auf `.jsx/.tsx`-Intrinsics feuern — inklusive der
  Namensberechnungs-Regeln (Control-/Link-Name, Formular-Label) und Kontrast aus
  `style={{…}}`-Objektliteralen. Dynamische
  Attributwerte (`{expr}`) und dynamische Kinder (`{label}`) gelten als
  vorhanden-aber-unbekannt, ein Spread (`{...props}`) sowie eine dynamische
  `id`/`type` unterdrücken die betroffenen Prüfungen, und React-Komponenten
  (`<Button/>`) werden übersprungen — alles zur Vermeidung von Fehlalarmen.
- **UI/UX (Vue SFC):** `.vue`-Templates sind HTML-artiges Markup (tree-sitter-html,
  geteilter Parser), sodass **8 der A11y-Regeln** (die attributbasierten +
  Kontrast) auf dem `<template>`-Abschnitt feuern, nachdem Vue-Bindings normalisiert
  wurden — `:x`/`v-bind:x` und `{{…}}` gelten als vorhanden-aber-unbekannt,
  `@x`/`v-on`/andere `v-`-Direktiven werden verworfen, Komponenten und
  `<script>`/`<style>` nicht analysiert. Die Namensberechnungs-Regeln sind für
  Templates noch nicht portiert.
- **UI/UX (Angular):** externe `*.component.html`-Templates nutzen dieselbe
  Template-Extraktion mit Angular-Binding-Dialekt — `[alt]`/`[attr.aria-label]`
  (und `bind-`) gelten als vorhanden-aber-unbekannt, `(event)`/`[(two-way)]`/`*ngIf`/`#ref`
  werden verworfen. Der Angular-Adapter wird vor dem HTML-Adapter registriert,
  damit `.component.html` nicht als Plain-HTML behandelt wird. Inline-`template:`-Strings
  sind noch nicht abgedeckt.
- **UI/UX (Flutter/Dart):** Flutter kennt kein HTML/ARIA — Barrierefreiheit hängt an
  Widget-Eigenschaften. Der Dart-Adapter durchläuft daher zusätzlich den Widget-Baum
  (derselbe tree-sitter-Parse) und erzeugt drei bewusst konservative, fehlalarmarme
  Facts: ein `Image*` ohne `semanticLabel:` **und** ohne `excludeFromSemantics: true`,
  ein `IconButton` ohne `tooltip:`, sowie ein `TextField`/`TextFormField`, dessen
  `InputDecoration` kein Label/Hint trägt (oder das gar kein `decoration:` hat).
  Geprüft werden nur die **eigenen** Konstruktor-Argumente des Widgets — ein
  umschließendes `Semantics(...)`, ein Label auf einem Kind-Widget oder eine anderswo
  (Variable, `copyWith`) gebaute Decoration wird nicht aufgelöst (im `missingContext`
  vermerkt), damit die Prüfungen konservativ bleiben.
- **Pipeline:** Ingestion → Fact-Extraktion → Regel-Engine → Befunde → Reporter.
  Keine Uhr/kein Zufall/kein Netz im Kern; gleiche Eingabe + Versionen + Sprache ⇒
  byte-identische Befunde.
- **Optionale, abschaltbare Schichten:** Typprüfer-Facts (`--typecheck`),
  tote-Export-Analyse (`--dead-exports`), LLM-Deutung (`--semantic anthropic`).

## CLI

```
stoa analyze <pfad> [--format markdown|json|sarif] [--lang en|de]
                    [--include <glob>]... [--exclude <glob>]...
                    [--typecheck] [--dead-exports] [--semantic noop|anthropic]
                    [--config <datei>] [--knowledge <dir>] [--rules <dir>]
stoa eval <pfad> --expected <datei> [--format markdown|json]
```

- **Formate:** Markdown (Mensch), JSON (Maschine), SARIF 2.1.0 (CI/Code Scanning).
- **Sprachen:** `en` (Default) und `de`; Regel-/Prinzip-Texte, Reporter-Labels und
  Dimensionsnamen sind über `LocalizedText` lokalisiert (en-Fallback).
- **Dateiauswahl:** `include`/`exclude`-Globs (picomatch); `node_modules`/`.git`
  werden hart übersprungen; eine einzeln benannte Datei umgeht die Globs.
- `knowledge/` und `rules/` werden relativ zum installierten Paket aufgelöst —
  die CLI läuft nach `npm link`/Install aus jedem Verzeichnis.

## Regelkatalog (38)

Deklarative Regeln (`rules/default/*.json`), Default aktiv:

| Regel | Prinzip | Dimension | Sprachen |
|-------|---------|-----------|----------|
| R-COMPLEXITY-COGNITIVE | marcus.simplicity | Komplexität | TS, PHP, Dart, C/C++ |
| R-DEEP-NESTING | marcus.simplicity | Komplexität | TS, PHP, Dart, C/C++ |
| R-FN-TOO-MANY-PARAMS | marcus.purpose | Verantwortungsgrenzen | TS, PHP, Dart, C/C++ |
| R-WIDE-PUBLIC-SURFACE | marcus.purpose | Verantwortungsgrenzen | TS/JS |
| R-ERR-SWALLOWED | marcus.obstacle | Fehlerbehandlung | TS, PHP, Dart, C++ |
| R-SIDEEFFECT-NONDETERMINISM | marcus.control | Seiteneffekt-Kontrolle | TS, PHP, Dart, C/C++ |
| R-DEP-UNUSED | marcus.cooperation | Abhängigkeiten | TS, PHP |
| R-DEEP-IMPORT | marcus.cooperation | Abhängigkeiten | TS, PHP |
| R-TYPE-UNSOUND | marcus.judgment | Belegbarkeit, Robustheit | TS (opt-in `--typecheck`) |
| R-FLOATING-PROMISE | marcus.obstacle | Fehlerbehandlung, Robustheit | TS (opt-in `--typecheck`) |
| R-ORM-SYNCHRONIZE-ENABLED | marcus.control | Seiteneffekt-Kontrolle, Robustheit | TS/JS |
| R-ORM-SYNC-WITH-MIGRATIONS | marcus.judgment | Belegbarkeit, Robustheit | TS/JS |
| R-ORM-ENTITY-NO-PK | marcus.judgment | Robustheit, Belegbarkeit | TS/JS, PHP (`@Entity` / `#[ORM\Entity]`) |
| R-ORM-EAGER-RELATION | marcus.control | Seiteneffekt-Kontrolle, Robustheit | TS/JS, PHP (`@Entity`-Relationen) |
| R-ORM-NULLABLE-NO-DEFAULT | marcus.obstacle | Robustheit, Fehlerbehandlung | TS/JS, PHP (NOT-NULL-Add im `up()`) |
| R-MIGRATION-UNGUARDED-DDL | marcus.obstacle | Robustheit, Fehlerbehandlung | TS/JS, PHP (nur Migrationsdateien) |
| R-MIGRATION-NO-DOWN | marcus.judgment | Robustheit, Belegbarkeit | TS/JS, PHP (nur Migrationsdateien) |
| R-MIGRATION-DATA-LOSS | marcus.judgment | Robustheit, Belegbarkeit | TS/JS, PHP (Drops im `up()`) |
| R-A11Y-IMG-ALT | marcus.purpose | Barrierefreiheit | HTML, JSX, Vue, Angular (statisch, WCAG 1.1.1) |
| R-A11Y-CONTROL-NAME | marcus.purpose | Barrierefreiheit, Bedienbarkeit | HTML, JSX (statisch, WCAG 4.1.2) |
| R-A11Y-FORM-LABEL | marcus.purpose | Barrierefreiheit, Bedienbarkeit | HTML, JSX (statisch, WCAG 1.3.1/4.1.2) |
| R-A11Y-LINK-NAME | marcus.purpose | Barrierefreiheit, Bedienbarkeit | HTML, JSX (statisch, WCAG 2.4.4/4.1.2) |
| R-A11Y-ARIA-HIDDEN-FOCUSABLE | marcus.cooperation | Barrierefreiheit, Bedienbarkeit | HTML, JSX, Vue, Angular (statisch, WCAG 4.1.2) |
| R-A11Y-ARIA-INVALID-ROLE | marcus.purpose | Barrierefreiheit | HTML, JSX, Vue, Angular (statisch, WCAG 4.1.2) |
| R-A11Y-ARIA-UNKNOWN-ATTR | marcus.purpose | Barrierefreiheit | HTML, JSX, Vue, Angular (statisch, WCAG 4.1.2) |
| R-A11Y-ARIA-INVALID-VALUE | marcus.purpose | Barrierefreiheit | HTML, JSX, Vue, Angular (statisch, WCAG 4.1.2) |
| R-A11Y-POSITIVE-TABINDEX | marcus.cooperation | Barrierefreiheit, Bedienbarkeit | HTML, JSX, Vue, Angular (statisch, WCAG 2.4.3) |
| R-A11Y-HTML-LANG | marcus.purpose | Barrierefreiheit | HTML (statisch, WCAG 3.1.1) |
| R-A11Y-META-VIEWPORT-ZOOM | marcus.cooperation | Barrierefreiheit, Bedienbarkeit | HTML (statisch, WCAG 1.4.4) |
| R-A11Y-ARIA-DANGLING-IDREF | marcus.purpose | Barrierefreiheit | HTML (statisch, WCAG 1.3.1/4.1.2) |
| R-A11Y-DUPLICATE-ID | marcus.purpose | Barrierefreiheit | HTML (statisch, WCAG 1.3.1/4.1.2) |
| R-A11Y-FRAME-TITLE | marcus.purpose | Barrierefreiheit, Bedienbarkeit | HTML, JSX, Vue, Angular (statisch, WCAG 4.1.2) |
| R-A11Y-CONTRAST-TEXT | marcus.cooperation | Barrierefreiheit, Bedienbarkeit | HTML, JSX, Vue, Angular (Inline-Farben, WCAG 1.4.3) |
| R-A11Y-FLUTTER-IMAGE-LABEL | marcus.purpose | Barrierefreiheit | Flutter/Dart (Widget, `semanticLabel`/`excludeFromSemantics`) |
| R-A11Y-FLUTTER-ICONBUTTON-LABEL | marcus.purpose | Barrierefreiheit, Bedienbarkeit | Flutter/Dart (Widget, `tooltip`) |
| R-A11Y-FLUTTER-TEXTFIELD-LABEL | marcus.purpose | Barrierefreiheit, Bedienbarkeit | Flutter/Dart (Widget, `InputDecoration.labelText`) |

Prozedurale Regeln (`ProjectRule`, cross-file):

| Regel | Prinzip | Dimension | Hinweis |
|-------|---------|-----------|---------|
| R-DEP-CYCLE | marcus.cooperation | Abhängigkeiten | Tarjan-SCC über relative Importe; type-only-Importe übersprungen |
| R-UNUSED-EXPORT | marcus.cooperation | Abhängigkeiten | opt-in `--dead-exports`; nur bei Ganzprojekt-Scans sinnvoll |

Alle zehn Qualitätsdimensionen (inkl. Barrierefreiheit, Bedienbarkeit) haben
mindestens eine Regel.

## Erzeugte Facts

`file.lineCount`, `metric.exportCount`, `metric.cyclomaticComplexity`,
`metric.cognitiveComplexity`, `metric.nestingDepth`, `metric.parameterCount`,
`metric.functionLength`, `doc.hasComplexityRationale`, `ast.usesNondeterminism`,
`ast.emptyCatch`, `ast.catchSwallowsError`, `deps.import`, `deps.importUnused`,
`deps.importDeep`, `deps.export`, `deps.importName`, `orm.synchronizeEnabled`,
`orm.syncWithMigrations`, `orm.entityNoPrimaryKey`, `orm.eagerRelation`,
`migration.unguardedDdl`, `migration.noDown`, `migration.dataLoss`,
`migration.nullableNoDefault`, `ui.imageMissingAlt`, `ui.controlMissingName`,
`ui.controlMissingLabel`, `ui.linkMissingName`, `ui.ariaHiddenFocusable`,
`ui.invalidRole`, `ui.unknownAriaAttribute`, `ui.invalidAriaValue`,
`ui.positiveTabindex`, `ui.documentMissingLang`, `ui.viewportBlocksZoom`,
`ui.danglingAriaIdref`, `ui.duplicateId`, `ui.frameMissingTitle`,
`ui.lowContrastText`, `ui.flutterImageNoSemanticLabel`,
`ui.flutterIconButtonNoTooltip`, `ui.flutterTextFieldNoLabel`, sowie (opt-in)
`external.tsc` und `external.floatingPromise`.

## Qualitätssicherung

- **147 node:test-Fälle** grün (Regeln pos./neg., Extraktion, Schema-Validierung,
  i18n, Determinismus, SARIF, Eval, Semantik-Groundedness, Datenschutz,
  Finding-Trennung).
- **Golden-Korpus** (`test/corpus/`, **nur TS+PHP**) mit Ground-Truth; Eval
  derzeit **Precision 100 % · Recall 100 %** (TP 44) mit sprachbezogener
  Aufschlüsselung (`byLanguage`). Precision-Gate je Regel (AC-5). Dart und C/C++
  werden durch **Adaptertests** abgedeckt, noch **nicht** durch den Golden-Korpus.
- **Wichtig:** Diese Werte gelten nur für den kleinen, kuratierten Korpus und
  sind **keine** allgemeine Zuverlässigkeitsgarantie für beliebige Projekte.
- **UI/UX-Korpus** (`test/fixtures/html/`, statisches HTML) mit positiven,
  negativen und legitim-nicht-warnenden Fällen; Eval 100 %/100 % (TP 37) je Regel.
  Semantische (LLM-)Bewertung wird getrennt gehalten und ist hier nicht verlangt.
- **JSX-Korpus** (`test/fixtures/jsx/`): die elf portierten A11y-Regeln auf
  React/JSX-Intrinsics; 100 %/100 % (TP 14), mit Positiv-, Dynamikwert-/-Kinder-,
  Spread-, Wrapping-Label-, htmlFor-, Style-Objekt-, Komponenten- und Clean-Fällen.
- **Vue-Korpus** (`test/fixtures/vue/`): die acht portierten A11y-Regeln auf einem
  `.vue`-Template; 100 %/100 % (TP 8), mit Bindings (`:`/`v-bind`/`@`), `{{…}}`,
  einem dynamischen `:style`, einem `<style>`-Block und einer Komponente, plus
  einer Clean-Komponente.
- **Angular-Korpus** (`test/fixtures/angular/`): die acht portierten A11y-Regeln auf
  einer `*.component.html`; 100 %/100 % (TP 8), mit `[x]`/`[attr.x]`/`(event)`/`*ngIf`-Bindings
  und einem dynamischen `[style.color]`, plus einem Clean-Template — und einem Test,
  dass der Angular-Dialekt (nicht Plain-HTML) lief.
- **Flutter-Korpus** (`test/fixtures/flutter/`): die drei Widget-A11y-Regeln auf
  einem Dart-Widget-Baum; 100 %/100 % (TP 5), mit `Image.network`/`Image(...)` ohne
  Label, einem `IconButton` ohne `tooltip`, einem `TextField()` ohne Decoration und
  einem mit label-loser `InputDecoration`, sowie Negativfällen (vorhandenes
  `semanticLabel`, `excludeFromSemantics: true`, `tooltip`, `labelText`, `hintText`,
  Variablen-Decoration) und einem Clean-Widget.
- Dogfooding: stoa analysiert den eigenen `src/`.

## Abweichungen vom Konzept (bewusst, dokumentiert)

- **PHP-Parser:** `php-parser`/glayzzle (rein JS, in-process) statt eines
  `nikic/php-parser`-Subprozesses (OQ-3) — deterministisch & testbar.
- **Typprüfer/floating promises:** in-process über die TS-Compiler-API statt eines
  ESLint-Subprozesses — gleiche Prüfung, kein fragiler externer Prozess.
- **Mehrsprachigkeit:** `LocalizedText`-Felder in Regeln/Prinzipien + i18n-Tabelle.
- **include/exclude:** jetzt wirksam (war in M1 noch vereinfacht).
- **Dart/C/C++ via tree-sitter:** `web-tree-sitter` (WASM, in-process,
  deterministisch) statt nativer Bindings/Subprozesse — konsistent mit dem
  glayzzle-Prinzip; die vorgebauten `tree-sitter-{dart,c,cpp}.wasm` vermeiden
  einen emscripten-Build.

## Noch offen

Weitere Dart-/C-/C++-Facts (Imports/Deps); Baseline-/Suppression-Workflow;
Diff-/PR-Modus; PSR-4-Auflösung, damit R-DEP-CYCLE/R-UNUSED-EXPORT auch PHP
abdecken; generischer ESLint-Fact-Adapter; Kontext-Facts
(`flag.generatedCode`, `hasTests`) für reichhaltigere Suppression;
LLM-Ausgabe-Evaluierung im Maßstab.

**UI/UX — Grenzen und Geplantes:** Rein statische Analyse. Farbkontrast
(WCAG 1.4.3) wird nur im belegbaren Inline-Fall geprüft (beide Farben am
Element); der **Kaskaden-/gerenderte** Kontrast — vererbte oder Stylesheet-Farben,
Bilder/Verläufe hinter Text, transluzente Farben — ist statisch **nicht**
entscheidbar. Ebenso **nicht** zuverlässig prüfbar und daher ausgelassen:
sichtbarer Fokus, Fokusreihenfolge/-fallen (über das statische
positive-tabindex-Signal hinaus), Zielgrößen, dynamische Zustände — sie brauchen
gerenderte Seiten/Interaktion (geplanter visueller Analyse-Schnitt mit
Browser-Automatisierung). **React/JSX** ist für 10 der 14 Regeln abgedeckt (über
den JSX-Walk des TS-Adapters), inklusive der Namensberechnungs-Regeln
(Control-/Link-Name, Formular-Label) mit dynamikbewusster Namensauflösung. Die
vier Dokument-/Cross-Element-Regeln (`-HTML-LANG`, `-META-VIEWPORT-ZOOM`,
`-ARIA-DANGLING-IDREF`, `-DUPLICATE-ID`) sind für JSX **nicht** portiert:
`<html lang>` und `<meta viewport>` liegen in der App-Shell (z. B. einem
Next.js-`_document`/`Head`, nicht im Komponenten-JSX), und id/idref-Auflösung über
Komponenten mit dynamischen ids ist statisch nicht zuverlässig. **Vue SFC** ist
für die 8 Attribut-/Kontrast-Regeln abgedeckt (geteilte Template-Extraktion mit
Vue-Binding-Dialekt); **Angular** externe `*.component.html`-Templates nutzen sie
mit einem Angular-Dialekt (`[x]`/`[attr.x]`/`(x)`/`*ngX`). **Flutter/Dart** wird
nicht über Markup, sondern über den Widget-Baum geprüft (drei widget-eigene Checks:
`Image`-`semanticLabel`/`excludeFromSemantics`, `IconButton`-`tooltip`,
`TextField`/`TextFormField`-`InputDecoration.labelText`) — ohne Auflösung
umschließender `Semantics(...)`-Wrapper. Nächste statische
Schritte: Inline-Angular-`template:`-Strings und Vue/Angular-Namensberechnungs-Regeln;
weitere ARIA-Prüfungen (z. B. `aria-*`-Attribute, die für die Rolle des Elements
ungültig sind). (Umgesetzt: `R-A11Y-FORM-LABEL`, `R-A11Y-LINK-NAME`,
`R-A11Y-ARIA-HIDDEN-FOCUSABLE`, `R-A11Y-ARIA-INVALID-ROLE`,
`R-A11Y-ARIA-UNKNOWN-ATTR`, `R-A11Y-ARIA-INVALID-VALUE`,
`R-A11Y-POSITIVE-TABINDEX`, `R-A11Y-HTML-LANG`, `R-A11Y-META-VIEWPORT-ZOOM`,
`R-A11Y-ARIA-DANGLING-IDREF`, `R-A11Y-DUPLICATE-ID`, `R-A11Y-FRAME-TITLE`.)
