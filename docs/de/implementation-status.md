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
  C++ — C hat kein try/catch). **C/C++ erhält zusätzlich zwei
  Memory-Safety-Regeln** (`R-CPP-UNRELEASED-ALLOCATION`,
  `R-CPP-NEW-DELETE-MISMATCH` — siehe Regeltabelle unten) — die einzige
  Stelle im Regelkatalog, an der das eigene, unterscheidende Risiko einer
  Sprache (manuelle Speicherverwaltung) abgedeckt wird, statt nur der
  sprachneutralen Komplexitäts-/Fehlerbehandlungsregeln, die jeder Adapter
  bekommt.
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
- **Dart-Grundlagen (Flutter-Analyse, Phase 0b):** `src/analysis/dart/DartCallSite.ts`
  normalisiert jede Dart-Aufruf-/Instanzerzeugungsform — einen nackten Aufruf
  (tree-sitter-dart hat keinen Call-Knoten: primärer Identifier plus
  `selector`-Geschwister), `const`/`new`, Import-Prefixe (nur wenn die Datei sie per
  `import … as p` deklariert; `p.Foo(…)` vs. `Foo.named(…)` ist sonst syntaktisch
  mehrdeutig), benannte Konstruktoren und Typargumente — zu einem Datensatz, als
  Basis für die kommende Widget-Struktur-Extraktion. Seit Phase 4 auch von
  den Flutter-A11y-Prüfungen genutzt (siehe unten). `file.parseErrors`
  (ERROR- + MISSING-Knoten, nur bei > 0 erzeugt) macht sichtbar, dass
  tree-sitter-dart 1.0.0 kein Dart-3-Syntax kennt (Records, Patterns,
  Switch-Expressions, Klassenmodifikatoren): Eine solche Datei „parst“ trotzdem,
  Teile ihres Baums sind aber rekonstruiert. Keine Regel liest den Fact; der
  Coverage-Status bleibt unverändert. Der Grammatik fehlen außerdem erweiterte
  Enums (Dart 2.17: `enum E with M`, `implements`, Enum-Konstruktoren).
  `src/analysis/dart/DartDeclarations.ts` erzeugt die Eingaben für die spätere
  Widget-Identität: `dart.importSpec` pro Bibliotheks-Direktive (`import`/`export`/
  `part`/`part-of`; URI, Prefix, `deferred`, `show`/`hide`, konfigurierbare URIs) und
  `dart.classDecl` pro Klasse/Mixin/Enum (Oberklasse mit Prefix und Typargumenten,
  Mixins, Interfaces, `on` eines Mixins). Eine Deklaration, deren Kopf die Grammatik
  nicht parsen konnte, erzeugt keinen Fact statt eines womöglich falschen Namens.
  Bewusst weiterhin kein `deps.import` für Dart (das brächte Dart-Dateien in
  R-DEP-CYCLE/R-DEP-UNUSED — eine eigene Entscheidung). `dart.*`-Facts dienen der Identität (Widget-Graph, Flutter-Regeln), `dart.stateLifecycle` den Lifecycle-Regeln (Phase 3).
- **FlutterWidgetGraph (Flutter-Analyse, Phase 1):** `src/analysis/dart/FlutterWidgets.ts`
  extrahiert im einen AST-Durchlauf die Widget-Struktur jedes Funktions-/Methodenrumpfs
  als einen kompakten `ui.flutterWidgetTree`-Fact (Knotentabelle: Elternteil,
  Slot-Label, Index, Art, Name/Prefix/Konstruktor, Argumentnamen, Position, Status —
  kein Quelltext). `src/model/FlutterWidgetGraph.ts` baut den projektweiten Graphen
  nach der Extraktion allein aus Facts (identisch bei einem FactCache-Treffer, der nie
  neu parst) und reicht ihn über `ProjectRuleInput.flutterWidgetGraph` an
  Projektregeln; er ist nicht Teil von `AnalysisResult`; die Flutter-Layoutregeln
  (Phase 2, unten) lesen ihn. Knotenarten: `widget`, `reference` (Variable/Helper-Aufruf), `builder`
  (`*builder`-Closures, alle `return`-Pfade), `conditional` (`if`/Ternary), `repeat`
  (`for`), `spread`, `list`, `dynamic` (nicht modellierter Ausdruck), `unparsed`
  (tree-sitter konnte nicht parsen — z. B. Dart-3-Syntax; auf den betroffenen
  Slot/das Element begrenzt). Kind-Kanten folgen nur einem kuratierten Katalog von
  Widget-Slots (`child`, `children`, `body`, `appBar`, `title`, `actions`, …) und
  `*builder`-Closures; Callbacks (`onTap:`) sind keine Kinder — darin gebaute Widgets
  sind Wurzeln. Eine Wurzel ist ein Aufruf außerhalb eines Baums mit Slot-/Builder-
  Argument oder das, was eine `Widget`-Funktion zurückgibt. Identität je Widget:
  `verified` (in derselben Datei deklariert), `heuristic` (Import-Kandidaten nach
  Prefix/show/hide, aufgelistet), `unresolved` — nie allein über den Namen, und eine
  Flutter-Klasse ist nie `verified` (noch kein dateiübergreifender Bibliotheks-Index).
  Gemessen an einer Flutter-App mit 203 Dateien: 2733 Knoten, Tree-Facts 9,3 % aller
  Facts, Graph-Aufbau ~16 ms, Befunde byte-identisch.
- **Flutter-Layoutregeln (Flutter-Analyse, Phase 2):** vier `ProjectRule`s in
  `src/rules/project/FlutterLayoutRules.ts`, die ersten Konsumenten des Graphen —
  `R-FLUTTER-PARENTDATA-MISUSE`, `R-FLUTTER-UNBOUNDED-SCROLLABLE`,
  `R-FLUTTER-TEXTFIELD-UNBOUNDED-WIDTH`, `R-FLUTTER-NESTED-SCROLL-UNBOUNDED`
  (Layout-Ausnahmen zur Laufzeit, die `flutter analyze` nicht meldet). Ein Widget
  gilt nur bei `heuristic`-Identität mit einem `package:flutter/`-Import-Kandidaten
  als Framework-Widget (eine Deklaration in derselben Datei verdeckt es). Der
  effektive Elternteil wird nur über `conditional`/`repeat`/`spread`/`list`
  erreicht; alles andere (Builder, Referenz, `dynamic`, `unparsed`, Wurzel, eigenes
  Eltern-Widget) beendet die Suche ohne Befund. Argumentwerte stehen nicht im
  Graphen; eine Regel, die von einem abhängt (`scrollDirection`), schweigt, wenn es
  gesetzt ist. Erprobt an vier echten Flutter-Apps (SwipeMeister, mwpa-app, velyo,
  movinder): 224 Kandidaten-Widgets mit bekanntem Elternteil, 0 Befunde — diese
  Layouts sind korrekt; den Recall zeigen nur die Fixtures
  (`test/FlutterLayout.test.ts`) sowie ein echter Fehler im Graph-Fixture aus
  Phase 1 (`ListView.builder` direkt in einer `Column`).
- **Widget-Argumentwerte (Flutter-Qualitätsstrang, Phase A):** `src/analysis/dart/DartValues.ts`
  ist ein wiederverwendbares, bewusst begrenztes Wertemodell für Dart-Aufrufargumente:
  Literale (bool, null, int inkl. Hex, double inkl. führendem `-`, einfache Strings
  bis 64 Zeichen ohne Interpolation/Escapes), statische Member-Referenzen
  (`Axis.vertical`, `double.infinity`) und Konstruktoraufrufe als Objekte eine Ebene
  tief (`BoxConstraints(maxHeight: 200)`, `EdgeInsets.all(8)`); alles andere ist
  ausdrücklich unbekannt (`reference`, `expression`, `closure`, `widget`). Die Werte
  liegen je Widget-Knoten in `ui.flutterWidgetTree` (Encoding v2, parallel zu
  `argNames`) und werden über `argValueOf(node, name)` gelesen — `undefined` heißt
  *nicht angegeben* (Framework-Standard gilt), was von unbekannt verschieden ist.
  Entscheidung: das MODELL ist wiederverwendbar (nicht Flutter-spezifisch); die
  ABLAGE ist der Widget-Knoten, weil eigene Facts je Argument die Fact-Zahl
  vervielfachen und einen Positions-Join bräuchten, während der Knoten Evidence und
  Range schon trägt. Kosten an vier echten Apps: Tree-Facts +27 %, alle Facts
  +2,3 %; von 7857 benannten Argumenten sind 49 % Literal-, Member- oder
  Objektwerte. `R-FLUTTER-UNBOUNDED-SCROLLABLE` und
  `R-FLUTTER-NESTED-SCROLL-UNBOUNDED` (1.1.0) entscheiden jetzt nach diesen Werten:
  ein Viewport wirft, wenn `shrinkWrap` false ist (geschrieben oder Standard) oder
  wenn seine Scrollachse bekanntermaßen von der Achse abweicht, die der Elternteil
  unbegrenzt lässt (ein shrinkWrap-Viewport braucht trotzdem eine begrenzte
  Querachse); ein unbekannter Wert hält die Regel still, außer der Fehler ist
  ohnehin sicher. Befunde auf den vier Apps unverändert (byte-identisch); die
  Evidence nennt jetzt die entscheidenden Werte.
- **Identitätsauflösung (Flutter-Qualitätsstrang, Phase B):** `src/model/DartLibraryIndex.ts`
  löst auf, auf welche DEKLARATION `prefix.Name` in einer Datei verweist —
  Dart-generisch, aus `dart.importSpec`- und `dart.classDecl`-Facts: eine Deklaration
  in derselben Bibliothek (inkl. ihrer `part`-Dateien) überdeckt jeden Import; sonst
  wird jeder Import mit diesem Präfix gefragt, dessen `show`/`hide` den Namen
  zulassen — eine Projektbibliothek über ihren Export-Namensraum (eigene
  Deklarationen + `export`-Direktiven, transitiv, zyklensicher), eine externe über
  ein `ExternalLibraries`-Lookup. Status: `resolved` (genau ein Ursprung; nicht
  einsehbare Importe stehen unter `possible`, machen ihn in kompilierendem Code aber
  nicht mehrdeutig), `ambiguous` (zwei oder mehr Ursprünge — z. B. Material und ein
  eigenes `Padding`), `unresolved`. Dieselbe Deklaration über Material und über ein
  Projekt-Barrel ist ein Ursprung. `src/analysis/dart/DartPackages.ts` bildet die
  eigenen pubspec-Namen des Projekts auf ihr `lib/` ab (damit ist
  `package:my_app/…` eine Projektdatei; kein Pub-Cache, kein Netz);
  `src/analysis/dart/FlutterCatalog.ts` ist das statische Flutter-Wissen (72 Namen →
  deklarierende Bibliothek und welche von widgets/material/cupertino sie
  exportieren, abgeleitet aus Flutter-SDK 3.29.2 und per Test gegen ein lokales SDK
  geprüft) — ein Name außerhalb des Katalogs bleibt `unknown`, `TextField` aus
  widgets.dart ist `absent`. Entscheidung: getrennt vom SymbolGraph (dessen
  ES-Modul-Modell passt nicht zu Dart-Bibliotheken, `show`/`hide`, `part`), und das
  Flutter-Wissen bleibt aus dem generischen Resolver heraus. Graph-Knoten tragen es
  additiv als `WidgetNode.resolution` (`identity` bleibt);
  `ProjectRuleInput.dartLibraryIndex` ist neu und optional. Alle Flutter-Regeln
  verlangen jetzt `resolved` zu einem `package:flutter/`- (bzw. `dart:async`-)
  Ursprung — Layout 1.1.0/1.2.0, Lifecycle 1.1.0, a11y 1.2.0. Der a11y-Extraktor
  nutzt denselben Algorithmus DATEILOKAL (der FactCache ist pro Datei), ein nur über
  ein Projekt-Barrel erreichtes Widget wird dort also nicht beansprucht. Nicht
  modelliert: das implizite `dart:core`, Typedef-/Funktionsnamen, bedingte URIs,
  Quellen anderer Pakete. An vier echten Apps: 1881 Widget-Knoten aus dem Katalog,
  alle `resolved` zu Flutter, null Abweichungen zur alten Bewertung pro Datei;
  Befunde byte-identisch; Index und Graph unter 100 ms je App. Tests:
  `test/DartIdentity.test.ts` (`test/fixtures/dart-identity`).
- **Lifecycle-Präzision (Flutter-Qualitätsstrang, Phase C):** `dart.stateLifecycle`
  ist jetzt Fact v2 (additiv). **mounted:** jedes setState nach einem await
  erhält einen strukturellen `guard` innerhalb seines Funktionsrumpfs —
  `dominating` (`if (!mounted) return;`/`throw` inkl. `!context.mounted` und
  `|| …` in einem Block, der den Aufruf umschließt, der Aufruf in
  `if (mounted && …) {…}` oder im `else` von `if (!mounted)`,
  `mounted ? setState(…) : …`), `non-dominating` (jede Erwähnung ist eine
  `if`-Bedingung, die den Aufruf nachweislich nicht absichert: Erwähnung daneben,
  kein unbedingter Ausstieg, Guard nur in einem Zweig, Ausstieg per `break`),
  `unknown` (`final ok = mounted;`, `== false`, Schleifenbedingung, andere Closure
  — die Regel schweigt) oder `none`. Ein await in einem anderen Zweig desselben
  `if`/`?:`/`switch` als der Aufruf gilt nicht als vorangehend. Die Evidence nennt
  die Zeilen von await, setState und entscheidendem `mounted`. Keine Dominanz über
  Schleifen oder `try`/`finally` hinaus; awaits einer späteren
  Schleifeniteration werden nicht modelliert. **Subscriptions:** ein
  `.listen(…)` ist nur dann eine Subscription, wenn es in einem als
  `StreamSubscription` DEKLARIERTEN Feld landet, aufgelöst zu `dart:async`
  (Katalogeintrag); untypisierte Felder und eigene `listen()`-APIs werden nie
  gemeldet; Subscriptions in Sammlungen werden nicht verfolgt. **Ressourcen:** je
  Feld sicher erzeugt (aufgelöster Framework-Typ) / möglicherweise
  (untypisiertes `listen`), anderweitig verwaltet (auch aus `widget.x`, einem
  Parameter, `a ?? b` zugewiesen — übersprungen; `= null` zählt nicht), sicher
  freigegeben (`.dispose()`/`.cancel()`/`.close()`, auch `?.`, `this.`, Kaskade —
  `releaseCalls`) / erwähnt (gilt weiter als Freigabe, Nutzerentscheidung aus
  Phase 3) / nicht nachweisbar freigegeben (der einzige gemeldete Zustand).
  Controller-, Subscription- und setState-Regel auf 1.2.0. An vier echten Apps:
  Befunde unverändert an denselben 148 Stellen (die setState-Evidence trägt jetzt
  die Zeilen); 60 setState-nach-await-Aufrufe — 49 dominating, 11 none, 0
  non-dominating/unknown; 50 Framework-Controller/Timer — 45 per explizitem
  Aufruf freigegeben, 5 nicht freigegeben (die bestehenden Befunde); alle 4
  `.listen`-Felder typisiert und gecancelt. Eine erste, strengere Guard-Prüfung
  brachte 2 Fehlalarme (await und setState in sich ausschließenden `if`-Zweigen),
  behoben durch die obige Zweigregel. Nicht ergänzt: `StreamController`/
  `ValueNotifier` (kein Vorkommen in den Apps) und Controller von Drittpaketen
  (kein Identitätswissen). Tests: `test/FlutterLifecycle.test.ts`
  (`test/fixtures/flutter-lifecycle-phase-c`).
- **Regel-Governance (Flutter-Qualitätsstrang, E1 — Vorarbeit für SOLID):**
  (a) Regelreife: `Rule.maturity` / `ProjectRule.maturity` (`stable` |
  `experimental`, schema-validiert); Befunde experimenteller Regeln tragen
  `ruleMaturity: "experimental"`; derzeit ist keine Regel experimentell. (b) Die
  Regel-Engine deckelt die Konfidenz jedes Project-Rule-Befunds nach seiner
  `certaintyBasis` (`certaintyCap`), wie es für deklarative Regeln immer galt.
  Wirkung: zwei Regeln mit deklarierten 0,7 bei `semantic-heuristic` melden nun
  0,6 — `R-UNUSED-EXPORT` (nur mit `--dead-exports`) und
  `R-VALIDATION-CONTRACT-MISMATCH` (nur mit `--contracts`); kein Befund
  hinzugefügt oder entfernt, die Standardausgabe auf vier echten Apps und das
  Golden-Korpus sind byte-identisch. (c) Ausgabefilter `--min-confidence`,
  `--certainty`, `--no-experimental` (`src/FindingFilter.ts`), angewendet in der
  CLI nach dem Baseline-Schritt, sodass `analyze()` und die Baseline ungefiltert
  bleiben; `AnalysisReport.filter` hält Kriterien und Zahl der ausgeblendeten
  Befunde fest. Tests: `test/RuleGovernance.test.ts`.
- **Dart im ModuleGraph (Flutter-Qualitätsstrang, E2):** `buildModuleGraph`
  nimmt optional einen `DartLibraryIndex` (die Pipeline baut den Index jetzt vor
  dem Graphen). Jede Dart-`import`/`export`-Direktive, deren URI auf eine
  analysierte Datei auflöst (relativ oder eine `package:`-URI der eigenen
  Pakete), wird eine Kante mit `origin: 'dart.importSpec'`, `dartDirective` und
  `resolution` `relative` | `package`; jede andere (`dart:`, Fremdpakete,
  ausgeschlossene/generierte Dateien) ein unaufgelöster Import mit ihrer URI.
  `part`/`part of` erzeugen keine Kante (eine Bibliothek); ein konfigurierbarer
  Import trägt nur seine Standard-URI bei. Einträge von vor E2 tragen kein
  `origin` und sind byte-identisch. `cycleAdjacency` und der SymbolGraph
  ignorieren Dart-Kanten, `R-DEP-CYCLE` bleibt also unverändert — Dart-Zyklen
  sind legal und verbreitet; ob sie gemeldet werden, ist eine eigene
  Entscheidung. Gemessen auf vier echten Apps (185/74/66/35 Dart-Dateien): 548 /
  210 / 294 / 77 Kanten, 277 / 133 / 95 / 65 unaufgelöst (alle extern: Flutter,
  `dart:`, Fremdpakete; keine eigene Paket-URI unaufgelöst), Importzyklen in 3 /
  1 / 0 / 2 starken Zusammenhangskomponenten (größte 15 Dateien), Graphaufbau
  ≤ 6 ms; Befunde auf den Apps, dem Golden-Korpus und den TS-Projekten
  byte-identisch. Tests: `test/ModuleGraph.test.ts`
  (`test/fixtures/dart-modulegraph`).
- **Schichtklassifikation (Flutter-Qualitätsstrang, E5a):**
  `src/model/LayerClassification.ts` (`buildLayerClassification(facts,
  dartLibraryIndex)`), nur Dart, aus Facts und dem Index — kein AST. **UI:** eine
  Klasse, deren Oberklasse auf `StatelessWidget`/`StatefulWidget`/`State` aus
  `package:flutter/src/widgets/framework.dart` auflöst, direkt oder über
  Projektklassen (`chain`), zyklensicher; Basisklassen anderer Pakete
  (`GetView`, `ConsumerWidget`) und mehrdeutige/unaufgelöste Namen zählen nie.
  **Datenzugriff:** das Modul importiert selbst ein Paket des versionierten
  Katalogs `src/analysis/dart/DataAccessCatalog.ts` (`http`, `dio`,
  `shared_preferences`, `sqflite`, `cloud_firestore`, `firebase_database`,
  `firebase_storage`, `hive`, `isar`, `drift`, `supabase_flutter`,
  `graphql_flutter`) oder `dart:io` mit einem `show` von Datei-/Socket-/HTTP-/
  Prozess-Namen; `dart:io` ohne `show` ist `undecided` und zählt nicht; nur eine
  Ebene, nie transitiv. Rollen gehören zu einer Bibliothek (Datei + Parts); ein
  Modul ohne Rolle ist unbekannt. `StatelessWidget`/`StatefulWidget` wurden in
  den Flutter-Katalog aufgenommen (gegen das SDK geprüft). Noch nicht in der
  Pipeline verdrahtet — bis E6a liest sie keine Regel, jede Ausgabe bleibt
  unverändert (byte-identisch geprüft auf vier echten Apps, dem Golden-Korpus
  und den Flutter-Fixtures). Gemessen auf den vier Apps (185 / 74 / 66 / 35
  Dart-Dateien): UI-Module 76 / 12 / 30 / 14, Datenzugriffs-Module 5 / 10 / 2 /
  0, beides in einem Modul 0 / 4 / 0 / 0 (mwpa-Seiten mit `shared_preferences`),
  `dart:io` unentschieden in 6 / 4 / 8 / 0 Dateien, ≤ 9 ms. Nicht erkannte
  UI-Klassen: 1 (swipemeister) und 5 (velyo), alle in Dateien, deren Dart-3-
  Syntax die Grammatik nicht strukturieren kann. Tests:
  `test/LayerClassification.test.ts` (`test/fixtures/dart-layers`).
- **TypeModel (Flutter-Qualitätsstrang, E4):** `src/model/TypeModel.ts`
  (`buildTypeModel(facts, analyzedFiles, dartIndex?, moduleGraph?)`; Regeln
  lesen es über `typeModelOf(input)` — `ProjectRuleInput.typeModel?`, ohne
  Vorgabe einmal je Fact-Array aus den Facts gebaut). Je deklariertem Typ: jeder
  Supertyp aufgelöst zu `project` (Zieldeklaration), `external` (Dart:
  aufgelöste Bibliotheks-URI; TS: ein nicht analysiertes Modul), `ambiguous`
  oder `unresolved` (Dart: opake Kandidaten gelistet); geerbte Member über
  `extends`/`with`/`on` (nicht `implements`), am stärksten abgeleitet zuerst —
  eigene Member verdecken, das letzte Mixin gewinnt, keine Konstruktoren oder
  statischen Member — zyklensicher; katalogisierte Framework-Member
  (`FLUTTER_FRAMEWORK_MEMBERS`, SDK 3.29.2: `State`, `StatelessWidget`,
  `StatefulWidget`, die Ticker-/Keep-Alive-Mixins, `CustomPainter`);
  `hierarchyComplete` nur, wenn jede Basis ein Projekt- oder katalogisierter
  Framework-Typ ist. Dart löst über den DartLibraryIndex auf (Präfixe, Barrels,
  Parts); TS über eine Deklaration in derselben Datei oder das neue dateilokale
  Fact `struct.importBindings` (lokaler Name → Modul, exportierter Name:
  Aliase, Default- und Namespace-Importe — `deps.importName` kennt keinen
  lokalen Namen) plus den ModuleGraph; TS-Re-Export-Barrels werden nicht
  verfolgt. `TickerProviderStateMixin`, `SingleTickerProviderStateMixin`,
  `AutomaticKeepAliveClientMixin` und `CustomPainter` wurden in den
  Flutter-Katalog aufgenommen (gegen das SDK geprüft). Nicht in der Pipeline
  verdrahtet (E6b liest es über `typeModelOf`); Befunde byte-identisch auf vier
  Apps, Golden-Korpus und Flutter-Fixtures (auch mit `--solid`).
  `struct.importBindings` fügt auf den TS-Projekten 0,6–1,0 % Facts hinzu (auf
  Dart keine). Gemessen: vollständige Hierarchien unter Typen mit
  extends/with/on 213/221 (swipemeister), 34/44 (mwpa: `GetxController`),
  132/145 (velyo: Parse-Fehler), 21/22 (movinder), 15/17 (stoa/src), 7/61
  (flyingfish: Framework-Basen aus `@stefanwerfling/figtree`, `typeorm`);
  Aufbau ≤ 22 ms. Tests: `test/TypeModel.test.ts` (`test/fixtures/typemodel`).
- **Klassenmodell-Facts (Flutter-Qualitätsstrang, E3):** ein neutrales
  `struct.typeDecl`-Fact je Dart-Klasse/-Mixin/-Enum
  (`src/analysis/dart/DartMembers.ts`) und je Top-Level-TS-Klasse/-Interface
  (`src/analysis/typescript/TsMembers.ts`): `declKind`, Supertypen wie
  geschrieben (`extends`/`implements`/`with`/`on`, mit Präfix),
  `hasParseError` und die Member als kompakte Tabelle eingebettet
  (Nutzerentscheidung: ein Fact je Member vergrößerte die Facts um 34–43 %;
  Standardwerte weggelassen, `expandMembers` stellt sie wieder her —
  `src/analysis/StructFacts.ts`). Je Member: Art (method/getter/setter/field/
  constructor), static/abstract/override, Rumpfform (`abstract`, `empty`,
  `throws-unsupported` — Dart `UnsupportedError`/`UnimplementedError`, TS
  `NotImplementedError`-artige Typen oder ein Error, dessen Nachricht „not
  implemented/supported" sagt — oder `normal`), deklarierter Typ, Parameter
  (Field-Formals: Dart `this.x`, TS-Parameter-Properties, die zugleich Felder
  sind), referenzierte eigene Member, referenzierte Import-Präfixe/importierte
  Namen (Dart: zusätzlich UpperCamel-Namen, die nicht in der Datei deklariert
  sind, als Kandidaten), Konstruktoraufrufe (auch in Initialisierer-Listen und
  Feld-Initialisierern) und statische Property-Lesezugriffe. Syntaktisch und
  dateilokal, gecacht wie jedes Fact. Noch liest sie keine Regel, die Befunde
  sind daher unverändert (geprüft auf vier Apps, stoa/src und
  flyingfish/backend mit `--dead-exports`, dem Golden-Korpus); im Bericht
  steigt `coverage.factCount`. Kosten: Dart-Apps +4,0–5,6 % Facts / +19–23 %
  Bytes, TS-Projekte +1,1–1,8 % / +2,9–4,1 %; Analysezeit +10–21 % auf den
  Dart-Apps, ≤ 3 % bei TS (Einzelläufe). Klassen mit Parse-Fehler: 2 / 316
  (swipemeister), 15 / 206 (velyo), sonst 0 — markiert, nie zu beurteilen.
  Nicht modelliert: Member von Enhanced Enums (nicht parsebar), Extensions,
  Klassenausdrücke/verschachtelte Klassen in TS, Shadowing über Parameter und
  lokale Variablen hinaus. Tests: `test/StructFacts.test.ts`
  (`test/fixtures/struct`).
- **Architektur-Konfiguration R6 (Flutter-Qualitätsstrang, E5b):**
  `src/architecture/ArchitectureConfig.ts`, Schema
  `schemas/architecture.schema.json`, CLI `--architecture <datei>`
  (Pipeline-Option `architecture`). Loader nach dem Muster des Validation
  Contract (ajv 2020; ungültiges JSON, Schemaverletzungen und doppelte
  Schichtnamen schlagen mit klarer Meldung fehl, Exit 1). Ein Verweis auf eine
  nicht deklarierte Schicht in `allow`/`forbidPackages` (das Planbeispiel
  erlaubt `ui → domain`, ohne `domain` zu deklarieren) ist eine Warnung, kein
  Fehler — er trifft nie zu. `ArchitectureModel`: eine Datei gehört zur ERSTEN
  Schicht, deren `include`-Globs (picomatch, Dotfiles, POSIX-Pfade relativ zur
  Analysewurzel — bei einer Einzeldatei deren Verzeichnis) passen;
  `edgeVerdict(from, to)` = `same-layer` | `allowed` (in `allow` gelistet) |
  `forbidden` | `unknown` (ein Ende ohne Schicht — nie ein Verstoß);
  `isPackageForbidden(datei, paket)` je Schicht; `packageNameOf(specifier)`
  normalisiert `package:http/…` → `http`, `dart:io`, `axios/x` → `axios`,
  `@scope/name/x` → `@scope/name`, relative und eigene Paket-Specifier → null.
  Der Report erhält `architecture` (nur mit Konfiguration; Markdown-Zeile,
  SARIF-Invocation-Property): Schichtgrößen über die analysierten Dateien,
  Dateien ohne Schicht und die Konfigurationswarnungen — Dateien in mehreren
  Schichten (Anzahl + die ersten 20), leere Schichten, nicht deklarierte
  Schichtverweise. Noch liest keine Regel sie (E6d); ohne `--architecture` ist
  jede Ausgabe einschließlich des vollständigen CLI-JSON-Reports
  byte-identisch. Erprobt an swipemeister mit den Schichten des Planbeispiels
  plus `domain` (`lib/Model/**`): ui 77, data 51, domain 11, 64 Dateien ohne
  Schicht. Tests: `test/ArchitectureConfig.test.ts`
  (`test/fixtures/architecture`: Loader-Fehler, Zuordnung inkl. Mehrfachtreffer
  und Dateien außerhalb der Wurzel, alle vier Kantenurteile, Paketverbote und
  -namen, Report-Zusammenfassung und Markdown, CLI-Fail-fast und JSON).
- **SOLID, SRP-Verantwortungskohäsion (Flutter-Qualitätsstrang, E6e):**
  `src/rules/project/SolidSrpRule.ts`, `R-SOLID-SRP-RESPONSIBILITY-COHESION`
  0.1.0 (experimentell, `semantic-heuristic` 0,4, `info`, `marcus.purpose`,
  `responsibility-boundaries`). **Nicht registriert** — auch nicht mit
  `--solid` —, bis die Kandidaten von Hand klassifiziert sind (Plan, OQ-6); die
  Ausgaben sind mit und ohne `--solid` byte-identisch. Gruppen = Zusammenhangs-
  komponenten von „eigener Instanz-Member verweist auf eigenen Member“
  (Konstruktoren und statische Member ausgenommen, Getter + Setter eine
  Eigenschaft). Gemeldet, wenn ≥ 2 Gruppen je eine Methode, ein eigenes Feld
  und eine Abhängigkeit haben und die Gruppen paarweise disjunkt in Feldern UND
  Abhängigkeiten sind; eine Abhängigkeit ist ein Importname, über das TypeModel
  aufgelöst zu einer Projektdatei, einem externen Paket (`packageNameOf`), einem
  Dart-Importpräfix oder einem mehrdeutigen Namen — Namen, die zu nichts
  auflösen (dart:core, Typparameter), sind kein Beleg. Die Evidenz listet jede
  Gruppe (Methoden, Felder, Abhängigkeiten), nie eine Zahl. Beurteilt nur, wo
  die Kohäsion vollständig sichtbar ist: Klassen/abstrakte Klassen ohne geerbte
  oder Framework-Member (Verweise auf `widget`, `setState` oder eine
  Basismethode werden nicht erfasst — die Artefakte aus Phase D), ohne
  Parse-Fehler, kein Testpfad, kein Test-Double. Gemessen (vier Apps, stoa/src,
  flyingfish): **0 Kandidaten**. Trichter: 394 beurteilbare Klassen
  (swipemeister 92, velyo 52, movinder 15, mwpa 45, flyingfish 158, stoa 32);
  414 wegen geerbter/Framework-Member ausgeschlossen; 56 zerfallen in ≥ 2
  Methodengruppen — in der Durchsicht alle kein SRP-Verstoß: Datenklassen mit
  Zugriffsmethoden je Feld (velyo-Modelle), l10n-Tabellen, TypeORM-
  `up`/`down`-Migrationen, zustandslose Provider/Manager ohne eigene Felder
  (flyingfish), die Sprachadapter (`id`/`version`/`extractFacts` gegenüber
  `parse` — getrennt durch die Adapter-Schnittstelle), stoas `TypeModel`
  (Nachschlagen gegenüber Auflösen; die Gruppen teilen Abhängigkeiten),
  ein Varianten-Werthalter (mwpa `DynInputValue`, seine Gruppen
  teilen `flutter`). Tests: `test/SolidSrpRule.test.ts`
  (`test/fixtures/solid/srp`, Dart + TS: Positivfall, Getter/Setter, geteilter
  Zustand, geteilte Abhängigkeit, reine Daten, Gruppe nur mit dart:core,
  Unterklasse, Widget, Test-Double, Testpfad, nicht registriert, deutscher
  Text) und der Lossless-Fall in `test/ProjectRuleCategorization.test.ts`.
- **SOLID-Auswertung, Präzisions-Gate (Flutter-Qualitätsstrang, E7):**
  - **SOLID-Golden-Korpus** `test/corpus/solid` (außerhalb von
    `test/corpus/project`, der Hauptkorpus bleibt also unverändert): ein kleines
    Flutter-/TS-Projekt mit einem Positiv- und einem Negativfall je Regel und der
    Composition Root; zwei Manifeste — `expected.json` (`--solid`, Stufe 1) und
    `expected-architecture.json` (`--solid --architecture
    test/corpus/solid/stoa.architecture.json`, Stufe 2). `stoa eval` akzeptiert
    jetzt `--solid` und `--architecture` (dieselben Loader wie `analyze`). Beide:
    Präzision und Recall 100 % (7 TP, 0 FP, 0 FN); ohne `--solid` erzeugt der
    Korpus keinen Befund.
  - **Präzisions-Gate auf den echten Projekten** (manuelle Durchsicht jedes
    SOLID-Befunds, vier Apps + stoa/src + flyingfish, ohne `--architecture`):
    die einzigen Fehlbefunde waren Hinweise in `main.dart`, der Composition
    Root, in der das Verdrahten konkreter Klassen genau das ist, was Dependency
    Inversion verlangt (Stufe 1: 2 von 19, E6c: 2 von 24). Nutzerentscheidung:
    eine Dart-Bibliothek mit top-level `main()` (ein `function`-Subjekt in
    `metric.functionLength`, kein Dateinamensmuster) ist von Stufe 1 und E6c
    ausgenommen. Danach: swipemeister Stufe 1 13, E6c 19; mwpa Stufe 1 4, E6c 3;
    velyo, movinder, stoa/src, flyingfish 0; in der Durchsicht kein Fehlbefund
    mehr. LSP/ISP: 0 Befunde auf allen sechs Projekten (dort wirft kein Member
    nur „unsupported“, kein abstrakter Projekt-Member wird leer erfüllt) —
    Nutzerentscheidung: sie bleiben `experimental`, bis echte Befunde
    geprüft sind, obwohl das Gate formal bestanden ist. Stufe 1 und E6c bleiben
    `experimental` (semantische Heuristiken, wie geplant); Stufe 2 ist `stable`.
  - **Eindeutige Identitäten:** mehrere SOLID-Befunde einer Klasse oder Datei
    teilten eine Identität (Datei, Regel, Symbol) — 21 Duplikate auf
    swipemeister mit `--architecture` —, sodass Baseline und `--only-new` sie
    zusammenlegten. Die Symbole tragen jetzt das Ziel: E6c `Klasse:Ziel`, ISP
    `Klasse:Vertrag`, Stufe 2 den relativen Pfad der importierten Datei bzw.
    `package:<name>`; ein Test prüft die Eindeutigkeit auf jeder SOLID-Fixture.
    (Die Flutter-Lifecycle-Regeln haben solche Duplikate weiterhin — etwa zwei
    `setState`-nach-`await`-Stellen in einem State —, außerhalb dieses Strangs.)
  - **SRP (E6e)** folgte nach E7, siehe den Eintrag darüber.
  - Docs: `rule-model` (die SOLID-Regeln; `R-ARCH-LAYER-VIOLATION` als Stufe 2
    umgesetzt), `finding-model` (Berichtsfeld `architecture`, Identität),
    `evaluation` (SOLID-Korpus), `open-questions` (OQ-6), README.
  - Tests: `test/SolidCorpus.test.ts` (beide Manifeste, kein Befund ohne
    `--solid`, eindeutige Identitäten, `eval`-CLI).
- **SOLID, DIP-Schichtrichtung Stufe 2 (Flutter-Qualitätsstrang, E6d):**
  `src/rules/project/SolidArchitectureRule.ts`, `R-SOLID-DIP-LAYER-DIRECTION`
  0.2.0 (stabil, `syntactic` 0,9, `medium`, `marcus.cooperation`,
  `dependencies`). Nur mit `--solid --architecture`, und dann ANSTELLE von
  Stufe 1 (Nutzerentscheidung: eine Semantik je Lauf unter der ID; ohne
  Konfiguration läuft Stufe 1 0.1.0 wie bisher). Befunde: eine aufgelöste
  ModuleGraph-Kante — TS `deps.import` (type-only eingeschlossen, in der Evidenz
  als `import type` markiert) und Dart `import`/`export` (E2) — zwischen zwei
  verschiedenen Schichten, deren Richtung `allow` nicht nennt, einer je
  (importierende Datei, importierte Datei) an der ersten Stelle; und ein
  unaufgelöster (Paket-)Import, dessen `packageNameOf`-Name für die Schicht der
  importierenden Datei verboten ist, einer je (Datei, Paket). Eine Datei ohne
  Schicht führt nie zu einem Befund. Evidenz: die Schicht der Datei
  (Konfigurationsname und -version) und jede Importstelle. Reife wie geplant
  stabil: der Befund ist eine Tatsache relativ zur Deklaration des Nutzers,
  keine Heuristik. Erprobt mit Probe-Konfigurationen: swipemeister mit den
  Schichten des Planbeispiels (`lib/Service/**` umfasst die API-Response-Modelle)
  92 Kantenbefunde, 0 Paketbefunde (keine UI-Datei importiert http/dio/sqflite);
  mwpa mit verbotenem `shared_preferences` für `lib/Pages/**`: dieselben 4
  Seiten, die E6a fand. Ohne `--architecture` ist jede Ausgabe byte-identisch.
  Tests: `test/SolidArchitectureRule.test.ts` (`test/fixtures/solid/dip-declared`:
  verbotene Dart-Import/Export- und TS-(Typ-)Importe in beide Richtungen,
  Dart-/`dart:`-/npm-/Scoped-Paketverbote, erlaubte, schichtinterne und
  unbekannte Kanten, Ersetzung von Stufe 1, kein Befund ohne `--solid`), dazu
  die Lossless-Kinds-Prüfung in `test/ProjectRuleCategorization.test.ts`.
- **SOLID, DIP-Schichtrichtung Stufe 1 (Flutter-Qualitätsstrang, E6a):**
  `src/rules/project/SolidRules.ts`, registriert nur mit `--solid`
  (Pipeline-Option `solid`). `R-SOLID-DIP-LAYER-DIRECTION` 0.1.0
  (experimentell, `semantic-heuristic` 0,5, `low`, `marcus.cooperation` +
  `marcus.control`, `dependencies`): eine Dart-Bibliothek, die eine UI-Klasse
  (E5a) deklariert und selbst ein Datenzugriffs-Paket importiert oder ein
  Datenzugriffs-Modul des Projekts, das weder UI (wird für sich gemeldet) noch
  State-Halter ist (Dart-Kanten des E2-ModuleGraph). State-Halter
  (Nutzerentscheidung): eine Klasse, die eine katalogisierte
  State-Management-Basis erweitert oder einmischt — `ChangeNotifier`/
  `ValueNotifier` (`package:flutter/`), `GetxController`, `Cubit`/`Bloc`,
  `StateNotifier`/`Notifier`/`AsyncNotifier` (`STATE_HOLDER_BASES`,
  versioniert) — und keine Projektdeklaration ist; eine UI, die von ihrer
  State-Schicht abhängt, ist das gewollte Muster, auch wenn diese Schicht Daten
  persistiert. Ein
  Befund je Bibliothek an ihrem ersten solchen Import; die Evidenz nennt die
  UI-Klassen mit ihrer Flutter-Basis und jeden Import. Nur Bibliotheksebene — ob
  die UI-Klasse die importierten Namen nutzt, wird vor E3 nicht geprüft. Die
  Regel baut die Schichtklassifikation selbst aus den Facts und dem
  DartLibraryIndex, ohne `--solid` wird also nichts zusätzlich berechnet und jede
  Ausgabe ist byte-identisch (geprüft auf vier echten Apps, Golden-Korpus,
  Fixtures). Mit `--solid` auf den vier Apps: 14 / 5 / 0 / 0 Hinweise (vor dem
  State-Halter-Ausschluss 14 / 9 / 13 / 0 — velyos `AppState extends
  ChangeNotifier` und mwpas `GetxController` fielen heraus). Die übrigen Ziele
  sind Services/Wrapper mit I/O (swipemeister `ApiService`,
  `PreferencesManager`, `AvatarCacheManager`; mwpa `DBHelper`, `MwpaAPI`,
  `SyncMwpaService`, `Preference`); 4 mwpa-Seiten importieren
  `shared_preferences` direkt. Tests: `test/SolidRules.test.ts`
  (`test/fixtures/solid/dip-layer`: positive, negative, unbekannte und
  State-Halter-Fälle, ein Lauf ohne `--solid`), `test/LayerClassification.test.ts`
  (State-Halter), dazu die Lossless-Kinds-Prüfung in
  `test/ProjectRuleCategorization.test.ts`.
- **SOLID, LSP- und ISP-Vertragsregeln (Flutter-Qualitätsstrang, E6b):** in
  `src/rules/project/SolidRules.ts`, nur mit `--solid`, Dart und TypeScript,
  über das TypeModel (`typeModelOf`). `R-SOLID-LSP-CONTRACT-COMPATIBILITY`
  0.1.0 (`syntactic` 0,8, `low`, `marcus.judgment`,
  `responsibility-boundaries`): eine Methode/ein Getter/Setter, deren Rumpf
  nur einen Unsupported-/Unimplemented-Fehler wirft und die einen KONKRETEN
  Member (nicht abstrakt, mit Rumpf) eines aufgelösten Projekt-Supertyps
  überschreibt — die nächste Deklaration entlang der Implementierungskette
  (zuletzt angewendetes Mixin zuerst, dann Oberklasse/`on`), danach
  `implements`; `@override` ist nicht nötig (die Hierarchie-Suche entscheidet).
  `R-SOLID-ISP-INTERFACE-COHESION` 0.1.0 (`syntactic` 0,7, `info`,
  `marcus.purpose`, `responsibility-boundaries`): eine Klasse, die eine
  aufgelöste Projekt-Schnittstelle oder abstrakte Projektklasse implementiert,
  erweitert oder einmischt und ≥ 2 ihrer ABSTRAKTEN Member (eigene und
  geerbte) mit leerem oder nur werfendem Rumpf erfüllt; ein Befund je (Klasse,
  Vertrag). Beide überspringen Framework-/Paketbasen (Member unbekannt),
  Deklarationen mit Parse-Fehler, Klassen in Testpfaden (`test/`,
  `integration_test/`, `*_test.dart`, `*.test.ts`/`*.spec.ts`, relativ zum
  tiefsten gemeinsamen Verzeichnis der analysierten Dateien) und Typnamen mit
  `Mock`/`Fake`/`Stub` (eine dokumentierte Namensausnahme, die nur
  ausschließt); ein leeres oder werfendes Überschreiben eines abstrakten
  Members ist kein LSP-Befund. Reife vorerst `experimental` — die Plantabelle
  nennt `stable`, darüber entscheidet aber das Präzisions-Gate in E7. Ohne
  `--solid` ist jede Ausgabe byte-identisch; mit `--solid` liefern die vier
  Apps, stoa/src und flyingfish keinen LSP-/ISP-Befund — keines hat auch nur
  einen Member, der nur „unsupported“ wirft, oder eine leere Implementierung
  eines abstrakten Projekt-Members (die Messung aus Phase D ergab dasselbe).
  Tests: `test/SolidContractRules.test.ts`
  (`test/fixtures/solid/contracts/{dart,ts}`: positive, negative, unbekannte,
  Testpfad- und Test-Double-Fälle, ein Lauf ohne `--solid`), dazu die
  Lossless-Kinds-Prüfung in `test/ProjectRuleCategorization.test.ts`.
- **SOLID, DIP konkrete Abhängigkeit (Flutter-Qualitätsstrang, E6c):**
  `R-SOLID-DIP-CONCRETE-DEPENDENCY` 0.1.0 in
  `src/rules/project/SolidRules.ts`, nur mit `--solid`, nur Dart (die
  E5a-Schichtklassifikation ist nur Dart) (experimentell, `semantic-heuristic`
  0,5, `low`, `marcus.cooperation`, `dependencies`): eine UI-Klasse (E5a), deren
  EIGENE Member eine konkrete Projektklasse erzeugen, eine ihrer statischen
  Methoden aufrufen oder einen ihrer statischen Member lesen (`Api.instance`),
  wobei diese Klasse per Identität (TypeModel) auf eine nicht abstrakte
  `class` in einer Bibliothek mit der Rolle Datenzugriff auflöst, die weder UI
  noch State-Halter ist. Dart schreibt benannten Konstruktor und statischen
  Aufruf gleich (`Api.x()`): die Member-Tabelle des Ziels entscheidet — ein
  deklarierter Konstruktor erzeugt, eine deklarierte statische Methode ist ein
  Aufruf, alles andere ist unbekannt und wird nicht beurteilt. Ein Befund je
  (UI-Klasse, Zielklasse) an der ersten Stelle; die Evidenz nennt jede Stelle.
  Nie ein Befund: die Klasse selbst, abstrakte Ziele (Factory-Konstruktor einer
  Abstraktion), Modelle ohne Datenzugriff, State-Halter, DI-Lookups
  (`GetIt.I`, `context.read`), mehrdeutige oder unaufgelöste Namen, geerbte
  Member. Statische Methodenaufrufe gehen über den Planwortlaut hinaus
  („erzeugt … oder greift statisch auf ihr `instance` zu“) — sie sind dieselbe
  konkrete Bindung und das vorherrschende Muster in swipemeister. Mit
  `--solid`: swipemeister 21 (2 Erzeugungen, 40 statische Aufrufe, 2 statische
  Lesezugriffe — `ApiService`, `PreferencesManager`, `AvatarCacheManager`),
  mwpa 3 (`MwpaApi()`, `SyncMwpaService()`, `Preference()`), velyo 0,
  movinder 0; ohne `--solid` ist jede Ausgabe byte-identisch. Nebenbei
  behoben (E4): `typeModelOf` cachte nur nach Fact-Array, sodass dasselbe Array
  ohne den Dart-Index der Pipeline deren Modell erhielt; der Schlüssel ist jetzt
  Fact-Array, Dart-Index und ModuleGraph. Tests:
  `test/SolidDipConcreteRule.test.ts` (`test/fixtures/solid/dip-concrete`), der
  Cache-Fall in `test/TypeModel.test.ts`, dazu die Lossless-Kinds-Prüfung in
  `test/ProjectRuleCategorization.test.ts`.
- **Flutter-State-Lifecycle (Flutter-Analyse, Phase 3):** `src/analysis/dart/FlutterLifecycle.ts`
  erzeugt je Klasse, die direkt `extends State<…>` ist, einen neutralen
  `dart.stateLifecycle`-Fact: Felder, denen genau ein Aufruf zugewiesen wird
  (Feld-Initialisierer oder `feld = …` irgendwo in der Klasse, Kaskaden erlaubt;
  `a ?? Foo()` ist keine Erzeugung), die Feldnamen, die `dispose()` erwähnt
  (transitiv über von dort aufgerufene Methoden derselben Klasse), Aufrufe in
  `initState()` (außerhalb von Closures) mit `context` als Positionsargument, und
  je `setState`-Aufruf, ob im selben Funktionsrumpf (Methode oder Closure) ein
  `await` vorausgeht und ob `mounted` dazwischen vorkommt. Vier `ProjectRule`s in
  `src/rules/project/FlutterLifecycleRules.ts` lesen ihn:
  `R-FLUTTER-UNDISPOSED-CONTROLLER`, `R-FLUTTER-UNCANCELLED-SUBSCRIPTION`,
  `R-FLUTTER-SETSTATE-AFTER-AWAIT`, `R-FLUTTER-INHERITED-IN-INITSTATE`. `State` und
  Framework-Namen brauchen einen `package:flutter/`-Import-Kandidaten (`Timer`:
  `dart:async`); jede Erwähnung in `dispose()` gilt als Freigabe; eine Klasse mit
  einem Mixin außerhalb einer bekannten Framework-Liste oder mit eigener
  Basisklasse wird übersprungen. Erprobt an vier echten Flutter-Apps (86
  State-Klassen, 202 `setState`-Aufrufe, 60 nach einem `await`, davon 49
  abgesichert): 16 Befunde, alle als echt geprüft (5 nicht freigegebene
  `TextEditingController`/`ScrollController`, 11× `setState` nach `await` ohne
  `mounted`), keine Fehlalarme gefunden.
- **Flutter-A11y-Härtung (Flutter-Analyse, Phase 4; Regelversion 1.1.0):** die drei
  `R-A11Y-FLUTTER-*`-Prüfungen behalten ihre AST-Suche über die ganze Datei
  (Nutzerentscheidung: keine Migration auf den Widget-Graphen — gemessen an vier
  echten Apps liegen 4 von 44 echten Befunden außerhalb des Graphen: Methoden mit
  Dart-3-Syntax, die die 1.0.0-Grammatik nicht strukturieren kann, und Widgets in
  Nicht-Slot-Argumenten wie `suffixIcon:`). Stattdessen gehärtet: Kandidaten kommen
  aus `DartCallSite`, daher werden `const`/`new`/`prefix.Widget(…)` und
  `const InputDecoration(…)` erkannt; ein Widget zählt nur mit einem
  `package:flutter/`-Import-Kandidaten in seiner eigenen Datei
  (`src/analysis/dart/DartIdentity.ts`, gemeinsam mit dem Widget-Graphen; eine
  gleichnamige Klasse in derselben Datei verdeckt es); `ExcludeSemantics` blendet
  aus (nicht mit `excluding: false`), `Tooltip(message:)` benennt einen IconButton,
  und die Vorfahren-Suche endet an Callback-Closures (nur `*builder`-Closures werden
  durchlaufen). `MergeSemantics` wird weiter gemeldet (Nutzerentscheidung).
  Befund-Delta auf den vier Apps gegen einen frischen Worktree des vorigen Commits:
  genau ein Befund entfällt (ein IconButton in `Tooltip(message: …)`, ein
  Fehlalarm), die übrigen 147 Befunde sind byte-identisch.
- **Pipeline:** Ingestion → Fact-Extraktion → Regel-Engine → Befunde → Reporter.
  Keine Uhr/kein Zufall/kein Netz im Kern; gleiche Eingabe + Versionen + Sprache ⇒
  byte-identische Befunde.
- **Optionale, abschaltbare Schichten:** Typprüfer-Facts (`--typecheck`),
  tote-Export-Analyse (`--dead-exports`), SOLID-Hinweise (`--solid`), LLM-Deutung
  (`--semantic anthropic`).
- **`--typecheck` deckungsgleich mit `tsc -p`:** jede TS-Datei wird im Projekt
  der nächstgelegenen `tsconfig.json` geprüft (geladen mit
  `ts.parseJsonConfigFileContent` — `extends`, `lib`, `module`/
  `moduleResolution`, `paths`, `include`/`exclude`, `references`), auf dem echten
  Dateisystem, sodass Importe wie beim Compiler aufgelöst werden. Eine Datei, für
  die zwar eine tsconfig existiert, die aber kein erreichbares Projekt enthält
  (z. B. Tests außerhalb von `include`), wird nicht geprüft — `tsc -p` prüft sie
  auch nicht; eine Datei ohne tsconfig darüber wird mit strikten Defaults geprüft
  (`tsc --strict <datei>`). Geprüft wird mit stoas mitgelieferter
  TypeScript-Version, nicht der des Projekts. `tsc`-Facts werden nicht im
  `--cache` abgelegt (sie hängen von anderen Dateien ab).

## CLI

```
stoa analyze <pfad> [--format markdown|json|sarif] [--lang en|de]
                    [--include <glob>]... [--exclude <glob>]...
                    [--typecheck] [--dead-exports] [--solid] [--architecture <datei>] [--contracts <datei>]
                    [--semantic noop|anthropic] [--memory-stats] [--cache]
                    [--baseline <datei>] [--update-baseline] [--only-new]
                    [--min-confidence <0..1>] [--certainty <liste>]... [--no-experimental]
                    [--config <datei>] [--knowledge <dir>] [--rules <dir>]
stoa eval <pfad> --expected <datei> [--format markdown|json] [--solid] [--architecture <datei>] [--contracts <datei>]
                    [--knowledge <dir>] [--rules <dir>]
```

- **Formate:** Markdown (Mensch), JSON (Maschine), SARIF 2.1.0 (CI/Code Scanning).
- **Sprachen:** `en` (Default) und `de`; Regel-/Prinzip-Texte, Reporter-Labels und
  Dimensionsnamen sind über `LocalizedText` lokalisiert (en-Fallback).
- **Dateiauswahl:** `include`/`exclude`-Globs (picomatch); `node_modules`/`.git`
  werden hart übersprungen; eine einzeln benannte Datei umgeht die Globs.
  Die Default-Excludes decken zusätzlich `build/`, `.next/`, `.nuxt/`,
  `.turbo/`, `.cache/`, `vendor/`, `dist/`, `coverage/` ab (siehe Memory-Bounded
  Analysis Pipeline unten für das Warum, sowie den begleitenden
  Dateigrößen-Filter).
- `knowledge/` und `rules/` werden relativ zum installierten Paket aufgelöst —
  die CLI läuft nach `npm link`/Install aus jedem Verzeichnis.
- `--contracts <datei>` wird von BEIDEN, `analyze` und `eval`, akzeptiert
  (zuvor von `eval` stillschweigend ignoriert) — ein fehlerhafter/unlesbarer
  Vertrag schlägt bei beiden Befehlen sofort fehl (Exit 1), nie ein
  stillschweigend verschlechtertes Ergebnis.
- Ausgabe über eine Pipe ist in jeder Größe vollständig: die CLI setzt
  `process.exitCode`, statt `process.exit()` aufzurufen, das den Prozess beendete,
  bevor ein asynchrones stdout geleert war, und gepipte Reports bei 64 KiB
  abschnitt (`stoa analyze … --format json | jq`); Regressionstest
  `test/CliOutput.test.ts`.
- `--architecture <datei>` (E5b) lädt eine deklarierte Architektur
  (`stoa.architecture.json`, `schemas/architecture.schema.json`); eine
  fehlerhafte Datei schlägt ebenso sofort fehl (Exit 1). Sie ergänzt den Report
  um die Zusammenfassung `architecture`; zusammen mit `--solid` schaltet sie die
  DIP-Schichtregel auf Stufe 2 (E6d) um.
- `--memory-stats` gibt alle 100 Dateien eine Fortschrittszeile auf stderr
  aus — aktuelle Phase (`analysis`/`evaluation`), verarbeitete/ausgewählte
  Dateien, bisher extrahierte Facts, Heap genutzt/Limit/gesamt, RSS,
  External Memory, verstrichene Zeit — plus eine abschließende Summenzeile
  (Dateien, Facts, Findings, Evidence-Graph-Nodes/-Edges, Cache-Hits bei
  `--cache`). stdout (der eigentliche Report) bleibt unverändert.
  Standardmäßig aus — die untenstehenden Defaults benötigen für
  einen typischen Lauf keine Anpassung.
- `--cache` speichert/nutzt Pro-Datei-Facts unter `<root>/.stoa/cache` über
  Läufe hinweg (siehe "Pro-Datei-Fact-Cache" unten) — standardmäßig aus; ohne
  das Flag ist das Verhalten byte-identisch zum vorherigen.
- `--baseline <datei>` / `--update-baseline` / `--only-new` — siehe
  "Baseline-/Diff-Modus" unten. Standardmäßig aus; ohne `--baseline` bleibt
  jeder Befund exakt wie vorher (kein `baselineStatus`, kein
  `AnalysisReport.baseline`).
- `--min-confidence <0..1>` / `--certainty <liste>` (wiederholbar oder
  kommagetrennt: `syntactic`, `semantic-heuristic`, `external-tool`) /
  `--no-experimental` — Ausgabefilter, angewendet nach dem Baseline-Schritt; der
  Bericht hält Kriterien und Zahl der ausgeblendeten Befunde fest
  (`AnalysisReport.filter`). Ungültige Werte sind Aufruffehler (Exit 1).
  Standardmäßig aus — ohne sie ist die Ausgabe byte-identisch zur vorherigen.

## Memory-Bounded Analysis Pipeline

Ursache des Speicherproblems bei großen Repositories (gemessen, nicht
vermutet — siehe die Spec "Memory-Bounded Analysis Pipeline", Nachfolger der
"Dataflow Correctness, Symbol Resolution & Cross-Layer Evidence"-Spec, für die
vollständigen Vorher/Nachher-Zahlen): `TypeScriptAdapter` hielt EIN
ts-morph-`Project` für den gesamten `analyze()`-Lauf und gab eine
`SourceFile` nie wieder frei, nachdem ihre Facts extrahiert waren — AST,
ts-morphs eigener permanenter Node-Wrapper-Cache und der Program-/
Checker-Zustand des TS-Compilers akkumulierten für das gesamte Repository,
nie freigegeben, über den gesamten Lauf. Separat riefen die
Dart-/C-/C++-/HTML-Adapter (`web-tree-sitter`, WASM) nie `Tree.delete()` auf
— ein nativer Linear-Memory-Leak, unsichtbar für V8s Heap-Statistiken (er
lebt außerhalb des JS-Heaps). Behoben:

- **Pro-Datei-Freigabe** (`LanguageAdapter.ts`s `ParseResult.release`, von
  `Pipeline.ts` einmal direkt nach `extractFacts` aufgerufen):
  `TypeScriptAdapter` ruft jetzt `project.removeSourceFile()` auf; die vier
  tree-sitter-Adapter rufen `tree.delete()` auf. Sicher, weil nichts in
  `src/analysis/typescript/*` ein ts-morph-Symbol ÜBER zwei Dateien hinweg
  auflöst — `OneHopResolution`, `ValidationDataflow`, `SymbolResolution` und
  `SafeParseGuard` sind alle dokumentiert und getestet als
  dateiintern-only, sodass keine Analyse die `SourceFile` einer
  Nachbardatei noch registriert braucht, nachdem deren eigene Facts
  extrahiert sind. Gemessen an einem echten ~300-Dateien-Repository: Peak
  RSS 909 MB → 451 MB, Laufzeit 145 s → 5,7 s (diese eine Änderung plus der
  Dateigrößen-Filter unten; siehe Commit-Historie für den isolierten
  Vorher/Nachher-Wert jeder einzelnen Änderung).
- **Gehärtete Discovery** (`Ingestion.ts`): Ein Verzeichnis, das
  `readdirSync` nicht lesen kann (Berechtigungsfehler, Race mit einem
  gleichzeitigen Löschen), wird jetzt übersprungen und über einen optionalen
  `onExcluded`-Callback gemeldet, statt den gesamten Lauf abzubrechen (zuvor
  real bestätigt an einem externen Repository mit einem unlesbaren
  Unterverzeichnis). Ein neuer `maxFileBytes`-Filter (Default 1 MB,
  konfigurierbar über `StoaConfig.maxFileBytes`) schließt überdimensionierte
  Dateien genauso aus wie ein Glob-Exclude — gefunden während der Messung:
  ein einzelnes 3-MB-Webpack-Bundle, außerhalb jedes Default-Exclude-
  Verzeichnisses, war der mit Abstand größte Speicher-/Zeit-Verursacher im
  gemessenen Repository und hat nach dem Bundling keinen Analysewert mehr.
  Ein explizit benannter Pfad (eine Einzeldatei als Analysewurzel) umgeht
  diesen Filter immer, genau wie er bereits die include/exclude-Globs
  umgeht. Symlinks werden bewusst nie aufgelöst (ein `Dirent`-Eintrag ist
  für einen Symlink weder `isDirectory()` noch `isFile()`, das war also
  schon vorher so, nur nicht als Absicht dokumentiert) — die Alternative,
  ihnen zu folgen, riskiert einen unbegrenzten Walk bei einem zyklischen
  Symlink, ohne dass hier ein dokumentierter Bedarf dafür besteht.
- **Memory Guard** (`src/MemoryGuard.ts`): Alle 100 Dateien vergleicht
  `Pipeline.ts` `process.memoryUsage().heapUsed` mit V8s eigenem
  `v8.getHeapStatistics().heap_size_limit` — derselbe Wert, an dem ein
  "JavaScript heap out of memory"-Fatal-Error gemessen wird, keine fest
  geratene MB-Zahl. Ab 90 % stoppt die weitere Dateiaufnahme, statt V8
  abstürzen zu lassen; bereits erzeugte Facts/Findings bleiben erhalten
  (nichts wird verworfen), und `coverage.status` wird `'partial'`
  (`coverage.abortReason: 'memory_limit'`, `coverage.stoppedAtFile`) — ein
  abgebrochener Lauf wird nie als vollständig ausgegeben (siehe
  "Vollständigkeits-Integrität der Analyse" unten für den vollständigen
  Status-/Exitcode-Vertrag, der hieraus gespeist wird). Kein `global.gc()`-
  Aufruf irgendwo — dieser Guard ist ein letztes Mittel zusätzlich zu den
  oben beschriebenen begrenzten Objekt-Lebensdauern, kein Ersatz dafür. Er
  nimmt außerdem unmittelbar vor und nach `RuleEngine.evaluate()` eine
  Momentaufnahme (sichtbar über `--memory-stats`) — kann diesen Aufruf aber
  nicht abbrechen oder teilweise anwenden: Die deklarativen Regeln werden
  pro Subjekt ausgewertet, doch die drei projektweiten Regeln
  (`DependencyCycleRule`/`DeadExportRule`/`ValidationContractRule`)
  benötigen das vollständige Fact-Array auf einmal (siehe "Regel-
  Kategorisierung" unten) — die Auswertung ist daher ein einziger, atomarer
  Durchlauf. Eine Speicherspitze genau innerhalb dieses einen Aufrufs kann
  nicht mitten im Lauf auf `'partial'` herabgestuft werden; sie kann nur den
  Prozess abstürzen lassen. Dies ist explizit als offene Einschränkung
  benannt, nicht verschwiegen.
- **Metadaten-first Discovery** (`Ingestion.ts`s `collectFiles()`,
  Folge-Spec "Analysis Integrity & Memory-Bounded Pipeline"): las zuvor
  während des Walks den vollen Inhalt jeder passenden Datei und gab alles
  auf einmal zurück — der gesamte Repository-Text lag im Speicher, bevor die
  Pro-Datei-Schleife überhaupt begann. `collectFiles()` gibt jetzt nur noch
  `FileMeta[]` zurück (Pfad + Größe); der Inhalt wird per `readFileContent()`
  lazy, eine Datei zur Zeit, gelesen — und erst, NACHDEM ein Adapter bereits
  anhand des Pfads allein ausgewählt wurde (`LanguageAdapter.supports()`
  nimmt `FileMeta`, nie Inhalt) — eine Datei, die niemand parsen kann, wird
  also gar nicht erst gelesen.
- **Ein Root-`.gitignore` wird berücksichtigt** (neu: `src/GitIgnore.ts`),
  als bewusst enge, dokumentierte Scheibe: nur das `.gitignore` des
  Repository-Roots selbst (keine Vorrang-Logik für verschachtelte
  `.gitignore`-Dateien), keine Negation (`!pattern`-Zeilen werden
  übersprungen — Wiedereinschluss hängt von der Regel-REIHENFOLGE ab, was
  sich nicht sicher als ein weiteres Exclude-Pattern modellieren lässt),
  übersetzt in picomatch-Patterns nach derselben Tiefenregel, die git selbst
  nutzt (kein Slash → passt in jeder Tiefe; ein führender/innerer Slash →
  am Root verankert). Zusammengeführt mit der bestehenden Exclude-Liste,
  sodass ein explizit genannter Analysepfad diese genauso umgeht wie jede
  andere Exclude-Quelle.
- **Kein `--jobs`/Worker-basierte Nebenläufigkeit, eine abgewogene
  Entscheidung, kein Versehen:** Die Datei-Verarbeitungsschleife ist bereits
  vollständig synchron — es gibt also von vornherein keine Parallelität zu
  begrenzen, die Prämisse hinter einem `--jobs`-Flag trifft nicht zu.
  Wichtiger noch: echte OS-Thread-Parallelität (`worker_threads`) würde den
  Peak-Speicherverbrauch ERHÖHEN, nicht senken — jeder Worker braucht seine
  eigene ts-morph-/tree-sitter-Instanz, N Worker multiplizieren also genau
  den Pro-Datei-Fußabdruck, den dieser Abschnitt gerade auf 1 begrenzt hat,
  im Tausch gegen Durchsatz, nicht Speichersicherheit, die eigentlich das
  Thema dieses Abschnitts ist. Es wäre außerdem ein substantieller,
  risikoreicherer Umbau (Cross-Thread-Fact-Serialisierung, eine
  deterministische Merge-Reihenfolge, ein Memory Guard, der pro Worker Sinn
  ergibt), unverhältnismäßig zu "kleinen, überprüfbaren Phasen". Mit dem
  Projektinhaber abgestimmt, bevor darauf verzichtet wurde, statt es
  stillschweigend auszulassen.
- **Inkrementelle/gecachte Analyse** wurde stattdessen eng begrenzt
  umgesetzt — siehe "Pro-Datei-Fact-Cache" unten, sobald eine zuverlässig
  invalidierbare Cache-Grenze gefunden war.
- **Skalierungstest** (`test/MemoryPipelineScaling.test.ts`): ein
  synthetisches, zur Laufzeit erzeugtes, mehrsprachiges (TS+PHP),
  mehrverzeichniges Repository mit mehreren über verschiedene Dateien
  verteilten Validation-Trace-ID-Annotationen — prüft, dass die Analyse
  vollständig abschließt, über zwei Läufe deterministisch ist, keine
  doppelten Finding-Identitäten erzeugt und keine Evidence-Graph-Verbindung
  verliert (ein `validation.dataflowGraph`-Fact pro annotiertem und
  aufgerufenem Validator, unabhängig davon, in welcher Datei er liegt).
  Bewusst KEINE Speicher-Schwellenwert-Prüfung (eine RSS-/Heap-Obergrenze in
  einem Test ist über Maschinen und Node-Versionen hinweg unzuverlässig) —
  die echten, reproduzierbaren Vorher/Nachher-Zahlen oben stammen aus
  manuellen Messungen realer externer Repositories mit `/usr/bin/time -v`,
  nicht aus einem CI-gesteuerten Benchmark.

### Pro-Datei-Fact-Cache (opt-in, `--cache`)

Eine Inkremental-Analyse-Scheibe, eng genug begrenzt, um sicher zu sein, dass
sie korrekt invalidiert wird — gemäß der expliziten Priorität der Spec ("eine
korrekte vollständige Analyse ist wichtiger als ein schneller, aber
veralteter Cache"). `src/FactCache.ts` cached genau EINE Sache: die Facts,
die beim Extrahieren einer einzelnen Datei mit einem einzelnen Adapter
entstehen (`LanguageAdapter.extractFacts` / `TypeDiagnosticsExtractor.extract`)
— nie ein Regel-Auswertungsergebnis oder einen Befund. Genau diese Grenze
macht die Invalidierung wasserdicht:

- **Cache-Schlüssel:** `(engineFingerprint(), Adapter-ID, Dateipfad,
  Dateiinhalt-Hash)`. Das Lesen jedes Adapters bestätigt, dass die
  Fact-Extraktion von nichts anderem abhängt — kein Adapter liest
  `ProjectContext.rootDir` oder den Inhalt einer anderen Datei, dieser
  Schlüssel ist also vollständig, keine Annäherung.
- **`engineFingerprint()`** ist ein Hash über jede Quelldatei, aus der die
  laufende Engine tatsächlich gebaut ist (das Verzeichnis, in dem das
  laufende `Pipeline.js`/`Pipeline.ts`-Modul selbst liegt — `dist/` nach dem
  Build, `src/` unter `tsx`), einmal pro Prozess berechnet. Eine Änderung am
  tatsächlichen Fact-Extraktions-Code invalidiert den Cache automatisch — es
  gibt keinen manuell gepflegten Versionsstring, den man vergessen könnte zu
  erhöhen. Grobkörniger als ein Pro-Adapter-Fingerprint (jede Engine-Änderung
  invalidiert jede gecachte Datei, nicht nur die, deren Extraktionslogik sich
  tatsächlich geändert hat) — eine bewusste Entscheidung für eine Garantie,
  die durch Konstruktion gilt, statt für eine, die von Disziplin abhängt.
- **Regel-/Vertragsänderungen können nie einen veralteten Befund liefern**,
  durch Konstruktion: `RuleSet`/`ValidationContract` werden erst NACH diesem
  Cache konsumiert, frisch, bei jedem einzelnen Lauf — es gibt nichts
  Gecachtes stromabwärts von ihnen, das veralten könnte. Deshalb muss auch
  keine Regel-Set- oder Vertragsversion Teil des Cache-Schlüssels sein.
- **Ein korrupter oder unlesbarer Cache-Eintrag ist ein Miss, nie ein
  Absturz** — er degradiert absichtlich zur Neuberechnung dieser einen
  Datei. Das umfasst jetzt eine STRUKTURELLE Validierung (`isValidFact()`),
  nicht nur "ist `facts` ein Array": jedes Element wird auf
  `id`/`kind`/`subject`/`value`/`evidence`/`certainty`/`producedBy`
  geprüft, und wenn auch nur EIN Fact in einem gecachten Eintrag
  durchfällt, ist der ganze Eintrag ein Miss — eine Cache-Datei, die
  syntaktisch gültiges JSON, aber semantisch falsch ist (ein fehlendes
  Feld, ein Wert vom falschen Typ), darf nie stillschweigend einen
  fehlerhaften Wert in eine echte Analyse einspeisen.
- **Bewusst nicht umgesetzt, und warum:** keine `tsconfig.json`-
  Abhängigkeitsverfolgung (nichts in der heutigen TypeScript-Analyse liest
  eine tsconfig — das ts-morph-`Project` ist in-memory, ohne geladene
  `tsconfig.json` — es gibt also nichts zu invalidieren); keine
  dateiübergreifende Abhängigkeitsverfolgung (es gibt heute keine
  dateiübergreifende Fact-Extraktion — dieselbe Begründung, und dieselbe
  Voraussetzung, auf der auch die Pro-Datei-Freigabe im vorigen Abschnitt
  schon beruht). Sollte sich eine der beiden Annahmen ändern, muss das
  Korrektheitsargument dieses Caches neu geprüft werden, nicht einfach
  weiter angenommen werden.
- **CLI:** `--cache` (Boolean, Default aus) speichert unter
  `<root>/.stoa/cache` — bereits durch den bestehenden `.stoa/**`-Default-
  Exclude abgedeckt. Ohne das Flag ist das Verhalten byte-identisch zum
  vorherigen: nichts wird über das Analyseziel hinaus von der Festplatte
  gelesen oder darauf geschrieben. `coverage.cacheHits` ist nur vorhanden,
  wenn das Flag genutzt wurde.
- **Gemessen** am selben echten ~300-Dateien-Repository wie oben: kalter
  Lauf 5,5 s / 451 MB, warmer (vollständig gecachter) Lauf **0,84 s / 203
  MB** — Report-Ausgabe identisch bis auf das neue
  `coverage.cacheHits`-Diagnosefeld selbst (per Diff der beiden JSON-Reports
  verifiziert, nicht nur nach Augenmaß bei den Laufzeiten).

## Vollständigkeits-Integrität der Analyse & speicherbegrenzte Auswertung (Folge-Spec)

Zwei Ziele, aus dem Leitprinzip: "Stoa darf nur das als bewiesen ausgeben,
was tatsächlich vollständig analysiert und durch die vorhandenen
Analyseinformationen gestützt wird" — eine kleinere, vollständig und korrekt
analysierte Codebasis ist wertvoller als eine große, deren Analyse unbemerkt
unvollständig bleibt.

**Ein einziger, zentral verwalteter Status.** `coverage.status: 'complete' |
'partial' | 'failed'` (`AnalysisStatus` in `src/Types.ts`) ist jetzt das
einzige Feld, von dem alles andere abhängt:

- `'complete'`: Jede ausgewählte Datei wurde entweder analysiert oder
  absichtlich aus einem dokumentierten, nicht-Abdeckungs-relevanten Grund
  ausgeschlossen.
- `'partial'`: Mindestens eine Datei, die Stoa analysieren wollte, wurde
  nicht erreicht — ein Memory-Guard-Abbruch, oder ein Lese-/Parse-Fehler bei
  einer ausgewählten Datei (ein Wettlauf mit einem gleichzeitigen Löschen/
  Verschieben zwischen Discovery und Lesen, oder ein Parser, der an Inhalt
  scheiterte, den er eigentlich verarbeiten sollte). `coverage.
  analysisIncomplete` (das bisherige Boolean) bleibt erhalten, wird aber
  jetzt immer AUS `status` abgeleitet, am selben Punkt, an dem `status`
  gesetzt wird — nichts setzt es mehr unabhängig, die beiden können also
  nie widersprechen.
- `'failed'`: Ein Konfigurations-/Setup-Fehler (ungültiges `--knowledge`/
  `--rules`/Zielpfad) verhinderte, dass überhaupt ein echter Report
  entstand. `analyze()` selbst gibt dies nie zurück — es wirft wie bisher
  eine Exception —, aber `Cli.ts` fängt diese jetzt und synthetisiert einen
  minimalen, gültig geformten Report (`AnalysisReport.error` trägt die
  Fehlermeldung), damit JSON-/SARIF-/Markdown-Ausgabe parsbar bleibt statt
  eines nackten Stacktrace ohne jede Ausgabe auf stdout.

**Exitcodes (nur `stoa analyze` — `stoa eval` behält seinen bestehenden
Precision/Recall-Bestehen/Durchfallen-Code, siehe unten):** `0` nur bei
`'complete'`; `1` bei einem Ausführungs-/Konfigurations-/Nutzungsfehler
(ungültige Flags, eine fehlerhafte Baseline-/Contract-Datei, oder eine
gefangene Setup-Exception — `'failed'`); `2` immer dann, wenn
`coverage.status !== 'complete'` — ein unvollständiger Scan darf sich allein
am Exitcode nie von einem sauberen unterscheiden lassen, bei keinem
Ausgabeformat (End-to-End für alle drei Formate verifiziert in
`test/AnalysisStatusCli.test.ts`). Dies ist eine bewusste Verhaltensänderung
gegenüber der vorherigen Spec: Ein unvollständiger Scan gegen eine Baseline
zu vergleichen (ohne `--update-baseline`) endete bisher mit Exitcode `0`; er
endet jetzt mit `2`.

**Strukturierte Ausschlussgründe** statt eines freien Diagnose-Strings:
`ExclusionReason` (`src/Types.ts`) ist eine geschlossene Menge —
`excluded_by_config`, `excluded_by_gitignore`, `file_too_large`,
`unsupported_language` (für sich allein nie genug, um einen Lauf auf
`'partial'` zu setzen — Stoa wollte diese ohnehin nie vollständig
analysieren), gegenüber `read_error`, `memory_limit`, `analysis_cancelled`
(echte Abdeckungslücken, die das tun). `Ingestion.ts` führt Config-Excludes
und `.gitignore`-Excludes jetzt als zwei getrennte Matcher, gerade damit sie
unter ihrem jeweils eigenen Grund gemeldet werden können (zuvor in einer
Liste zusammengeführt, nachträglich nicht mehr unterscheidbar).
`coverage.excludedByReason` ist eine exakte Zählung pro Grund, immer
vollständig, nie gekappt — durch Konstruktion begrenzt (sieben Gründe),
unabhängig von der Repository-Größe. `coverage.excludedSample` ist eine
begrenzte (20) Beispielliste von `{path, reason, detail?}`-Einträgen zur
menschlichen Fehlersuche — bewusst NICHT die vollständige Liste: Ein
unbegrenztes Pro-Datei-Array hier würde genau die Art von unbegrenztem
Wachstum wieder einführen, die diese Phase vermeiden soll. Der
Memory-Guard-Abbruchschwanz (jede ausgewählte Datei, die gar nicht erst
angesehen wurde) wird als ZÄHLUNG dargestellt (`coverage.filesCancelled`,
gespiegelt in `excludedByReason.analysis_cancelled`), nicht als ein Eintrag
pro verbleibendem Pfad, aus demselben Grund. Verifiziert an einem echten
Repository (`bambooo`, 314 Dateien): `excludedByReason: {excluded_by_config:
542, excluded_by_gitignore: 1}`, `status: 'complete'` — hunderte strukturell
ausgeschlossene Dateien, die den Lauf korrekt niemals auf `'partial'` kippen.

**Regel-Kategorisierung (`ProjectRule.requiredFactKinds`, `src/rules/
ProjectRule.ts`)**: Jede der drei projektweiten Regeln deklariert jetzt
genau, welche Fact-ARTEN sie liest — `DependencyCycleRule`:
`['deps.import']`; `DeadExportRule`: `['deps.importName', 'deps.export']`;
`ValidationContractRule`: die vier `validation.*`-Arten, die sie
durchsucht. Ein neues, separat geführtes `ProjectRuleInput.analyzedFiles`
(von `RuleEngine` direkt aus den Dateipfaden des Fact-Sets berechnet,
unabhängig davon, welche ARTEN eine künftige Filterung überleben) ersetzt
das bisherige, jeweils eigene `new Set(facts.map(f => f.subject.file))`
jeder Regel — nötig, weil `DependencyCycleRule`/`DeadExportRule`
Importziele gegen die Frage "existiert diese Datei im analysierten Umfang"
auflösen, was ein nach Art gefiltertes Fact-Array allein nicht beantworten
kann (eine Datei mit null `deps.*`-Facts würde sonst unbemerkt aufhören,
ein gültiges Ziel zu sein). `test/ProjectRuleCategorization.test.ts` belegt,
dass die Deklarationen wahrheitsgemäß sind: Jede Regel nur gegen ihre
deklarierten Arten (plus das separat geführte `analyzedFiles`)
auszuwerten, liefert IDENTISCHE Findings wie die Auswertung gegen das
vollständige Fact-Set, an einem Fixture, das alle drei Regeln tatsächlich
auslöst.

**Bewusst NICHT umgesetzt, und warum — dies vor der Annahme lesen, hier
sei mehr erreicht worden:** Die obige Kategorisierung ist reine Metadaten.
Die Hauptpipeline gibt jeder projektweiten Regel weiterhin das VOLLSTÄNDIGE
Fact-Array, und `Pipeline.ts`s `facts: Fact[]` wird für den gesamten Lauf
weiterhin vollständig akkumuliert, nie gefiltert oder vorzeitig
freigegeben. Zwei bestehende, korrektheitsrelevante Konsumenten hängen
daran: die optionale semantische Schicht
(`src/semantic/SemanticRunner.ts`s `buildRequest()` filtert `result.facts`
nach Datei+Zeile, um ein LLM-Urteil für JEDEN ausgewählten Befund zu
erden, datei-lokal oder nicht) und die Finding-/Evidenz-Nachverfolgbarkeits-
Garantie (`test/FindingModel.test.ts` prüft, dass die Evidenz-Fact-Art
jedes Findings tatsächlich in `result.facts` vorhanden ist). Das
vollständige Fact-Array auf nur die von den projektweiten Regeln
deklarierten Arten zu filtern — der naheliegende nächste Schritt — würde
beides für die überwiegende Mehrheit der Findings (datei-lokale) unbemerkt
brechen, genau die Art von Regression, die der Qualitätsanspruch der Spec
selbst verbietet ("keine Regressionen bei bestehenden Regeln", "bestehende
öffentliche APIs möglichst kompatibel halten"). Eine echte inkrementelle
Fact-Freigabe würde zuerst eine Neugestaltung dieser beiden Konsumenten
erfordern (z. B. ein Nachlesen der Facts einer Datei bei Bedarf aus dem
Fact-Cache statt aus dem In-Memory-Array) — eine größere, eigenständige
Änderung, die diese Runde bewusst nicht ohne diese vorherige
Abhängigkeitsanalyse versucht hat. Dies ist der größte offene Punkt der
"speicherbegrenzten Auswertung": `RuleEngine.evaluate(facts)` bleibt ein
einziger, atomarer, unbegrenzter Durchlauf über das vollständige Fact-Set —
aus Notwendigkeit heute, nicht aus Versehen.

## Baseline-/Diff-Modus (opt-in, `--baseline`)

Verdrahtet `Finding.baselineStatus` (`'new' | 'known' | 'fixed'`), das seit
dem ursprünglichen Finding-Modell existiert, aber bisher von nichts gesetzt
wurde. Der Punkt dahinter: Ein großer bestehender Codebase hat einen
Backlog an Befunden, den heute niemand triagieren wird — eine Baseline
lässt CI/Pre-Commit nur das zeigen, was eine Änderung tatsächlich neu
eingeführt hat, nicht den gesamten Backlog.

- **Identität, wiederverwendet, nicht neu erfunden:** Die Baseline-Identität
  eines Befunds ist `(projektrelative Datei, Regel-ID, Symbol)` — exakt der
  Schlüssel, den der Golden-Corpus-Evaluator
  (`src/evaluation/Evaluator.ts`) bereits nutzt, um erzeugte Befunde gegen
  erwartete abzugleichen. Extrahiert in ein gemeinsames
  `src/FindingIdentity.ts`, sodass es eine Definition gibt, nicht zwei.
  Zeile/Spalte sind bewusst ausgeschlossen: Das Symbol unterscheidet Befunde
  innerhalb einer Datei bereits, und eine exakte Position würde die
  Identität anfällig für unabhängige Zeilenverschiebungen anderswo in
  derselben Datei machen (eine bekannte, akzeptierte Grenze, die hiervon vom
  Evaluator übernommen wird, keine neue).
- **`--baseline <datei>`:** lädt die Datei, falls vorhanden, und markiert
  jeden aktuellen Befund als `new` oder `known`; ein Baseline-Eintrag, der
  vom aktuellen Lauf nicht mehr reproduziert wird, wird in der neuen
  `AnalysisReport.baseline`-Zusammenfassung als `fixed` gemeldet
  (`newCount`/`knownCount`/`fixedCount`/`fixed: FindingKey[]`) — nie als
  Finding erfunden, da es nichts im aktuellen Code gibt, an das ein
  "fixed"-Ergebnis verankert werden könnte. Existiert die Datei noch nicht,
  ist jeder Befund `new` und nichts `fixed` — der natürliche
  Erstlauf-Zustand, kein Fehler. Eine fehlerhafte Baseline-Datei schlägt
  dagegen fehl (Exit 1) — sie stillschweigend als "keine Baseline" zu
  behandeln würde jeden bereits bekannten Befund fälschlich als neu
  markieren.
- **`--update-baseline`:** schreibt die Befunde des aktuellen Laufs (vor
  einer etwaigen `--only-new`-Filterung) als neue Baseline an denselben
  Pfad, deterministisch sortiert. Bewusst getrennt von `--baseline` — Laden
  und Überschreiben sind unterschiedliche genug Aktionen, dass ein
  Zusammenlegen riskiert hätte, dass eine Baseline stillschweigend erzeugt/
  überschrieben wird, obwohl der Nutzer nur vergleichen wollte.
- **`--only-new`:** filtert den gerenderten Report auf Befunde, die NICHT
  `known` sind — der eigentliche CI/Pre-Commit-Nutzen. Ein No-op, wenn
  `--baseline` nie angegeben wurde.
- **Rendering:** Markdown erhält eine Zusammenfassungszeile
  `- Baseline: N neu, M bekannt, K behoben` und einen `[neu]`/`[bekannt]`-Tag
  pro Befund-Überschrift (lokalisiert en/de, wie jedes andere Report-Label).
  SARIF erhält das Standard-`result.baselineState` (`'new'`/`'unchanged'`)
  — SARIF 2.1.0 definiert dieses Vokabular bereits genau für diesen Zweck,
  wiederverwendet statt eine stoa-eigene Property zu erfinden; `'fixed'`-
  Befunde haben kein SARIF-Ergebnis, an das ein State angehängt werden
  könnte, und werden dort nicht dargestellt (nur in
  `AnalysisReport.baseline.fixed`).
- **Ende-zu-Ende verifiziert** an einem echten kleinen Projekt (nicht nur
  Unit-Tests): erster Lauf ohne Baseline-Datei → alles `new`;
  `--update-baseline` schreibt sie; zweiter Lauf gegen diese Datei → alles
  `known`; `--only-new` auf diesem zweiten Lauf → null Befunde in der
  Ausgabe; das zugrunde liegende Problem entfernen und erneut laufen lassen
  → als `fixed` gemeldet.
- **Verwechselt einen unvollständigen Scan nie mit einem saubern Ergebnis**
  (Folge-Spec "Analysis Integrity & Memory-Bounded Pipeline"; die Sperre
  läuft jetzt über `coverage.status !== 'complete'`, siehe
  "Vollständigkeits-Integrität der Analyse" oben): Wenn der Memory Guard
  einen Scan vorzeitig gestoppt hat, meldet `applyBaseline()` NIE einen
  Baseline-Eintrag als `fixed` — eine Datei, die der Scan nie erreicht hat,
  wurde nie tatsächlich erneut geprüft, "nicht reproduziert" beweist also
  nichts über sie (`fixedCount`/`fixed` werden auf `0`/`[]` gezwungen, und
  `AnalysisReport.baseline.incomplete` wird gesetzt, sodass der gesamte
  Vergleich als vorläufig erscheint). `--update-baseline` geht weiter:
  `saveBaseline()` VERWEIGERT das Schreiben komplett (wirft
  `IncompleteAnalysisError`), statt eine vollständige Baseline mit
  Teildaten zu überschreiben — und diese Prüfung lebt in `saveBaseline()`
  selbst, nicht nur früher in der CLI, es gibt also keinen Aufrufpfad, der
  sie umgeht. `--only-new`/`--update-baseline` ohne `--baseline`, sowie ein
  `--baseline`-Pfad, der ein Verzeichnis ist, werden ebenfalls vorab mit
  einem spezifischen Fehler abgelehnt, bevor irgendeine Analysearbeit
  läuft. Über die ECHTE CLI Ende-zu-Ende verifiziert (nicht nur
  Unit-Tests): ein blockiertes `--update-baseline` beendet sich mit
  Exit-Code ungleich 0 und lässt die bestehende Baseline-Datei
  byte-identisch zurück.

## Regelkatalog (40)

Deklarative Regeln (`rules/default/*.json`), Default aktiv:

| Regel | Prinzip | Dimension | Sprachen |
|-------|---------|-----------|----------|
| R-COMPLEXITY-COGNITIVE | marcus.simplicity | Komplexität | TS, PHP, Dart, C/C++ |
| R-DEEP-NESTING | marcus.simplicity | Komplexität | TS, PHP, Dart, C/C++ |
| R-FN-TOO-MANY-PARAMS | marcus.purpose | Verantwortungsgrenzen | TS, PHP, Dart, C/C++ |
| R-WIDE-PUBLIC-SURFACE | marcus.purpose | Verantwortungsgrenzen | TS/JS |
| R-ERR-SWALLOWED | marcus.obstacle | Fehlerbehandlung | TS, PHP, Dart, C++ |
| R-SIDEEFFECT-NONDETERMINISM | marcus.control | Seiteneffekt-Kontrolle | TS, PHP, Dart, C/C++ |
| R-CPP-UNRELEASED-ALLOCATION | marcus.control | Robustheit, Fehlerbehandlung | C/C++ (ein `new`/`malloc`/`calloc`/`realloc` bleibt ohne Freigabe, ohne Escape, irgendwo in der Funktion) |
| R-CPP-NEW-DELETE-MISMATCH | marcus.control | Robustheit, Fehlerbehandlung | C/C++ (die `new[]`/`new`-Form desselben Zeigers passt nicht zu seiner `delete[]`/`delete`-Form) |
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
| R-SOLID-DIP-LAYER-DIRECTION | marcus.cooperation, marcus.control | Abhängigkeiten | opt-in `--solid`; **experimentell**, semantic-heuristic 0,5, low; Dart: eine UI-Bibliothek (aufgelöste Flutter-Widget-/State-Basis) importiert ein Datenzugriffs-Paket oder ein Datenzugriffs-Modul des Projekts (Stufe 1, Bibliotheksebene) |
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

## C/C++-Memory-Safety-Regeln

Die einzige Stelle im Regelkatalog, an der das EIGENE, unterscheidende
Risiko einer Sprache (manuelle Speicherverwaltung) abgedeckt wird, statt nur
der sprachneutralen Komplexitäts-/Fehlerbehandlungsregeln, die jeder Adapter
bekommt (`src/analysis/cpp/CppExtraction.ts`). tree-sitter hat keine
Symboltabelle und keinen Typchecker — anders als auf der TypeScript-Seite
mit `SymbolResolution.ts` gibt es keinen Binder, gegen den aufgelöst werden
könnte, daher wird der Abgleich über eine echte SCOPE-TRAVERSIERUNG über
Identifier-Text angenähert (`resolveBindingSite()`), nie über Funktionen
oder Dateien hinweg. Innerhalb dieser Einschränkung sind beide Regeln
bewusst konservativ: Ein False Negative wird einem False Positive
vorgezogen (dieselbe durchgängige Tendenz wie im Rest dieser Engine),
bestätigt durch Dogfooding gegen elf echte externe C/C++-Repositories
(nicht nur synthetische Fixtures), bevor dies ausgeliefert wurde.

- **Scope-bewusste, nicht nur text-basierte Identität** (Folge-Spec
  "Analysis Integrity & Memory-Bounded Pipeline"): vor jeder Korrektur
  bestätigt, dass der ursprüngliche reine Text-Abgleich für
  `int* p = new int(1); { int* p = new int(2); delete p; }` NULL Findings
  erzeugte — das innere `delete p` verschluckte das ÄUSSERE Leck.
  `resolveBindingSite()` klettert jetzt nach außen durch umschließende
  `{ }`-Blöcke genau wie die C++-Namensauflösung: Der nächste umschließende
  Block mit einer FRÜHEREN gleichnamigen Deklaration gewinnt. Eine durch
  `#ifdef`/`#else` geschützte Deklaration wird als auf der Scope-Ebene des
  umgebenden Blocks liegend behandelt, nicht eine Ebene tiefer (tree-sitter
  verschachtelt sie so; der Compiler nicht) — und wenn beide sich
  gegenseitig ausschließenden Zweige denselben Namen im selben Block
  deklarieren (tree-sitter parst beide bedingungslos), wird eine spätere
  Freigabe gegen BEIDE Zweige abgeglichen, nicht nur gegen den, der im
  Quelltext zuerst kommt (als echter False Positive in vllms
  `cumem_allocator.cpp` während dieser Korrektur bestätigt, jetzt ein
  Regressionstest). Jeder Deklarator-Identifier in der Funktion (nicht nur
  der dieser Allokation) wird davon ausgeschlossen, jemals als "Nutzung"
  etwas anderem zugerechnet zu werden — ohne das würde der eigene Name
  einer verschattenden Deklaration fälschlich auf die äußere Allokation
  zurückfallen (sie kann sich an ihrem eigenen Deklarationspunkt nicht
  selbst verschatten) und als Übergabe dieses äußeren Zeigers an eine
  andere Deklaration missverstanden werden.
- **Neuzuweisung zu `nullptr` oder einer neuen Allokation ist kein Escape:**
  `p = nullptr;` oder `p = new T(...);` gibt das URSPRÜNGLICHE Objekt nicht
  frei und übergibt es auch nirgendwohin — das Handle wird einfach
  überschrieben. Beide sind von der Escape-Prüfung ausgenommen (anders als
  `other = p;`, was tatsächlich ein Escape ist), sodass die ursprüngliche
  Allokation weiterhin korrekt als Leck markiert wird, wenn sie vorher nicht
  freigegeben wurde.
- **Erfasst:** ein direktes `Type* name = new ...;` / `Type* name = malloc/calloc/realloc(...);`
  (optional cast-umschlossen) in EINER Anweisung. **Nicht erfasst, als Lücke
  dokumentiert, nicht erraten:** ein bloßes `Type* name;` gefolgt von einer
  separaten Zuweisung; mehrere Deklaratoren in einer Anweisung (`int *a, *b;`);
  alles innerhalb einer Lambda (konsistent mit der bestehenden
  Komplexitätsmetrik-Abgrenzung — Lambdas werden gar nicht als eigene
  Einheit analysiert); Placement New (`new (buf) T(...)` konstruiert IN
  vom Aufrufer bereitgestelltem Speicher — es gibt nichts Eigenes
  freizugeben, daher wird es komplett von der Erfassung ausgeschlossen,
  nicht nur von der Leak-Prüfung).
- **Escape-Analyse** (`R-CPP-UNRELEASED-ALLOCATION`): Jede andere Referenz
  auf den allozierten Identifier in der Funktion wird klassifiziert, indem
  durch wertdurchlassende Wrapper geklettert wird (ein Cast, Klammern, ein
  geklammerter Aggregat-Initialisierer, ein Ternary-Zweig — aber NICHT ein
  Dereferenzierungs-/Member-/Subskript-Operator, der den Zeigerwert selbst
  konsumiert statt ihn weiterzugeben), um den nächsten bedeutsamen
  Vorfahren zu finden: ein passendes `delete`/`delete[]`/`free(...)` ist
  eine Freigabe; ein Aufrufargument, ein `return`, eine Neuzuweisung (auf
  beiden Seiten von `=`) oder der Initialisierer einer anderen Deklaration
  ist ein ESCAPE — die Eigentümerschaft könnte übergegangen sein, daher
  wird dann gar keine Leak-Behauptung mehr aufgestellt. Eine `static`-lokale
  Variable wird vorab ausgeschlossen (ein prozesslebensdauerlanges
  „einmal allozieren"-Singleton ist ein bewusstes, wenn auch umstrittenes
  Idiom — kein Bug; gefunden durch Dogfooding gegen `mimirmind`s
  `bigBlockPool()`, im Quellcode explizit mit `// intentionally leaked`
  kommentiert). Alles andere (eine Dereferenzierung, `obj->field`, `arr[i]`,
  eine Null-Prüfung) ist eine gewöhnliche lokale Nutzung — sie gibt den
  Zeiger weder frei noch lässt sie ihn entkommen, sodass eine Allokation,
  die INTERN genutzt, aber nie freigegeben wird, trotzdem korrekt feuert
  (der Recall wird durch den engen Identifier-Text-Abgleich dieser Engine
  nicht geopfert: „allozieren, nutzen, Freigabe vergessen" wird erkannt,
  nicht nur „allozieren und nie wieder berühren").
- **`R-CPP-NEW-DELETE-MISMATCH`** prüft die Array-Eigenschaft der Allokation
  (`new T[n]` vs. `new T`) gegen jedes passende `delete`/`delete[]`, das für
  diesen Identifier gefunden wird, unabhängig von der obigen Escape-Analyse
  (ein Mismatch betrifft das PAAR, nicht ob der Zeiger vorher auch noch
  anderswo entkommt). Fand bei der ersten Anwendung auf echten Code 4
  echte Fälle (Legacy-MFC-C++ in einem Hobbyprojekt, `SMADlg.cpp`:
  `new unsigned char[...]` viermal mit einfachem `delete` freigegeben).
- **Dogfooding behob zwei echte False-Positive-Klassen, bevor dies
  ausgeliefert wurde** (beide jetzt als Regressionstests in
  `test/Cpp.test.ts` festgehalten): (1) Ein Zeiger, der innerhalb eines
  geklammerten Aggregat-Initialisierers zurückgegeben wird
  (`return ComputeBuffer{raw, bytes, deleter};`), wurde nicht als Escape
  erkannt — nur ein bloßes `return raw;` wurde es; (2) Placement New wurde
  wie eine gewöhnliche Allokation erfasst und markierte jede Nutzung als
  nicht freigegebenes Leck. Beide gefunden gegen echte externe
  Repositories, nicht als Hypothesen erfunden.

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
  `finding:`- oder `fact:`-IDs zu verwechseln — deshalb tragen alle zwölf neuen
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
  …) gilt als **unresolved** — nie erraten. Ein `z.object({...})` wird
  zusätzlich **feldweise** aufgelöst: Stoa vergleicht das EINE vom Vertrag
  benannte Feld (`contractRule.field`) über dieselbe skalare
  Kettenauflösung, ohne den Rest der Objektform aufzulösen oder zu erraten.
  Ein vom Schema gar nicht deklariertes Feld, oder eines, dessen eigener
  Wert keine erkannte skalare Kette ist, bleibt namentlich unaufgelöst
  (`Object.hasOwn`, nicht der `in`-Operator — ein Feld, das buchstäblich
  `constructor`/`toString` heißt, wird nie mit einer GEERBTEN
  `Object.prototype`-Eigenschaft verwechselt, und die Felder-Map selbst ist
  ein Objekt ohne Prototyp, sodass ein Feld namens `__proto__` nie
  stillschweigend vom `__proto__`-Setter verschluckt wird, statt gespeichert
  zu werden); ein auflösbares Feld wird genauso verglichen wie ein skalares
  Schema auf oberster Ebene und nimmt an der CONFLICT-Erkennung (zwei
  Implementierungen teilen eine Trace-ID, mit abweichenden Bedingungen für
  genau dieses Feld) genauso teil wie die Bedingungen eines skalaren
  Schemas — ein auf einer Seite fehlendes Feld wird aus dem Vergleich
  komplett ausgeschlossen, nie stillschweigend als „dasselbe" wie ein
  aufgelöstes Geschwister behandelt. Das schließt die Lücke, dass jedes
  realistische `z.object(...)`-Request-Body-Schema — der häufige Fall —
  bedingungslos unaufgelöst war, unabhängig davon, ob sein eines relevantes
  Feld tatsächlich zum Vertrag passte. Objekt-Level-Modifikatoren, die nach
  dem Basis-`z.object({...})` verkettet werden, werden schrittweise
  aufgelöst, nie über diese Liste hinaus erraten: `.strict()` (die Feldmenge
  bleibt unverändert), `.partial()` (jedes Feld wird optional), `.extend({...})`
  (fügt die Felder eines weiteren reinen Objektliterals hinzu, überschreibt
  die Basis bei einer Namensgleichheit), `.merge(<expr>)` (fügt die Felder
  eines anderen Schemas genauso hinzu, wobei `<expr>` entweder inline oder
  über EINEN Identifier-Verweis auf ein separat deklariertes
  `const base = z.object({...})` aufgelöst wird — die realistische Form
  für die Wiederverwendung eines gemeinsamen Basis-Schemas). Jeder andere
  verkettete Aufruf, eine Spread-/Shorthand-/berechnete Property im
  Objektliteral, ein verschachteltes `z.object(...)`-Feld (keine
  gepunkteten/verschachtelten Feldpfade) oder `z.array(z.object({...}))`
  auf oberster Ebene bleibt unaufgelöst.
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
  `persists`/`bypasses`), jede Edge mit: Quell-/Zielknoten, Quelldatei +
  Codeposition, einer kurzen, menschenlesbaren `basis` (die konkrete
  AST-Form, die zutraf — jede Edge lässt sich bis zu konkretem Code
  zurückverfolgen, nicht nur zu einer Behauptung), einem expliziten Status
  (`verified`: eine direkte Argument-Beziehung in derselben Funktion;
  `heuristic`: eine über eine Aufrufgrenze hinweg erschlossene Beziehung;
  `unresolved`: etwas Relevantes gefunden, die Beziehung aber nicht
  nachweisbar), einem optionalen `limits`-Array (vorhanden, sobald der
  Status nicht `verified` ist — was konkret den Nachweis verhindert) und
  `producedBy` (welche Analysefunktion die Edge erzeugt hat, z. B.
  `"OneHopResolution.resolveOneHop"` — damit ein Leser direkt zum Code
  gehen kann, nicht nur zur Prosa). Eine `heuristic`-Edge wird nie als
  `verified` ausgegeben — durch Konstruktion erzwungen: Jede Edge
  entscheidet ihren Status genau einmal, beim Hinzufügen; nichts besucht
  oder erhöht eine Edge danach erneut, und dasselbe (from, to, kind) wird
  nie zweimal mit unterschiedlichem Status hinzugefügt. Zwei Fähigkeiten:
  eine Nachverfolgung innerhalb derselben Funktion bis zu
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
- **Bewusst nicht in diesem Schnitt** (dokumentiert, nicht vorgetäuscht): mehr
  als das EINE vom Vertrag benannte Feld eines `z.object()`-Schemas zu prüfen
  (der Rest seiner Form wird nie untersucht, selbst wenn auflösbar); ein
  verschachteltes `z.object()`-Feld, eine Spread-/Shorthand-/berechnete
  Property, oder `z.array(z.object({...}))`; die Nachverfolgung eines
  validierten Werts über ein `return` hinaus zu den Aufrufern der Funktion;
  cross-file-Nutzungsnachweis; API-Endpunkt-/Alternative-Endpunkt-Bypass-
  Erkennung; Schicht-Heuristik (Frontend/Backend) für den Konflikt-Check;
  strukturierte, maschinell geprüfte Backend-only-Sicherheitsanforderungen
  (`securityRequirements` bleibt Freitext, rein informativ — bewusst
  **nicht** als verifizierte Sicherheitsregel ausgegeben, siehe
  `ui-ux-analysis-report`-artige Zurückhaltung); andere Sprachen als
  TypeScript.
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

`file.lineCount`, `file.parseErrors` (Dart), `dart.importSpec`, `dart.classDecl`, `struct.typeDecl` (Dart, TS), `struct.importBindings` (TS), `ui.flutterWidgetTree`, `metric.exportCount`, `metric.cyclomaticComplexity`,
`metric.cognitiveComplexity`, `metric.nestingDepth`, `metric.parameterCount`,
`metric.functionLength`, `doc.hasComplexityRationale`, `ast.usesNondeterminism`,
`ast.emptyCatch`, `ast.catchSwallowsError`, `doc.catchHasRationale`, `deps.import`, `deps.importUnused`,
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

- **273 node:test-Fälle** grün (Regeln pos./neg., Extraktion, Schema-Validierung,
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
  (kein zweiter Ground-Truth-Mechanismus), der 20 explizit geforderte
  Testgruppen an einer Stelle abdeckt — korrekte Validierung, fehlende
  Validierung, ein unbenutzter Validator, ein aufgerufener, aber ignorierter
  Validator (rohe Wiederverwendung nach Validierung), eine in einer nie
  aufgerufenen Funktion deklarierte Validierung, funktionsübergreifende
  Übergaben (sowohl ein nachverfolgter, validierter guter Pfad als auch ein
  roher, unvalidierter schlechter Pfad), `.max()`-Merging, Format-UND-Merging,
  ein nicht auflösbarer Zod-Modifier, ein AST-verifizierter `.bind()`-Alias,
  eine vom Request unabhängige generische Exception, Mass Assignment über
  Spread, Security-Anforderungen, die Stoa nicht prüfen kann (geprüft, dass
  NICHTS erzeugt wird), widersprüchliche FE/BE-Implementierungen unter einer
  Trace-ID, symbolbasierte Verschattung (ein in einem verschachtelten Block
  verschattetes `result` erzeugt korrekt NICHTS und belegt
  `SymbolResolution.ts` damit end-to-end, nicht nur in dessen eigenen
  Unit-Tests), eine `.safeParse()`-Nutzung ohne nachgewiesene
  Erfolgsprüfung (`R-VALIDATION-CONTRACT-SAFEPARSE-UNGUARDED`), ein
  Object-Field-Konflikt zwischen zwei `z.object()`-Schemas unter einer
  Trace-ID, ein Feld, das buchstäblich `constructor` heißt (erzeugt korrekt
  NICHTS und belegt die Prototype-Safety-Korrektur end-to-end), sowie ein
  verschachteltes `z.object()`-Feld (bleibt unaufgelöst statt erraten zu
  werden). 100 %/100 % (TP 20). Der Bau dieses Korpus deckte einen
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

**Cross-Layer-Analyse — Reifegrad für eine Ende-zu-Ende-Kette (Bestandsaufnahme,
kein neues Feature):** Das langfristige Ziel ist eine belegbare Kette
Frontend-Eingabe → Frontend-Validierung → API-Request → Backend-Request →
Backend-Validierung → Validierte Daten → Service → Repository → Datenbank.
Heute ist nur **ein Ring** dieser Kette tatsächlich im Evidence Graph belegt:
Backend-Request → Backend-Validierung → Validierte Daten → (dateiintern, oder
einen dateiinternen Schritt weit in einen) Service-/Repository-Aufruf
(`ValidationDataflow.ts`/`OneHopResolution.ts`/`SafeParseGuard.ts`,
symbolbasiert, mit ehrlichem `verified`/`heuristic`/`unresolved`-Status je
Edge — siehe oben). Alles auf beiden Seiten dieses Rings ist entweder gar
nicht modelliert oder nur eine menschlich behauptete Angabe, nie unabhängig
beobachtet:
- **Frontend-Eingabe / Frontend-Validierung:** Es gibt überhaupt keine
  frontend-spezifischen Facts. Ein Vertrag mit `layers: ["frontend"]` wird
  akzeptiert und schema-validiert, aber — anders als die `backend`-Behauptung,
  die Stoa tatsächlich über Datenfluss-Evidenz bestätigt — gibt es keinen
  analogen Beleg für die Frontend-Seite; eine `frontend`-Behauptung erzeugt
  keinen Befund, weder positiv noch negativ (siehe oben, Schicht- &
  Security-Zuordnung).
- **API-Request:** Es gibt keine Facts für die Request-Schicht selbst
  (HTTP-Methode, Route, Request-/Response-DTO-Form). Nichts verknüpft „diese
  Frontend-Datei ruft `fetch('/api/users')` auf" mit „diese Backend-Datei
  routet `router.post('/users', handler)`" — das ist der größte fehlende
  Baustein für eine echte Ende-zu-Ende-Verknüpfung, und nichts in der
  aktuellen Implementierung behauptet etwas anderes.
- **Service → Repository → Datenbank:** Der One-Hop-Resolver arbeitet nur
  dateiintern; ein validierter Wert, der an einen aus einer anderen Datei
  importierten Service übergeben wird, wird gar nicht nachverfolgt. Selbst wo
  nachverfolgt wird, beweist Stoa nur, dass der Wert einen Aufruf erreicht,
  der dem NAMEN nach wie ein Persistenz-Verb aussieht
  (`save`/`create`/`repository.*`/…) — Stoa hat kein Modell dafür, was dieser
  Aufruf tatsächlich schreibt, in welche Tabelle oder Spalte; über die
  Datenbank selbst wird nichts belegt, nur bis zur Grenze des
  Repository-Aufrufs.
- **FE/BE-Konflikterkennung** (`R-VALIDATION-CONTRACT-CONFLICT`) vergleicht
  zwei Schemas, die eine menschlich gewählte Validation Trace ID teilen — das
  ist ein Beleg dafür, dass zwei *annotierte* Implementierungen voneinander
  abweichen, kein Beweis, dass diese beiden Schemas tatsächlich denselben
  realen API-Request beschreiben. Die Trace-ID ist eine bewusste, explizite
  Opt-in-Annotation, genau damit **Frontend und Backend niemals allein
  deshalb als verbunden gelten, weil sie ein gleichnamiges Feld validieren**
  — übereinstimmende Feldnamen allein sind kein Ersatz für eine echte
  Request-/Response-Verknüpfung und dürfen das nicht werden.

Kurz: tatsächlich verbunden (Backend-Request → Backend-Validierung →
Persistenz, innerhalb der obigen Grenzen), plausibel-aber-unbewiesen (eine
`frontend`-Schicht-Behauptung, die übrigen `security`-Flags), nicht
vorhanden (API-Request-/DTO-Facts, dateiübergreifende Service-Auflösung,
jedes Modell der Datenbank selbst) und mit dem aktuellen Faktenmodell nicht
analysierbar (ob zwei Trace-ID-gleiche Schemas wirklich denselben Endpunkt
beschreiben) sind heute vier unterschiedliche Zustände, und Stoas eigene
Befunde unterscheiden bereits den ersten von den übrigen — aber eine volle,
belegbare Ende-zu-Ende-Kette ist nicht implementiert, und nichts hier
behauptet das Gegenteil.

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
