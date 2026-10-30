# Umsetzungsstand

> Stand: 2026-10-31. Diese Seite beschreibt, was **tatsächlich implementiert** ist.
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
  Geprüft werden die **eigenen** Konstruktor-Argumente des Widgets **plus** ein
  umschließendes `Semantics(label: …)`, das den Teilbaum benennt (ein Widget darin
  wird nicht gemeldet). Ein Label auf einem Kind-Widget, ein Name via
  `Semantics(value:/hint:)`/`MergeSemantics` oder eine anderswo (Variable,
  `copyWith`) gebaute Decoration wird nicht aufgelöst (im `missingContext` vermerkt),
  damit die Prüfungen konservativ bleiben.
- **Pipeline:** Ingestion → Fact-Extraktion → Regel-Engine → Befunde → Reporter.
  Keine Uhr/kein Zufall/kein Netz im Kern; gleiche Eingabe + Versionen + Sprache ⇒
  byte-identische Befunde.
- **Optionale, abschaltbare Schichten:** Typprüfer-Facts (`--typecheck`),
  tote-Export-Analyse (`--dead-exports`), LLM-Deutung (`--semantic anthropic`).

## CLI

```
stoa analyze <pfad> [--format markdown|json|sarif] [--lang en|de]
                    [--include <glob>]... [--exclude <glob>]...
                    [--typecheck] [--dead-exports] [--contracts <datei>]
                    [--semantic noop|anthropic]
                    [--config <datei>] [--knowledge <dir>] [--rules <dir>]
stoa eval <pfad> --expected <datei> [--format markdown|json] [--contracts <datei>]
                    [--knowledge <dir>] [--rules <dir>]
```

- **Formate:** Markdown (Mensch), JSON (Maschine), SARIF 2.1.0 (CI/Code Scanning).
- **Sprachen:** `en` (Default) und `de`; Regel-/Prinzip-Texte, Reporter-Labels und
  Dimensionsnamen sind über `LocalizedText` lokalisiert (en-Fallback).
- **Dateiauswahl:** `include`/`exclude`-Globs (picomatch); `node_modules`/`.git`
  werden hart übersprungen; eine einzeln benannte Datei umgeht die Globs.
- `knowledge/` und `rules/` werden relativ zum installierten Paket aufgelöst —
  die CLI läuft nach `npm link`/Install aus jedem Verzeichnis.
- `--contracts <datei>` wird von BEIDEN, `analyze` und `eval`, akzeptiert
  (zuvor von `eval` stillschweigend ignoriert) — ein fehlerhafter/unlesbarer
  Vertrag schlägt bei beiden Befehlen sofort fehl (Exit 1), nie ein
  stillschweigend verschlechtertes Ergebnis.

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
| R-VALIDATION-MISSING-BACKEND | marcus.judgment | Robustheit | TS/JS (Server-Handler liest `req`/`request` `.body`/`.query` ohne erkennbare Validierung; Risiko-Signal) |
| R-VALIDATION-MASS-ASSIGNMENT | marcus.judgment | Robustheit | TS/JS (rohe Payload fließt ganz in `Object.assign`/Persistenz-Aufruf; Risiko-Signal) |
| R-A11Y-IMG-ALT | marcus.purpose | Barrierefreiheit | HTML, JSX, Vue, Angular (statisch, WCAG 1.1.1) |
| R-A11Y-CONTROL-NAME | marcus.purpose | Barrierefreiheit, Bedienbarkeit | HTML, JSX (statisch, WCAG 4.1.2) |
| R-A11Y-FORM-LABEL | marcus.purpose | Barrierefreiheit, Bedienbarkeit | HTML, JSX (statisch, WCAG 1.3.1/4.1.2) |
| R-A11Y-LINK-NAME | marcus.purpose | Barrierefreiheit, Bedienbarkeit | HTML, JSX (statisch, WCAG 2.4.4/4.1.2) |
| R-A11Y-ARIA-HIDDEN-FOCUSABLE | marcus.cooperation | Barrierefreiheit, Bedienbarkeit | HTML, JSX, Vue, Angular (statisch, WCAG 4.1.2) |
| R-A11Y-ARIA-INVALID-ROLE | marcus.purpose | Barrierefreiheit | HTML, JSX, Vue, Angular (statisch, verwandt: WCAG 4.1.2) |
| R-A11Y-ARIA-UNKNOWN-ATTR | marcus.purpose | Barrierefreiheit | HTML, JSX, Vue, Angular (statisch, verwandt: WCAG 4.1.2) |
| R-A11Y-ARIA-INVALID-VALUE | marcus.purpose | Barrierefreiheit | HTML, JSX, Vue, Angular (statisch, verwandt: WCAG 4.1.2) |
| R-A11Y-POSITIVE-TABINDEX | marcus.cooperation | Barrierefreiheit, Bedienbarkeit | HTML, JSX, Vue, Angular (statisch, WCAG 2.4.3) |
| R-A11Y-HTML-LANG | marcus.purpose | Barrierefreiheit | HTML (statisch, WCAG 3.1.1) |
| R-A11Y-META-VIEWPORT-ZOOM | marcus.cooperation | Barrierefreiheit, Bedienbarkeit | HTML (statisch, WCAG 1.4.4) |
| R-A11Y-ARIA-DANGLING-IDREF | marcus.purpose | Barrierefreiheit | HTML (statisch, WCAG 1.3.1/4.1.2) |
| R-A11Y-DUPLICATE-ID | marcus.purpose | Barrierefreiheit | HTML (statisch, verwandt: WCAG 1.3.1/4.1.2) |
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
| R-VALIDATION-CONTRACT-INVALID-ID | marcus.purpose | Robustheit | opt-in `--contracts <datei>`; `stoa:validation`-Annotation entspricht nicht dem Trace-ID-Format |
| R-VALIDATION-CONTRACT-UNKNOWN-ID | marcus.purpose | Robustheit | opt-in `--contracts`; gültige ID, aber nicht im geladenen Vertrag |
| R-VALIDATION-CONTRACT-UNRESOLVED | marcus.judgment | Robustheit, Belegbarkeit | opt-in `--contracts`; Konstrukt nicht als skalare Zod-Kette auswertbar (Insufficient Evidence) |
| R-VALIDATION-CONTRACT-MISMATCH | marcus.judgment | Robustheit | opt-in `--contracts`; extrahierte Bedingungen widersprechen dem Vertrag |
| R-VALIDATION-CONTRACT-CONFLICT | marcus.judgment | Robustheit | opt-in `--contracts`; gleiche Trace-ID, widersprüchliche Implementierungen |
| R-VALIDATION-CONTRACT-NOT-IMPLEMENTED | marcus.judgment | Robustheit, Belegbarkeit | opt-in `--contracts`; Vertragseintrag ohne jede Annotation (niedrige Konfidenz, kein Abwesenheitsbeweis) |
| R-VALIDATION-CONTRACT-UNUSED-VALIDATOR | marcus.obstacle | Robustheit | opt-in `--contracts`; annotierter, auflösbarer Validator wird nirgends in der Datei aufgerufen |
| R-VALIDATION-CONTRACT-RAW-AFTER-VALIDATION | marcus.judgment | Robustheit | opt-in `--contracts`; Validator mit Request-Daten aufgerufen, aber eine rohe Kopie der Payload erreicht trotzdem eine Persistenz-Senke in derselben Funktion |
| R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED | marcus.judgment | Robustheit, Belegbarkeit | opt-in `--contracts`; der validierte Wert wird an einen business-/persistenz-klingenden Aufruf übergeben, den Stoa innerhalb der Datei nicht auflösen kann |
| R-VALIDATION-CONTRACT-LAYER-UNRESOLVED | marcus.judgment | Robustheit, Belegbarkeit | opt-in `--contracts`; der Vertrag behauptet die Backend-Schicht, doch keine Implementierung wurde nachweislich mit Request-Daten gefüttert |
| R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED | marcus.judgment | Robustheit, Belegbarkeit | opt-in `--contracts`; der Vertrag verlangt `security.serverSideValidation`, doch keine Implementierung wurde nachweislich mit Request-Daten gefüttert |
| R-VALIDATION-CONTRACT-SAFEPARSE-UNGUARDED | marcus.judgment | Robustheit, Belegbarkeit | opt-in `--contracts`; `.data` eines `.safeParse()`-Ergebnisses wird ohne nachgewiesene `result.success`-Prüfung verwendet |

Alle zehn Qualitätsdimensionen (inkl. Barrierefreiheit, Bedienbarkeit) haben
mindestens eine Regel.

## Validation Trace IDs & Contract-Verifikation (erster vertikaler Schnitt)

Opt-in via `stoa analyze <pfad> --contracts <vertragsdatei.json>`; ohne diese
Option ist das Feature **vollständig inert** (Annotationen werden zwar immer
als Facts extrahiert — billig, analog zum bestehenden
`stoa:allow-complexity`-Marker —, aber nie interpretiert). Ein manipulierter
oder fehlender Vertrag schaltet keine anderen Prüfungen ab und verbessert
keinen Status; ein fehlerhafter Vertrag — einschließlich doppelter Regel-IDs
**innerhalb** des Vertrags, die über das JSON-Schema hinaus geprüft werden —
schlägt sofort fehl (Exit 1, konkrete Fehler), statt stillschweigend 0 Befunde
zu liefern.

- **Validation Trace ID:** eine stabile, projekteigene fachliche ID (z. B.
  `VC-ITEM-QUANTITY-001`; Format `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+-[0-9]{3}$`,
  siehe `schemas/validation-contract.schema.json`). Sie ist ein Analysehinweis,
  **kein** Sicherheitsmechanismus, und **nicht** mit Stoas eigenen `R-*`-Regel-,
  `finding:`- oder `fact:`-IDs zu verwechseln — deshalb tragen alle acht neuen
  Stoa-Regeln bewusst das Präfix `R-VALIDATION-CONTRACT-*` statt `R-VC-*`.
- **Annotation:** `// stoa:validation <ID>` als führender Kommentar auf einer
  `const x = …`-Anweisung (`src/analysis/typescript/ValidationAnnotations.ts`,
  `getLeadingCommentRanges()`, wie beim bestehenden Marker). **Nur
  TypeScript**, und nur eine direkte skalare Zod-Kette
  (`z.number()`/`z.string()`/`z.boolean()`/`z.enum([...])`) wird aufgelöst.
  Jeder erkannte Modifier hat eine **explizit modellierte** Wirkung — keiner
  gilt stillschweigend als wirkungslos: `.int()` → `integer`; `.email()`/
  `.url()` → `format` — werden beide verkettet, bleiben alle unterschiedlichen
  Formate erhalten (Zod verknüpft jede Prüfung per UND, daher ist ein Vertrag,
  der eines davon verlangt, erfüllt, solange es in der erzwungenen Menge
  enthalten ist — nie überschrieben vom zuletzt verketteten Format-Modifier);
  `.positive()`/`.nonnegative()`/`.min()` werden ordnungsunabhängig zur
  striktesten Untergrenze verschärft (`.positive()` exklusiv,
  `.nonnegative()`/`.min()` inklusiv — unabhängig von der Kettenreihenfolge,
  nicht „letzter Modifier gewinnt"); `.max()` wird genauso zur kleinsten
  Obergrenze über beliebig viele verkettete Aufrufe verschärft; ein
  kombinierter Bereich ohne erfüllbaren Wert (z. B. `.min(10).max(5)`) gilt
  als **unresolved**, statt stillschweigend auf eine Grenze aufgelöst zu
  werden; `.optional()`/`.nullable()`;
  `.trim()`/`.toLowerCase()`/`.toUpperCase()`; `z.enum([...])` →
  `allowedValues` (nur bei reinen String-Literalen). Jeder andere Aufruf
  (Array-Schemas, ein vts-Schema, `.refine()`, `.transform()`, `.default()`,
  ein verketteter Aufruf nach `z.object({...})` wie `.strict()`/`.partial()`,
  …) gilt als **unresolved** — nie erraten. Ein bloßes `z.object({...})` —
  ohne verkettete Modifikatoren danach — wird zusätzlich **feldweise**
  aufgelöst: Stoa vergleicht das EINE vom Vertrag benannte Feld
  (`contractRule.field`) über dieselbe skalare Kettenauflösung, ohne den
  Rest der Objektform aufzulösen oder zu erraten. Ein vom Schema gar nicht
  deklariertes Feld, oder eines, dessen eigener Wert keine erkannte skalare
  Kette ist, bleibt namentlich unaufgelöst; ein auflösbares Feld wird genauso
  verglichen wie ein skalares Schema auf oberster Ebene. Das schließt die
  Lücke, dass jedes realistische `z.object(...)`-Request-Body-Schema — der
  häufige Fall — bedingungslos unaufgelöst war, unabhängig davon, ob sein
  eines relevantes Feld tatsächlich zum Vertrag passte.
- **Vertrag:** eine JSON-Datei nach `schemas/validation-contract.schema.json`
  (wiederverwendet das bestehende ajv2020-Muster aus
  `KnowledgeValidation.ts`, kein neues Format). Felder: `integer`, `format`
  (`email`/`url`), `allowedValues` (Menge, reihenfolgeunabhängig verglichen),
  neben den bestehenden `min`/`max`/`required`/`nullable`/`normalization`.
  Jedes Feld außer `id`/`description`/`field`/`dataType` ist optional —
  verglichen wird nur, was der Vertrag tatsächlich erklärt. IDs müssen
  **innerhalb eines Vertrags eindeutig** sein (über ajv hinaus geprüft; zwei
  Einträge mit derselben ID sind immer ein Vertragsfehler, selbst wenn ihre
  Bedingungen zufällig übereinstimmen — anders als der weichere, code-seitige
  CONFLICT-Befund für zwei abweichende *Implementierungen*).
- **Abgleich** (`src/rules/project/ValidationContractRule.ts`, ein
  `ProjectRule`, analog zu `R-DEP-CYCLE`/`R-UNUSED-EXPORT` — daher keine
  eigene JSON-Regeldatei, Text fest in TS, hier in der Tabelle dokumentiert):
  ungültiges ID-Format; ID nicht im Vertrag; Konstrukt nicht auswertbar;
  extrahierte Bedingungen widersprechen dem Vertrag (dataType/required/
  nullable/min/max/integer/format/allowedValues/normalization); dieselbe ID
  mit widersprüchlichen Implementierungen (symmetrisch — Stoa entscheidet
  nicht, welche Seite korrekt ist); ein Vertragseintrag ganz ohne Annotation
  (niedrige Konfidenz, verankert an der Vertragsdatei selbst, da keine
  Quelldatei zutrifft).
- **Validator-Nutzung** (`src/analysis/typescript/ValidatorUsage.ts`, neue
  Facts `validation.annotatedValidatorUnused` /
  `validation.rawReuseAfterValidation`): prüft nicht mehr nur die *Form* eines
  annotierten Schemas, sondern ob es überhaupt aufgerufen wird. Ein
  annotierter, auflösbarer Validator, dessen `.parse()`/`.safeParse()`
  nirgends in der Datei vorkommt, gilt als **unbenutzt**. Wird er mit
  Request-Daten aufgerufen (auch ein einzelnes herausgegriffenes Feld wie
  `req.body.quantity` zählt — anders als die strikte Ganz-Objekt-Prüfung der
  Mass-Assignment-Regel), aber dieselbe Funktion führt **zusätzlich** eine
  rohe Ganz-Objekt-Senke (`Object.assign`/Persistenz-Verb, dieselbe bereits
  gehärtete Erkennung wie `R-VALIDATION-MASS-ASSIGNMENT`) aus, gilt die
  Validierung als wirkungslos für das, was tatsächlich gespeichert wird. Beide
  Prüfungen sind **auf eine Datei bzw. eine Funktion begrenzt** — keine
  projektweite Datenflussanalyse; ein exportiertes, nur in einer anderen
  (eventuell nicht analysierten) Datei genutztes Schema sieht von hier aus
  identisch zu einem wirklich unbenutzten aus (dokumentierte Grenze, niedrige
  Konfidenz 0.5).
- **Evidence Graph & Validator-Datenflussanalyse** (`src/evidence/EvidenceGraph.ts`,
  `src/analysis/typescript/ValidationDataflow.ts`, neuer Fact
  `validation.dataflowGraph`): wohin der VALIDIERTE Wert nach einem
  Validator-Aufruf geht, nicht nur, ob der Aufruf stattfand — ein kleiner
  Graph pro Aufruf, immer extrahiert (kein Vertrag nötig), mit Node-Arten
  (`request-source`/`input-value`/`validation-schema`/
  `validator-invocation`/`validation-result`/`validated-value`/`function`/
  `service`/`repository`/`persistence-sink`) und Edge-Arten
  (`receives`/`validates`/`returns`/`assigns`/`passes-to`/`transforms`/
  `persists`/`bypasses`), jede Edge mit explizitem Status: `verified`
  (eine direkte Argument-Beziehung in derselben Funktion), `heuristic`
  (eine über eine Aufrufgrenze hinweg erschlossene Beziehung) oder
  `unresolved` (etwas Relevantes gefunden, die Beziehung aber nicht
  nachweisbar) — eine `heuristic`-Edge wird nie als `verified` ausgegeben.
  Zwei Fähigkeiten: eine Nachverfolgung innerhalb derselben Funktion bis zu
  einem Persistenz-Verb-Aufruf (`verified`), und EIN funktionsübergreifender
  Schritt — per ts-morph-Symbol aufgelöst, NUR INNERHALB DERSELBEN DATEI, zu
  einer Funktion/Methode mit einem einfachen (nicht destrukturierten)
  Parameter an der passenden Position — bis zu einem Persistenz-Verb-Aufruf
  im eigenen Rumpf dieser Deklaration (`heuristic`; die Form
  `userService.create(result.data)` → `UserService.create(data)` →
  `this.repository.save(data)`). Wird der validierte Wert an einen Aufruf
  übergeben, der namentlich nach einer Business-/Persistenzschicht klingt
  (`service`/`repository`/`repo`/`manager`/`store`), sich aber innerhalb der
  Datei nicht auflösen lässt (ein Import, ein dynamischer/berechneter
  Aufruf, ein Interface ohne eindeutige Implementierung), ist die Edge
  `unresolved` und erscheint — sofern die ID der Annotation im geladenen
  Vertrag bekannt ist — als `R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED`
  (niedrige Konfidenz, ausdrücklich „konnte nicht nachverfolgt werden",
  nie als Mangel behauptet). Alles andere (der Aufruf ist offensichtlich
  keine Senke, oder löst sich innerhalb der Datei zu etwas ohne jeden
  Persistenz-Aufruf auf) wird stillschweigend nicht gemeldet — nicht jeder
  validierte Wert muss in Persistenz enden. Keine dateiübergreifende
  Auflösung, keine destrukturierten/Rest-FUNKTIONSPARAMETER im One-Hop-Schritt,
  keine Spread-Argumente, keine Rekursion über einen Schritt hinaus, nur der
  ERSTE Aufruf, der den verfolgten Wert erhält, wird nachverfolgt.
- **Symbolbasierte Datenflussauflösung** (`src/analysis/typescript/SymbolResolution.ts`,
  eingebunden in `ValidationDataflow.ts` und `OneHopResolution.ts`): jede
  „ist das derselbe Wert"-Prüfung in den Datenfluss-Tracern löst über
  ts-morphs eigenen Binder auf (`Symbol`-Identität), nie über den Vergleich
  von Identifier-TEXT — zwei verschiedene Variablen, die sich zufällig
  dieselbe Schreibweise teilen (in einem verschachtelten Block verschattet,
  eine unabhängige gleichnamige lokale Variable anderswo in der Funktion),
  gelten nie als derselbe Wert. Behandelt: einen einfachen `const alias =
  tracked` (ein Schritt, begrenzte Tiefe, nur `const` — ein veränderlicher
  Alias wird nicht verfolgt, da er selbst vom verfolgten Wert weg neu
  zugewiesen werden könnte); Destrukturierung des validierten Ergebnisses
  (`const { data } = result` nach `.safeParse()`, zusätzlich zur bestehenden
  `result.data`-Property-Access-Form); einen validierten Wert, der als
  Argument an eine Funktion übergeben wird, dort über das Symbol des EIGENEN
  Parameters abgeglichen, nicht über dessen Schreibweise (der One-Hop-Fall).
  Eine Bindung, die IRGENDWO in ihrer umschließenden Funktion neu zugewiesen
  wird (überinklusiv gescannt — die sichere Richtung), gilt ab diesem Punkt
  nie mehr als weiterhin den validierten Wert tragend: die Nachverfolgung
  stoppt einfach (keine Edge), statt ohne echten Kontrollflussgraphen zu
  raten, welche Zuweisung „gewinnt". Noch nicht behandelt, als Lücke
  dokumentiert statt stillschweigend angenommen: die Nachverfolgung eines
  validierten Werts über eine `return`-Anweisung hinaus zu den Aufrufern der
  Funktion (die Nachverfolgung endet an der Funktionsgrenze, erkennt das
  `return` an, behauptet aber nichts darüber, was der Aufrufer damit tut).
- **safeParse()-Erfolgs-/Fehlerpfad-Verifikation** (`src/analysis/typescript/SafeParseGuard.ts`):
  der Zugriff auf `.data` nach `.safeParse()` ist für sich kein Beweis, dass
  er sicher ist — `.safeParse()` liefert eine diskriminierte Union, und
  `.data` ist erst solide, sobald `result.success` durch den umgebenden
  Kontrollfluss NACHWEISLICH wahr ist. Die `transforms`-Edge
  (Validierungs-Ergebnis → validierter Wert) spiegelt das jetzt wider, statt
  immer `verified` zu sein: `verified` nur für zwei solide Formen — eine
  Early-Exit-Absicherung (`if (!result.success) { throw/return/… }`, die
  unbedingt terminiert, sodass späterer Code im selben Block nur bei Erfolg
  läuft) oder eine verschachtelte positive Absicherung
  (`if (result.success) { …Zugriff… }`), jeweils kombinierbar mit weiteren
  Bedingungen via UND/ODER, solange die Kombination logisch solide bleibt
  (eine UND-kombinierte Ablehnung oder eine ODER-kombinierte Annahme ist
  NICHT solide und zählt nicht). Andernfalls `unresolved` — entweder
  referenziert nichts `result.success` überhaupt, oder etwas tut es, aber
  nicht solide — gemeldet (vertragsgebunden, wie seine Geschwister) als
  `R-VALIDATION-CONTRACT-SAFEPARSE-UNGUARDED` (mittlere Schwere, Konfidenz
  0.5: eine echte, nachweisbare Lücke, nicht nur „konnte nicht weiter
  nachverfolgt werden"). Stoa nimmt niemals Sicherheit an, nur weil IRGENDEINE
  Bedingung dem Zugriff zufällig vorausgeht.
- **Schicht- & Security-Zuordnung** (`ValidationContractRule.ts`): Die
  `layers`/`security`-Felder eines Vertrags sind eine BEHAUPTUNG, kein
  Beweis. Behauptet eine Regel die `backend`-Schicht, oder deklariert sie
  das eine strukturierte Security-Flag, das Stoa tatsächlich prüfen kann
  (`security.serverSideValidation`), nutzt Stoa denselben Beleg wie die
  Validator-Datenflussanalyse (ein `validation.dataflowGraph`-Fact existiert
  nur für einen nachweislich mit Request-Daten gefütterten Aufruf), um die
  Behauptung zu bestätigen; eine annotierte Implementierung, die nie
  nachweislich im Backend lief, ist `R-VALIDATION-CONTRACT-LAYER-UNRESOLVED`
  / `-SECURITY-UNVERIFIED` (niedrige Konfidenz). Eine reine
  `frontend`-Behauptung und die übrigen fünf `security`-Flags
  (`authenticationRequired`, `authorizationRequired`, `ownershipRequired`,
  `tenantIsolation`, `massAssignmentProtection`) werden akzeptiert und
  schema-validiert, erzeugen aber absichtlich KEINEN Befund — Stoa hat keine
  Session-/Auth-/Tenant-Modellierung, um sie zu prüfen, und ihr Fehlen in
  einer Befundliste darf niemals als „bestätigt erfüllt" gelesen werden.
- **Mass-Assignment-Erweiterungen** (`BackendValidation.ts`):
  `R-VALIDATION-MASS-ASSIGNMENT` erkennt nun auch eine DIREKTE
  Eigenschaftszuweisung, die ein Objekt tainted (`entity.data = req.body`,
  nicht nur ein `const x = req.body`-Alias — ein späteres `repo.save(entity)`
  wird genauso markiert), eine rohe Payload, die EINEN
  funktionsübergreifenden Schritt bis zu einem Persistenz-Verb-Aufruf
  durchläuft (nutzt denselben One-Hop-Resolver wie der Datenfluss-Tracer, in
  `OneHopResolution.ts`, geteilt, um dieselbe Mechanik nicht doppelt zu
  implementieren), sowie eine schmale ORM-spezifische Verb-Ergänzung,
  `merge` (TypeORM `repository.merge(entity, req.body)`) — nicht
  `preload`/`set`, zu generisch (Cache/Map/etc.), um sie ohne echte
  False-Positive-Kosten zu ergänzen. Ein einzelnes herausgegriffenes Feld
  über eine direkte Zuweisung bleibt außerhalb des Umfangs, ebenso wie die
  bestehende Einzelfeld-Einschränkung anderswo in dieser Regel.
- **Bewusst nicht in diesem Schnitt** (dokumentiert, nicht vorgetäuscht):
  Mehrfeld-Objekt-Schemas; cross-file-Nutzungsnachweis; API-Endpunkt-/
  Alternative-Endpunkt-Bypass-Erkennung; Schicht-Heuristik (Frontend/Backend)
  für den Konflikt-Check; strukturierte, maschinell geprüfte
  Backend-only-Sicherheitsanforderungen (`securityRequirements` bleibt
  Freitext, rein informativ — bewusst **nicht** als verifizierte
  Sicherheitsregel ausgegeben, siehe `ui-ux-analysis-report`-artige
  Zurückhaltung); andere Sprachen als TypeScript.
- Mit echtem Code geprüft: `stoa:validation` kommt in keinem der bisher
  verwendeten realen Repos vor (erwartungsgemäß, da projektspezifisch neu) —
  die Nutzungs-Tracing-Regeln konnten deshalb nur an eigens erstellten
  Fixtures, nicht an einem echten annotierten Projekt verifiziert werden
  (dokumentierte Grenze). Fakt-Extraktion lief ohne Crash/Regression gegen
  reale Zod-Nutzung (kapalium `backend/`+`shared/`, 37 Dateien — `shared/`
  exportiert Zod-Schemas cross-file, genau das riskante FP-Muster für die
  Unused-Validator-Prüfung) und gegen stoas eigenes `src/` (58 Dateien) — `0`
  Befunde ohne `--contracts` in allen Fällen, wie vorgesehen.

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
`ui.flutterIconButtonNoTooltip`, `ui.flutterTextFieldNoLabel`,
`validation.backendInputUnvalidated`, `validation.rawRequestMassAssignment`,
`validation.contractAnnotation`, `validation.annotatedValidatorUnused`,
`validation.rawReuseAfterValidation`, `validation.dataflowGraph`, sowie (opt-in) `external.tsc` und
`external.floatingPromise`.

## Qualitätssicherung

- **211 node:test-Fälle** grün (Regeln pos./neg., Extraktion, Schema-Validierung,
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
  einem Dart-Widget-Baum; 100 %/100 % (TP 6), mit `Image.network`/`Image(...)` ohne
  Label, einem `IconButton` ohne `tooltip`, einem `TextField()` ohne Decoration, einem
  mit label-loser `InputDecoration` und einem IconButton in label-losem `Semantics`,
  sowie Negativfällen (vorhandenes `semanticLabel`, `excludeFromSemantics: true`,
  `tooltip`, `labelText`, `hintText`, Variablen-Decoration, `IconButton.styleFrom` und
  je ein in `Semantics(label: …)` benanntes Image/IconButton/TextField) und einem
  Clean-Widget.
- **A11y-Korrektheits-Korpus** (`test/fixtures/a11y-correctness/`): Regressionstests
  für die Korrektheitsprüfung der Namens-/Fokus-/ARIA-Semantik über den echten
  Analysepfad (HTML, JSX, Vue). Fixiert: Text in `aria-hidden`-Subbäumen zählt nicht
  als Name; `aria-labelledby` wird in HTML gegen seine Ziele aufgelöst (leerer Wert,
  fehlende/leere Ziele → kein Name; Referenzketten mit Zyklus-Schutz); `role=presentation`
  nimmt ein fokussierbares Control nicht von der Namenspflicht aus; strikte
  tabindex-Prüfung und `contenteditable`-Fokus; Kontrast wird auch unter `aria-hidden`/
  `role=presentation` geprüft (Text bleibt visuell sichtbar).
- **Backend-Validierungs-Korpus** (`test/fixtures/backend-validation/`): Positiv-
  (Handler liest `req.body`/`req.query` ohne Validierung; rohe Payload fließt in
  `Object.assign`/einen Persistenz-Aufruf — direkt oder gespreizt) und Negativfälle
  (Zod `.parse`, vts-Wrapper + `schema.validate`, manuelle 400-Prüfung,
  Fastify-Routen-Schema, nur-`params`, manuelles Allow-Listing). Ein Handler kann
  `R-VALIDATION-MISSING-BACKEND` erfüllen (lehnt Fehlform ab) und trotzdem
  `R-VALIDATION-MASS-ASSIGNMENT` auslösen (speichert die unangetastete rohe
  Payload) — beide Regeln decken getestet getrennte Fälle ab. Ein `throw`/
  400-artiger Abbruch zählt nur als Validierung, wenn die ihn absichernde
  Bedingung tatsächlich den Request referenziert (direkt, oder über einen
  strikten `const body = req.body`-Alias) — ein `throw`, der von einer
  unabhängigen Bedingung abhängt (z. B. einem DB-Lookup-Ergebnis, wie bei
  `if (!user) throw …`, wobei `user` von `repository.findById(...)` stammt),
  wird nicht mehr fälschlich als Input-Prüfung gewertet (Regressions-Fixture
  `unrelated-throw.ts`). Ein Validator, der nur über eine verifizierte
  AST-Beziehung erreicht wird — z. B. `const v = schema.safeParse.bind(schema)`
  — wird ebenfalls erkannt, selbst wenn sein eigener Name keiner
  Namensheuristik entspricht. Zusätzlich manuell
  gegen **fünf echte TS-Backends** geprüft (audiomesh, headbangbear — beide ein
  `{bodySchema}`-Wrapper-Muster; kapalium = Zod; helionet_pro = vts; loki =
  Express ohne Schema): `R-VALIDATION-MISSING-BACKEND` **0 FP** nach zwei
  Härtungsrunden (zuvor 29 Fehlalarme durch `params`-Lookups, ungesehene
  Wrapper-Schema-Optionen und Einzelfeld-Plucks); `R-VALIDATION-MASS-ASSIGNMENT`
  **1 Befund, verifiziertes TP** (loki: `req.body` nur auf `typeof === 'object'`
  geprüft, dann roh gespeichert), **0 FP** auf den übrigen vier.
- **Validierungs-/Datenfluss-Golden-Korpus** (`test/fixtures/validation-dataflow-corpus/`,
  `ValidationDataflowCorpus.test.ts`): ein eigenständiger, in sich
  geschlossener Korpus nach dem bestehenden `test/corpus/`-Precision/Recall-Muster
  (kein zweiter Ground-Truth-Mechanismus), der alle 16 explizit geforderten
  Testgruppen an einer Stelle abdeckt — korrekte Validierung, fehlende
  Validierung, ein unbenutzter Validator, ein aufgerufener, aber ignorierter
  Validator (rohe Wiederverwendung nach Validierung), eine in einer nie
  aufgerufenen Funktion deklarierte Validierung, funktionsübergreifende
  Übergaben (sowohl ein nachverfolgter, validierter guter Pfad als auch ein
  roher, unvalidierter schlechter Pfad), `.max()`-Merging, Format-UND-Merging,
  ein nicht auflösbarer Zod-Modifier, ein AST-verifizierter `.bind()`-Alias,
  eine vom Request unabhängige generische Exception, Mass Assignment über
  Spread, Security-Anforderungen, die Stoa nicht prüfen kann (geprüft, dass
  NICHTS erzeugt wird), sowie widersprüchliche FE/BE-Implementierungen unter
  einer Trace-ID. 100 %/100 % (TP 20). Der Bau dieses Korpus deckte einen
  echten Bug auf, bevor er sich weiter ausbreitete: Die Unused-Validator- und
  Raw-After-Validation-Prüfungen (`ValidatorUsage.ts`) teilten sich dasselbe,
  beim Datenfluss-Tracer bereits andernorts korrigierte Gate, das eine
  auflösbare skalare Form des Schemas verlangte — was ein `z.object(...)`-Request-Body
  (der realistische Fall) nie ist, wodurch beide Prüfungen für diesen Fall
  stillschweigend totgelegt waren; nur nackte Skalar-Schemas in den
  bestehenden Fixtures erreichten sie je. Genauso behoben wie die
  entsprechende Korrektur beim Datenfluss-Tracer.
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

**Cross-Layer-Validierung — Grenzen (erster vertikaler Schnitt):**
`R-VALIDATION-MISSING-BACKEND` (Kategorie „Missing Backend Validation") und
`R-VALIDATION-MASS-ASSIGNMENT` (Kategorie „Untrusted Property / Mass Assignment")
prüfen bewusst nur **eine** Schicht (Backend-Vertrauensgrenze), nicht die volle in
der Analysevision skizzierte Kette Frontend → API → Backend → Persistenz. Es gibt
**keine** Fakten zu Frontend-Formular-Constraints, API-Contracts/DTOs,
Zod-/vts-Schema-Wertebereichen oder Endpunkt-Datenfluss — ein echter
Frontend/Backend-*Constraint-Mismatch* (unterschiedliche Wertebereiche/
Pflichtfelder zwischen den Schichten) ist mit dem heutigen Faktenmodell **nicht**
belastbar erkennbar und wird nicht behauptet. Mass-Assignment ist zusätzlich auf
die statisch erkennbaren Senken `Object.assign` und Aufrufe mit
Persistenz-Verb-Namen (`save`/`create`/`update`/`insert`/`upsert`/`persist`/
`replace`) beschränkt; ob ein als Allow-List gedachtes Schema selbst zusätzliche
Schlüssel durchlässt (z. B. Zod `.passthrough()`), wird nicht geprüft. Nur
TypeScript/JavaScript; PHP/Dart-Backends sind nicht abgedeckt. Siehe
`missingContext` der jeweiligen Regel für die Erkennungsgrenzen innerhalb der
einen Schicht (z. B. `preValidation`-Hooks, globale Middleware).

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

**Zugänglicher Name — statische Annäherung:** Die Namensberechnung ist eine
konservative statische Näherung, **keine** Nachbildung des Browser-Accessibility-
Trees. Berücksichtigt werden: nicht-leeres `aria-label`; sichtbarer Textinhalt
**ohne** `aria-hidden`-Subbäume; verschachteltes `img[alt]`/`svg > title`; und —
nur in HTML — `aria-labelledby`, das gegen seine Ziele im selben Dokument aufgelöst
wird (leerer Wert, fehlende Ziele oder ausschließlich leere Zielinhalte zählen
**nicht** als Name; Referenzketten werden mit Zyklus-Schutz verfolgt). In JSX, Vue
und Angular werden `aria-labelledby`-Ziele mangels statisch auflösbarer Referenzen
**nicht** aufgelöst — ein nicht-leerer Wert gilt dort konservativ als Name (ein
leerer Wert nicht). Laufzeit-/dynamische Inhalte werden weder als bewiesener Fehler
noch als bewiesene Korrektheit gewertet. Fokusierbarkeit wird aus striktem
Integer-`tabindex`, `contenteditable` und nativer Interaktivität abgeleitet;
`role=presentation`/`none` entfernt ein Element **nicht** pauschal aus dem A11y-Tree
(auf einem fokussierbaren Control wird die Rolle ignoriert, ein dekoratives Bild
bleibt zulässig).

**Statische Auffälligkeit vs. WCAG-Verstoß:** Bei `R-A11Y-ARIA-UNKNOWN-ATTR`,
`-ARIA-INVALID-VALUE`, `-ARIA-INVALID-ROLE` und `-DUPLICATE-ID` ist der *statische
Fakt* bewiesen (unbekanntes Attribut, ungültiger Token, doppelte id), der konkrete
WCAG-Verstoß hängt aber vom Kontext ab. Die zugehörigen SC werden daher als
*verwandte Leitlinie* genannt (Message/Doku: „verwandt: WCAG …"), nicht als
bewiesener Verstoß; `missingContext` jeder Regel erläutert die Unterscheidung.
WCAG 4.1.1 (Parsing), das doppelte ids früher abdeckte, wurde in WCAG 2.2 entfernt.
