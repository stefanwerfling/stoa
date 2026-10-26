# Technologieentscheidung – Architekturvergleich & Empfehlung

> Status: Konzeptphase. Enthält eine **begründete vorläufige Empfehlung**,
> keine endgültige Festlegung. Zu klärende Punkte: siehe
> [open-questions.md](./open-questions.md).

## 1. Kontext / beobachtete Rahmenbedingungen

Aus dem vorhandenen Repository und der IDE-Konfiguration (`.idea/`) ist der
technische Kontext des Projektumfelds ablesbar:

- **PHP-Ökosystem** mit starker statischer Analyse ist bereits etabliert:
  PHPStan, Psalm, PHP_CodeSniffer, PHPMD, PHP-CS-Fixer sind konfiguriert.
- **Node.js / TypeScript** ist ebenfalls eingerichtet (JS-Library-Mapping
  „Node.js Core").
- Das Repository selbst ist noch leer (nur `LICENSE` MIT, `README.md`), es gibt
  also **keine** bestehenden Code-Konventionen, die eine Wahl erzwingen.

Zwei Schlüsse daraus:
1. Das Team ist mit **statischer Analyse vertraut** – *stoa* sollte diese
   Werkzeuge **integrieren**, nicht ersetzen (Nichtziel N3).
2. Die naheliegenden **ersten Zielsprachen** sind TypeScript/JavaScript und PHP.

## 2. Zu vergleichende Varianten

- **Variante A – C++20-Kern**: native Engine, eigene/angebundene Parser,
  Regel-Engine, KB, API.
- **Variante B – TypeScript/JavaScript-Kern**: Engine in TS, etablierte Parser
  (TypeScript Compiler API, ts-morph), enge Workflow-Integration.
- **Variante C – Hybrid**: nativer Analysekern (z. B. Rust/C++) + sprachspezifische
  Adapter; Datenaustausch über ein stabiles Fact-Schema.

## 3. Bewertung nach Kriterien

Skala: ++ sehr gut · + gut · ○ neutral · − schwach · −− sehr schwach.

| Kriterium | A: C++20 | B: TypeScript | C: Hybrid |
|-----------|:--------:|:-------------:|:---------:|
| Laufzeit-Performance | ++ | ○ | ++ |
| Speicherbedarf | ++ | − | + |
| Parser­verfügbarkeit (TS/JS) | − | ++ | + |
| Parser­verfügbarkeit (PHP) | ○ | + (nikic via Bridge) | + |
| Integration in Dev-Workflows (CI, npm, Editor) | − | ++ | + |
| Wartbarkeit (Team-Kontext) | − | ++ | ○ |
| Testbarkeit | + | ++ | ○ |
| Erweiterbarkeit (neue Sprachen) | ○ | + | ++ |
| Integrationsaufwand bestehender Tools | ○ | ++ | + |
| Entwicklungsaufwand bis MVP | −− | ++ | − |
| Eignung für spätere Sprachen (langfristig) | + | ○ | ++ |

### Begründung der wichtigsten Zeilen

- **Parserverfügbarkeit** ist der ausschlaggebende Punkt. Für TS/JS liefert die
  **TypeScript Compiler API** (plus `ts-morph` als ergonomische Hülle) einen
  vollwertigen, typ-angereicherten AST „umsonst". Für PHP existiert
  `nikic/php-parser` als faktischer Standard; er ist aus einem TS-Kern per
  Subprozess/Bridge nutzbar. Einen eigenen Parser in C++ zu bauen oder zu
  pflegen, widerspricht Nichtziel N3.
- **Performance** spricht klar für A/C, ist aber für den MVP **nicht** der
  Engpass: Analysen laufen pro Datei und sind gut parallelisier- und cachebar.
  „Nicht wegen vermeintlicher Performancevorteile festlegen" (Vorgabe aus dem
  Projektauftrag) trifft hier zu.
- **Entwicklungsaufwand/Wartbarkeit** sprechen angesichts des Team-Kontexts
  (TS/PHP, kein C++ sichtbar) stark für B.
- **Langfristige Sprachvielfalt** ist die größte Stärke von C: ein
  sprachagnostischer Kern mit Adaptern. Dies ist aber eine **spätere**
  Optimierung, kein MVP-Bedarf.

## 4. Empfehlung

> **Vorläufige Empfehlung: Variante B (TypeScript-Kern) für den MVP, mit einer
> Architektur, die den Übergang zu Variante C (Hybrid) bewusst offen hält.**

Begründung an den tatsächlichen Anforderungen (nicht an Performance):

1. **Zielsprache zuerst = TypeScript/JavaScript.** Der schnellste Weg zu einem
   belastbaren deterministischen Kern führt über die reife TS-Toolchain. *stoa*
   kann sich zudem selbst analysieren (Dogfooding).
2. **PHP als erster zweiter Adapter** (hoher Nutzen im gegebenen Kontext) über
   `nikic/php-parser` als Subprozess-Bridge, die Facts in dasselbe Schema
   liefert. Dies validiert früh die Sprachunabhängigkeit des Fact-Schemas.
3. **Externe Tools als Fact-Quellen**: `tsc`, ESLint, (später) PHPStan/Psalm
   werden über Adapter eingelesen statt nachgebaut.
4. **Austrittsklausel Richtung C**: Fact-/Regel-/Finding-Schemata werden
   sprach- und laufzeitneutral als JSON definiert. Wird Performance später zum
   Problem (sehr große Codebasen), kann der Fact-Extraktor pro Sprache nativ
   neu implementiert werden, ohne Regel-Engine, KB und Reporter anzufassen.

### Konsequenzen / Leitplanken für die Umsetzung

- Der **Kern bleibt frei von TS-AST-Typen**: Regeln sehen nur das neutrale
  Fact-Schema. Das verhindert, dass Variante B eine Einbahnstraße wird.
- **Keine** harte Bindung an einen LLM-Anbieter (Adapter, siehe
  [architecture.md](./architecture.md#d-semantic-analysis-optional)).
- Die Entscheidung ist **revidierbar**: Sie betrifft primär den Fact-Extraktor,
  nicht die Analyse-Semantik.

## 5. Zu integrierende bestehende Werkzeuge

| Zweck | Werkzeug | Rolle in *stoa* |
|-------|----------|-----------------|
| TS/JS Parsing & Typen | TypeScript Compiler API, `ts-morph` | primäre AST-Quelle (TS) |
| TS/JS Lint-Diagnosen | ESLint (+ typed rules) | Fact-Quelle, gefiltert (kein Stil) |
| TS/JS Typfehler | `tsc --noEmit` | Fact-Quelle (Robustheit/Fehlerbehandlung) |
| PHP Parsing | `nikic/php-parser` | AST-Quelle (PHP-Adapter) |
| PHP Analyse | PHPStan, Psalm | Fact-Quelle (später) |
| Komplexitätsmaße | eigene AST-Metriken (ggf. an etablierten Definitionen orientiert) | Facts |
| CI-Ausgabe | SARIF | Reporter-Zielformat |

> Lizenz-Hinweis: Integration erfolgt über deren CLIs/APIs; die jeweiligen
> Lizenzen (MIT/BSD etc.) sind vor Bündelung zu prüfen. Keine Übernahme von
> Regel-Inhalten/Texten ohne Lizenzprüfung.

## 6. Offene Technikpunkte

Siehe [open-questions.md](./open-questions.md): u. a. Monorepo-Struktur
(npm-Workspaces), Subprozess- vs. In-Process-Bridge für PHP, Grenzen der
interprozeduralen Analyse in TS ohne vollständige Programmauflösung.
