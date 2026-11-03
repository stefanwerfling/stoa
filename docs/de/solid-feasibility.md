# SOLID als Analysebereich – Machbarkeitsanalyse (Flutter-Qualitätsstrang, Phase D)

> Status: **Analyse, keine Implementierung.** Es gibt keine `R-SOLID-*`-Regel.
> Grundlage sind der Code-Stand nach Phase C und Messungen mit einem Wegwerf-Prototyp.
> Der Prototyp lief an vier echten Flutter-Apps (swipemeister, mwpa-app, velyo,
> movinder) und an zwei TypeScript-Codebasen (stoa/src, flyingfish/backend).
> Er ist nicht Teil des Repositorys. Englische Fassung: [../en/solid-feasibility.md](../en/solid-feasibility.md).

## 0. Kurzfassung

- **SOLID passt als eigener Regelbereich, aber nicht als eigene Wissensbasis.**
  - Die fünf Prinzipien lassen sich vollständig auf vorhandene Prinzipien abbilden:
    `marcus.purpose` (Kohäsion, „single responsibility“), `marcus.cooperation`
    (Abhängigkeitsrichtung), `marcus.judgment` (Deklaration = Verhalten) und
    `marcus.simplicity`.
  - Ebenso auf vorhandene Dimensionen: `responsibility-boundaries` und `dependencies`.
  - Ein Bereich `R-SOLID-*` ist damit eine Regelfamilie, kein neues Fundament.
- **Die zentrale Lücke ist das Klassenmodell.**
  - Keine Sprache liefert heute Facts über Klassenmitglieder: Methoden, Felder,
    Konstruktorparameter samt Typen, Overrides oder Zugriffe zwischen Mitgliedern.
  - Nur Dart hat Typdeklarationen (`dart.classDecl`: Supertyp, Mixins, Interfaces, abstrakt).
  - `deps.export` (TS) kennt nur den Namen, nicht die Art der Deklaration.
  - Dart fehlt im ModuleGraph, weil es keine `deps.import`-Facts erzeugt.
- **Die Empirie ist ernüchternd für die „klassischen“ Signale.**
  - LCOM-Kohäsion, Typ-Dispatch und Service-Namensmuster lieferten an den sechs
    Codebasen fast nur Artefakte oder legitime Muster.
  - Präzise Signale wie degenerierte Overrides oder eine Datenzugriffs-Abhängigkeit
    in UI-Dateien sind selten, aber belastbar.
- **Empfohlene Reihenfolge für Phase E** (Begründung in §7):
  1. **DIP-Schicht:** Eine UI-Einheit hängt direkt von Datenzugriff oder I/O ab.
     Nachweis per deklarierter Schichtzuordnung (R6) oder per Paketklassifikation.
  2. **LSP/ISP-Vertrag:** Ein Override wirft `UnsupportedError`/`UnimplementedError`
     bzw. `Error('not implemented')` oder ist leer, gegen eine abstrakte Projektdeklaration.
  3. **SRP-Kohäsion:** nur als experimenteller Hinweis, erst nach Klassenmodell und Kalibrierung (OQ-6).
  4. **OCP:** vorerst keine Regel.
  5. **DIP über konkrete Konstruktortypen:** keine Regel, höchstens Metrik bzw. Evidence.

## 1. Was heute verfügbar ist

| Quelle | TS | PHP | Dart | C/C++ | Für SOLID nutzbar |
|---|---|---|---|---|---|
| `deps.import`/`deps.importName`/`deps.export` | ja | Import ja | – (eigenes `dart.importSpec`) | – | DIP-Richtung (Modulebene) |
| ModuleGraph (Phase 0) | ja | ja | **nein** | nein | Zyklen, Schichtrichtung |
| SymbolGraph (Phase 1) | ja | – | nein | nein | welche Bindung wohin; **keine** Deklarationsart |
| DartLibraryIndex (Phase B) | – | – | ja | – | Identität „Framework vs. Projekt vs. mehrdeutig“ |
| `dart.classDecl` | – | – | ja | – | Hierarchie, `abstract`, Interfaces |
| `metric.*` (Funktionslänge, Komplexität, Parameterzahl) | ja | ja | ja | ja | nur Größe, kein Strukturverständnis |
| FlutterWidgetGraph | – | – | ja | – | UI-Struktur, nicht Architektur |
| `dart.stateLifecycle` | – | – | ja | – | Felder und Erzeugungen eines State (nur State-Klassen) |
| Typinformation | ts-morph-Typchecker (im Extraktor vorhanden) | – | – | – | Interface vs. Klasse auflösbar, sofern tsconfig/Pfade auflösbar |

Für **jedes** SOLID-Prinzip fehlt ein neutrales **Klassen-/Mitgliedermodell**.
Es müsste pro Typdeklaration enthalten:

- Art (Klasse, abstrakt, Interface, Mixin, Enum) und Supertypen;
- Mitglieder mit Name, Art, Override-Markierung und Rumpfform (leer, wirft „nicht
  unterstützt“, abstrakt, normal);
- Felder mit deklariertem Typ und Konstruktorparameter mit Typ;
- je Methode die Menge der referenzierten eigenen Mitglieder.

## 2. Empirie (Prototyp-Messung, nicht im Repo)

Der Prototyp nutzt tree-sitter-dart bzw. ts-morph mit denselben Parsern wie stoa. Er misst die Signale, die die Spezifikation vorschlägt.

| Signal | Dart: 4 Apps (326 Dateien, 640 Klassen) | TS: stoa/src (33 Klassen) + flyingfish/backend (214 Klassen) |
|---|---|---|
| Klassen mit Parse-Fehler im Rumpf (Dart 3) | 13 (2 %; velyo 11/202 = 5 %) | – |
| Klassen mit ≥ 8 Methoden | 55 | 3 + 8 |
| … davon LCOM4 mit ≥ 2 nicht-trivialen Komponenten | 14 | 0 + 0 |
| UI-Klassen in Dateien mit Datenzugriffs-Import (`http`, `dio`, `shared_preferences`, `sqflite`, `cloud_firestore`, …) | 8 von 362 (alle in mwpa-app, `shared_preferences`) | – |
| Konstruktor-/Feldtypen: Projekt-abstrakt / Projekt-konkret / extern | 3 / 214 / 1638 | Interface 4 / konkret 4 / unbekannt 13 |
| `new` bzw. Konstruktoraufruf eines Projekt-„Service“ (Namensmuster) | 25 | 7 |
| Statischer Singleton-Zugriff `X.instance` | 112 | – |
| abstrakte Projektklassen / Interfaces | 6 (Konstanten-Container, Lokalisierung) | 139 (stoa) / 6 (flyingfish) |
| leere oder „nicht unterstützt“ werfende Overrides | 0 | 0 |
| Typ-Dispatch (`is`/`instanceof`-Kette ≥ 3, `switch (x.runtimeType)`) | 1 | 0 |

Was die Treffer tatsächlich sind (manuell geprüft):

- **LCOM4 (14 Treffer):**
  - 13 sind State-Klassen der Avatar-Animationen in swipemeister. Die Aufspaltung
    verläuft über Framework-Lifecycle-Mitglieder (`initState`/`dispose`/
    `didUpdateWidget`, das Mixin-Getter `animate`) und über geerbte Mitglieder
    (`widget`, Mixin-Methoden). Das sind **Artefakte** eines Modells ohne geerbte
    Mitglieder.
  - Der 14. Treffer (`DynInputValue`) ist ein Werthalter mit typisierten Accessoren
    je Variante. Das ist eher ein Union-Typ als eine SRP-Verletzung, also mehrdeutig.
- **Typ-Dispatch (1 Treffer):** `ApiService._logError` unterscheidet Exception-Typen
  (`SocketException`, `TimeoutException`, …). Das ist eine geschlossene, externe Menge
  und **legitim**, keine OCP-Verletzung.
- **„Service“-Instanziierung:**
  - Bei `Provider` in swipemeister ist ein **Datenmodell** gemeint
    (`Model/Provider.dart`). Namensmuster sind unzuverlässig.
  - Die 7 TS-Treffer in flyingfish sind **selbst-instanziierende Singletons**
    (`getInstance()`), ein Muster und keine fremde Abhängigkeit.
- **Singletons** (`ContentRepository.instance`, `Audio.instance`,
  `ConnectivityBus.instance`): Das ist der vorherrschende Abhängigkeitsstil der Apps.
  Mitgezählt sind Framework-Singletons (`WidgetsBinding.instance`), die erst die
  Identitätsauflösung (Phase B) trennen würde.
- **Abstraktionen fehlen in den Apps fast vollständig.** Eine Regel „hängt von
  konkretem Typ ab“ würde dort praktisch jede Abhängigkeit melden. Das wäre ein
  pauschales Urteil, das Spec §8 ausdrücklich ausschließt.

Folgerung: Mit Größen- und Namensmetriken entsteht kein Architekturverständnis (§8). Belastbar sind nur Signale, die an eine **nachweisbare Struktur** gebunden sind: Vertrag, Schicht, Identität.

## 3. Die fünf Prinzipien einzeln

### 3.1 SRP – `R-SOLID-SRP-RESPONSIBILITY-COHESION`

- **Signale:**
  - Zerfall der Methoden in unabhängige Gruppen (gemeinsam genutzte Felder bzw.
    Aufrufe, LCOM4);
  - disjunkte Abhängigkeitsgruppen (Gruppe A nutzt nur Netz-Importe, Gruppe B nur UI);
  - Mischung aus UI, Datenzugriff und Geschäftslogik in einer Klasse.
- **Benötigt:**
  - das Klassen-/Mitgliedermodell mit Mitglied→Mitglied- und Mitglied→Import-Referenzen;
  - zusätzlich das Wissen über **geerbte und Framework-Mitglieder**: `widget`,
    `context`, `setState`, Lifecycle-Hooks und Mixin-Verträge gehören aus der
    Kohäsionsrechnung heraus bzw. als Bindeglied hinein.
- **Grenzen:**
  - Kohäsion über Konventionen (Lifecycle, Mixins, Callbacks im `build`) ist statisch
    nur mit Framework-Wissen sichtbar.
  - Dynamische Zugriffe (Reflection, `noSuchMethod`) sind nicht sichtbar.
  - Dart-3-Syntax ist für tree-sitter-dart 1.0 nicht parsbar (2–5 % der Klassen).
- **Fehlalarm-Risiko: hoch.** Gemessen waren 13 von 14 Treffern Artefakte. Größe allein ist kein Befund (Spec).
- **Bewertung: bedingt machbar.**
  - Nur als `info`-Hinweis mit `semantic-heuristic`, Konfidenz ≤ 0,5 und Status experimentell.
  - Die Evidence muss die Gruppen benennen (Methoden + Felder + Importe je Gruppe),
    nicht eine Kennzahl.
  - Voraussetzung ist eine Kalibrierung am Korpus (offene Frage OQ-6).

### 3.2 OCP – `R-SOLID-OCP-EXTENSION-COUPLING`

- **Signale:**
  - wiederholter Typ-Dispatch über dieselbe **eigene, offene** Hierarchie an mehreren Stellen;
  - zentrale Registries bzw. Factories, die bei jeder Erweiterung geändert werden müssen.
- **Benötigt:**
  - Typhierarchie (Dart vorhanden, TS über ts-morph);
  - Dispatch-Facts (`is`/`instanceof`/`switch` auf Typ oder `runtimeType`);
  - für „wiederholte Anpassung“ die Git-Historie (Baseline/Temporal ist nur rudimentär vorhanden).
- **Grenzen:**
  - In Dart 3 sind `sealed`-Hierarchien mit erschöpfendem `switch` das
    **idiomatische, compilergeprüfte** Muster. Dispatch ist dort kein OCP-Problem.
  - Genau diese Syntax kann tree-sitter-dart 1.0 nicht parsen.
  - Dispatch über externe, geschlossene Mengen (Exceptions, Enums) ist legitim.
  - Der Orientierungsartikel benutzt selbst eine `is`-Kette im OCP-Beispiel.
- **Fehlalarm-Risiko: sehr hoch.** Der einzige gemessene Treffer war legitim.
- **Bewertung: derzeit nicht zuverlässig.** Allenfalls später: dieselbe offene
  Projekt-Hierarchie wird an ≥ 2 Stellen per Typ-Kette dispatcht und ist **nicht** `sealed`.

### 3.3 LSP – `R-SOLID-LSP-CONTRACT-COMPATIBILITY`

- **Statisch erkennbar:**
  - ein Override, der das geerbte Verhalten verweigert: Er wirft
    `UnsupportedError`/`UnimplementedError` bzw. `new Error('not implemented')`, oder er
    ist leer, obwohl die Basis kein No-op ist;
  - in Dart `covariant`-Parameter (bewusste Einschränkung des Parametertyps);
  - in TS Overrides, die eine Basismethode mit einer schmaleren Parameterunion
    überschreiben (Typchecker nötig).
- **Nicht statisch erkennbar:** veränderte Vor- und Nachbedingungen, verletzte
  Invarianten, „unerwartete“ Exceptions jenseits der Muster. Dafür bräuchte es
  Verträge, Tests oder Dataflow.
- **Benötigt:** Mitgliedermodell mit Override-Bezug und Rumpfform, außerdem die
  Identität der Basis (Projekt vs. Framework über DartLibraryIndex bzw. SymbolGraph).
- **Fehlalarm-Risiko: niedrig für die Rumpfmuster, gemessen 0 Treffer.**
  - Ausnahmen: Framework-Hooks, deren Basis ein No-op ist (`dispose`, `didUpdateWidget`), und Test-Doubles.
  - Ein leerer Override gegen eine *abstrakte* Methode ist kein LSP-Bruch, sondern eine
    Implementierung als No-op (ISP-Hinweis, siehe 3.4).
- **Bewertung: machbar, aber selten.** Präzise Regel mit kleiner Reichweite.
  „Vererbung bzw. Override ist ein Problem“ wird ausdrücklich nicht geprüft.

### 3.4 ISP – `R-SOLID-ISP-INTERFACE-COHESION`

- **Signale:**
  - Implementierungen, die Teile eines Interfaces mit „nicht unterstützt“ bzw. leer
    erfüllen, das ist der *belastbare* Kern;
  - Nutzer, die von einem breiten Interface nur eine kleine, stabile Teilmenge
    verwenden (Verwendungsanalyse über SymbolGraph und Mitgliederzugriffe).
- **Grenzen:**
  - Mitgliederzugriffe über Variablen erfordern Typauflösung. Für TS ist das per
    ts-morph machbar, für Dart nur syntaktisch (kein Typchecker).
  - „Groß“ allein ist kein Befund. stoa selbst hat 139 Interfaces (p90 = 9 Mitglieder),
    überwiegend Daten- bzw. Fact-Formen.
- **Fehlalarm-Risiko:**
  - niedrig für degenerierte Implementierungen eines **Projekt**-Interfaces;
  - hoch für die Verwendungsbreite: Datentypen werden selten vollständig gelesen.
- **Bewertung:** Die degenerierte Implementierung ist machbar und teilt sich die
  Facts mit 3.3. Die Verwendungsbreite ist erst nach Typauflösung sinnvoll.

### 3.5 DIP – `R-SOLID-DIP-CONCRETE-DEPENDENCY`

- **Signale (getrennt bewerten):**
  - **Schichtrichtung:** UI (Widget, State, Seite) hängt direkt von Datenzugriff
    oder I/O ab, also von Paketen wie `http`/`dio`/`shared_preferences`/`sqflite`/
    `cloud_firestore` bzw. von Projektmodulen der Datenschicht.
  - **Selbsterzeugung:** UI erzeugt einen Projekt-Service selbst (`MwpaApi()` in
    `_LoginPageState`) oder greift auf einen Singleton zu (`X.instance`).
  - **Konkrete Typen:** Konstruktor- und Feldtypen sind konkrete Projektklassen statt Abstraktionen.
- **Unterscheidung je Abhängigkeit:**
  - *Abstraktion*: Interface, abstrakte Klasse, Typparameter;
  - *konkret*: nicht-abstrakte Projektklasse;
  - *dynamisch bzw. unbekannt*: unaufgelöster Typ, `dynamic`, externer Typ ohne
    Wissen, Ergebnis eines DI-Containers (`GetIt.I<T>()`, `context.read<T>()`). Dieser Fall wird nie gemeldet.
- **Benötigt:**
  - Dart im ModuleGraph (aus `dart.importSpec` + DartLibraryIndex; heute fehlt das);
  - eine **Schichtzuordnung**: deklariert per R6 (Architektur-Config, bereits in der
    Roadmap) oder klassifiziert über Pakete (Datenzugriffspakete, Flutter-UI-Identität);
  - Identität der instanziierten bzw. referenzierten Typen (Phase B).
- **Fehlalarm-Risiko:**
  - Schichtrichtung mit Deklaration: **niedrig**, denn der Verstoß gegen eine
    *deklarierte* Regel ist nachweisbar (vgl. `R-DEP-CYCLE`).
  - Schichtrichtung per Paketklassifikation: **mittel**, gemessen 8 UI-Klassen in einer App.
    Kleine Apps greifen bewusst direkt zu, die Meldung ist ein Hinweis, kein Fehler.
  - Selbsterzeugung: **mittel**. Singleton-Muster und Datenmodelle mit Service-Namen sind
    häufig; nur mit Identität (Projektklasse, nicht abstrakt) und ohne Namensmuster tragfähig.
  - Konkrete Konstruktortypen: **hoch**. In Apps ohne Abstraktionen trifft es alles.
- **Bewertung:**
  - Schichtrichtung: **am besten machbar**, mit Deklaration sicher, ohne als Hinweis.
  - Selbsterzeugung: bedingt machbar.
  - Konkrete Typen: keine Regel.

## 4. SOLID und Flutter (§7)

- Der **FlutterWidgetGraph bleibt UI-Struktur**. Architekturinformation gehört nicht hinein.
  Flutter liefert stattdessen *zusätzliche Evidenz* über vorhandene Quellen:
  - **UI-Identität einer Klasse** (`extends State`/`StatelessWidget`/`StatefulWidget`,
    aufgelöst per DartLibraryIndex): ordnet Klassen der UI-Schicht zu (DIP-Schicht, SRP-Gruppen).
  - **`build()`-Inhalt:** Aufrufe, die keine Widgets erzeugen (Netz, DB, Berechnung).
    Dafür reicht ein kleiner, eigener Fact je `build`. Der Widget-Graph trägt das nicht.
  - **`dart.stateLifecycle`:** Er kennt Felder und Erzeugungen eines State und ist für
    „erzeugt eigene Services“ wiederverwendbar.
- Die Beispiele aus §7 zugeordnet:

  | Beispiel aus §7 | Zuordnung |
  |---|---|
  | Widgets mit UI + Datenzugriff | DIP-Schicht |
  | große State-Klassen | SRP-Kohäsion, nur mit Lifecycle-Wissen |
  | Geschäftslogik in `build` | SRP-Flutter-Evidenz |
  | Widgets erzeugen Services | DIP-Selbsterzeugung |
  | breite Abhängigkeiten | ISP-Verwendung, später |
  | austauschbare Widgets | LSP, selten relevant |

- **Sprachübergreifend:** Die Regeln werten nur das neutrale Klassenmodell und
  ModuleGraph/SymbolGraph aus. Flutter, Angular oder React liefern lediglich die
  Schichtzuordnung „UI“ bzw. Framework-Mitglieder über ihre Adapter.

## 5. Konzept: SOLID als sprachübergreifender Bereich

1. **Facts (je Adapter, dateilokal, cachebar):** `struct.typeDecl` (Art, Supertypen,
   abstrakt) und `struct.member` (Art, Override, Rumpfform, deklarierter Typ,
   referenzierte eigene Mitglieder, referenzierte Import-Bindungen).
   - Dart: Erweiterung der Deklarations-Facts (`dart.classDecl` bleibt).
   - TS: ts-morph. PHP und C++: tree-sitter, später.
   - Wie alle Facts sind sie neutral und ohne Urteil.
2. **Modell (nach der Extraktion, nur aus Facts, wie ModuleGraph/SymbolGraph):** ein
   `TypeModel` mit Hierarchie, aufgelösten Supertypen über SymbolGraph bzw.
   DartLibraryIndex sowie Mitgliedern samt geerbten Mitgliedern, soweit sie
   Projekt-Deklarationen sind. Unbekannte Supertypen bleiben unbekannt.
3. **Schichten:** Die Deklaration erfolgt über die geplante Architektur-Config (R6).
   Ohne Config gibt es nur paketbasierte Hinweise.
4. **Regeln:** `R-SOLID-*` als Projektregeln, mit Prinzipien und Dimensionen aus dem Bestand:

   | Regel | Prinzip | Dimension |
   |---|---|---|
   | SRP | `marcus.purpose` | `responsibility-boundaries` |
   | DIP | `marcus.cooperation` (+ `marcus.control` bei I/O in UI) | `dependencies` |
   | LSP | `marcus.judgment` | `responsibility-boundaries` |
   | ISP | `marcus.purpose` | `responsibility-boundaries` |

5. **Einordnung der Sicherheit:**
   - `syntactic`: nur für Verstöße gegen *Deklariertes* (Schicht-Config) und für
     degenerierte Overrides gegen Projekt-Abstraktionen;
   - `semantic-heuristic` mit Konfidenz ≤ 0,6: alles andere;
   - Schweregrad höchstens `low`, außer bei deklarierten Schichtverstößen (`medium`).

## 6. Regelarchitektur: sicher vs. heuristisch (§8)

- **Vorhanden:**
  - `Certainty` (`syntactic` | `semantic-heuristic` | `external-tool`);
  - getrennte `severity` und `confidence`;
  - `certaintyBasis` im Finding;
  - Konfidenz-Cap nach Sicherheit für **deklarative** Regeln (`capBy: certainty`,
    heuristisch ≤ 0,6);
  - `missingContext` für Erkennungsgrenzen.
- **Lücken** (nur Befund, in Phase D nicht geändert):
  - Projektregeln setzen `certaintyBasis` und `confidence` selbst, **ohne** zentrales Cap.
    Beispiel: `R-VALIDATION-CONTRACT-MISMATCH` meldet `semantic-heuristic` mit 0,7,
    also über dem Cap 0,6 deklarativer Regeln.
  - Es gibt keinen Regelstatus „experimentell“. Die Abschwächung R-2 aus open-questions
    nennt ihn, er existiert aber nicht.
  - Die CLI kann nicht nach Sicherheit oder Konfidenz filtern.
  - Für einen heuristischen SOLID-Bereich sind diese drei Punkte Voraussetzung, sonst
    vermischen sich SOLID-Hinweise mit sicheren Befunden.

## 7. Priorisierung (Empfehlung für Phase E)

| Rang | Regel(variante) | Zuverlässigkeit | Nutzen | Voraussetzungen |
|---|---|---|---|---|
| 1 | DIP-Schicht: UI → Datenzugriff bzw. I/O | hoch mit R6-Config, mittel ohne | hoch (häufigster Strukturfehler in Flutter-Apps) | Dart im ModuleGraph, Schichtklassifikation, R6 |
| 2 | LSP/ISP: degenerierter Override bzw. degenerierte Implementierung gegen Projekt-Abstraktion | hoch | gering bis mittel (selten) | `struct.typeDecl`/`struct.member`, TypeModel |
| 3 | DIP-Selbsterzeugung: UI erzeugt Projekt-Service bzw. greift auf Singleton zu | mittel | mittel | wie 2 + Identität; Muster-Ausnahmen (Singleton-Fabrik, Datenmodelle) |
| 4 | SRP-Kohäsion (experimentell) | niedrig bis mittel | mittel | wie 2 + geerbte und Framework-Mitglieder, Kalibrierung OQ-6, Regelstatus „experimentell“ |
| – | OCP-Dispatch | niedrig | gering | Dart-3-Parser, Historie |
| – | DIP konkrete Typen | niedrig (pauschal) | gering | nur als Metrik |

Querschnittliche Vorarbeiten, ohne die keine SOLID-Regel sinnvoll ist:

- Dart im ModuleGraph;
- das neutrale Klassenmodell;
- ein Konfidenz-Cap auch für Projektregeln;
- ein Regelstatus „experimentell“ bzw. ein CLI-Filter.

## 8. Entworfene Testfälle (Machbarkeitsnachweis)

Erwartung: **M** = melden, **S** = schweigen. Jede spätere Regel bekommt diese Fälle als Fixtures.

| Prinzip | Fall | Erwartung |
|---|---|---|
| DIP-Schicht | `_LoginPageState` importiert `package:http/http.dart` und ruft `http.post` | M (Hinweis; mit R6-Config: Verstoß) |
| DIP-Schicht | Seite erhält ein `AuthRepository` (abstrakt) per Konstruktor | S |
| DIP-Schicht | Seite liest `context.read<AuthRepository>()` bzw. `GetIt.I<…>()` | S (Abhängigkeit dynamisch, unbekannt) |
| DIP-Schicht | Datei ohne UI-Klasse importiert `dio` | S |
| DIP-Selbsterzeugung | `State` erzeugt `MwpaApi()` (konkrete Projektklasse) | M |
| DIP-Selbsterzeugung | `State` erzeugt `Provider(...)`, eine Datenmodellklasse (keine Ressource, kein I/O) | S (kein Namensmuster) |
| DIP-Selbsterzeugung | `class S { static final instance = S(); }`: Selbst-Singleton | S |
| DIP-Selbsterzeugung | Mehrdeutige Identität des erzeugten Typs (Phase B) | S |
| LSP | `class Fast extends Cache { @override void put(k, v) => throw UnsupportedError('…'); }`, `Cache.put` konkret | M |
| LSP | Override wirft `ArgumentError` nach Validierung | S |
| LSP/ISP | `class Mock implements Repo { @override Future<void> sync() async {} }`, `Repo.sync` abstrakt | S für LSP; ISP-Hinweis nur, wenn ≥ 2 Mitglieder degeneriert sind |
| LSP | `@override void dispose() {}` in einer State-Unterklasse (Framework-No-op-Basis) | S |
| ISP | `implements Printer, Scanner`: alle Mitglieder implementiert | S |
| ISP | `implements Device` mit 3 von 5 Mitgliedern, die `UnimplementedError` werfen | M |
| SRP | Klasse mit zwei Methodengruppen, die disjunkte Felder **und** disjunkte Importgruppen nutzen (Netz vs. Formatierung) | M (experimentell, Gruppen als Evidence) |
| SRP | State-Klasse, deren Gruppen nur über `widget`/Lifecycle/Mixin verbunden sind | S |
| SRP | Werthalter mit Accessor-Paaren je Variante (`DynInputValue`) | S |
| SRP | Große Klasse mit einer zusammenhängenden Gruppe | S (Größe ist kein Befund) |
| OCP | `if (e is SocketException) … else if (e is TimeoutException) …` | S (externe, geschlossene Menge) |
| OCP | `switch (shape) { case Circle(): … }` über `sealed` | S (und: Dart 3 nicht parsbar → unbekannt) |
| alle | Klasse mit Parse-Fehler im Rumpf | S, mit Abdeckungsvermerk |

## 9. Erkennungsgrenzen und offene Entscheidungen (für Phase E)

- **Parser:** tree-sitter-dart 1.0 kennt kein Dart 3 (sealed, Patterns, Records,
  Switch-Ausdrücke). OCP und Teile von SRP sind dadurch für moderne Dart-Codebasen
  unvollständig. Ein Grammatik-Update wäre eine eigene, begründungspflichtige Abhängigkeitsänderung.
- **Typinformation:** Dart hat keinen Typchecker in stoa. ISP-Verwendungsbreite und
  DIP über Variablen bleiben für Dart syntaktisch begrenzt.
- **Historie:** „Wiederholte Anpassung“ (OCP, SRP) braucht Git-Historie, die nicht im Fact-Modell steckt.
- **Zu entscheiden:**
  1. Soll Rang 1 auf R6 (deklarierte Schichten) warten oder zuerst als Hinweis über
     Paketklassifikation kommen?
  2. Sollen SOLID-Regeln standardmäßig aktiv sein oder opt-in (wie `--dead-exports`)?
  3. Soll ein Regelstatus „experimentell“ bzw. ein Konfidenzfilter Teil von Phase E sein?
