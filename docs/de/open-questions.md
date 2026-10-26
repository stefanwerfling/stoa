# Offene Fragen, Risiken & Annahmen

> Status: Konzeptphase. Sammelt ungeklärte Entscheidungen (mit vorläufiger
> Empfehlung), Risiken und explizite Annahmen. Nichts hier ist endgültig.

## 1. Offene Entscheidungen (mit vorläufiger Empfehlung)

| ID | Frage | Optionen | Vorläufige Empfehlung |
|----|-------|----------|-----------------------|
| OQ-1 | **Erste Zielsprache** | TS/JS · PHP | **TS/JS** (reifste Toolchain, Dogfooding); PHP als erster zweiter Adapter. Da das Projektumfeld PHP-lastig ist, ist dies explizit zu bestätigen. |
| OQ-2 | **Kernlaufzeit** | TS (Var. B) · Hybrid (Var. C) | **TS-Kern**, Schema-neutral, Austritt zu Hybrid offen (siehe [technology-decision.md](./technology-decision.md)). |
| OQ-3 | **PHP-Bridge** | Subprozess (`nikic/php-parser`) · eigener Parser | **Subprozess** (N3: nicht neu bauen). |
| OQ-4 | **Interprozeduraler Datenfluss** | nur lokal · projektweit | **MVP: lokal** (DFG pro Funktion). Projektweit ist teuer → spätere Stufe; betrifft `R-SIDEEFFECT-IN-PURE`-Präzision. |
| OQ-5 | **Default-Single-Score** | an · aus | **Aus** (nur Profil; Index optional). |
| OQ-6 | **Kohäsionsmetrik** | LCOM-Variante · eigene Heuristik | offen; mit Experten/Empirie am Korpus kalibrieren (Risiko Fehlalarm). |
| OQ-7 | **Prinzip-Benennung** | `marcus.*` · `stoic.*` | **`marcus.*`** für MVP; Umbenennung zu `stoic.*`, sobald Epiktet als Quelle dazukommt (`marcus.control`). |
| OQ-8 | **LLM-Default** | lokal · extern · aus | **Aus** im MVP; Adapter anbieterneutral. |
| OQ-9 | **Lizenz der Engine** | — | Repo ist **MIT**. Translationslizenzen sind davon getrennt zu behandeln (nur gemeinfreie Texte verbatim). |
| OQ-10 | **Dokumentationssprache** | DE · EN | **DE** (Umfeld), Dateinamen EN wie beauftragt. Bei Öffnung des Projekts ggf. EN-Übersetzung. |
| OQ-11 | **Projektname** | „stoa" · anderer | vorläufig „stoa"; endgültigen Namen + Marken-/Namenskonflikte prüfen. |

## 2. Risiken

| ID | Risiko | Auswirkung | Gegenmaßnahme |
|----|--------|-----------|---------------|
| R-1 | **Philosophie als Deko** – Analogien wirken aufgesetzt, kein echter Mehrwert. | Projekt verliert Daseinsberechtigung. | Jede Zuordnung begründet + markiert; Prinzipien ohne tragfähige Hypothese verworfen ([foundation §5](./philosophical-foundation.md#5-was-sich-nicht-sinnvoll-übersetzen-lässt)). |
| R-2 | **Fehlalarme** bei Heuristik-Regeln (Komplexität/Kohäsion/Seiteneffekte). | Nutzer verlieren Vertrauen. | Precision-Gate, „experimental"-Status, Kontext-Suppression, getrennte Konfidenz. |
| R-3 | **Quellenfehler** (falsche Zuordnung/Zitat). | Glaubwürdigkeit. | Belegregister + Verifikationsstatus + Experten-Review; moderne © Übersetzungen (Hays) nicht verbatim. |
| R-4 | **Scheingenauigkeit** eines Scores. | Fehlanreize (Goodhart). | Kein Default-Single-Score; Profil + Unsicherheitsband. |
| R-5 | **Sprach­unabhängigkeit** des Fact-Schemas erst spät real geprüft. | Kostspielige Nacharbeit. | PHP-Adapter früh nach MVP (M6) als Test; Schema bewusst neutral halten. |
| R-6 | **LLM erfindet Tatsachen**. | Falsche Befunde. | Groundedness-Pflicht, markierte Herkunft, abschaltbar, eigene Eval-Rubrik. |
| R-7 | **Dopplung** zu ESLint/PHPStan ohne Mehrwert. | Redundanz. | Tools als Fact-Quelle integrieren statt nachbauen; Vergleich im Eval. |
| R-8 | **Determinismus-Lecks** (Uhr/Zufall/Pfadreihenfolge). | Nicht reproduzierbar. | Reproduzierbarkeitstest in CI; Zeit/Umgebung nur in Metadaten. |
| R-9 | **Kontextmangel** bei „Verantwortung/Notwendigkeit". | Fehlurteile. | Niedrige Konfidenz, Delegation an Semantik, explizite `missingContext`. |

## 3. Annahmen (zu bestätigen)

- **A-1** Zielumfeld ist TS/JS **und** PHP (abgeleitet aus `.idea/`-Konfiguration;
  nicht vom Nutzer bestätigt).
- **A-2** Primäres Interface ist eine CLI (nicht IDE-Plugin/Server) für den MVP.
- **A-3** Nutzer akzeptieren externe Tools als Abhängigkeit (`tsc` vorhanden).
- **A-4** Es gibt perspektivisch Zugang zu einer sachkundigen Person für das
  philosophische Experten-Review.
- **A-5** Analysierte Projekte sind statisch auflösbar genug (begrenzte dynamische
  Importe/Reflection), damit `deps`-Facts aussagekräftig sind.

## 4. Bewusst offen gelassen (out of scope der Konzeptphase)

- Konkrete Schwellenwerte je Regel (werden am Korpus kalibriert, nicht geraten).
- Genaue `severityWeight`/`scale`-Zahlen des Scorings (empirisch zu bestimmen).
- Monorepo-/Paketstruktur der Implementierung (npm-Workspaces vermutet).
- Performance-Budget / Grenzen der Projektgröße.

## 5. Nächste Entscheidungen vor Implementierungsbeginn

1. **OQ-1/OQ-2 bestätigen** (Zielsprache + Kernlaufzeit).
2. **Precision-Schwelle** für AC-5 festlegen.
3. **Golden-Korpus** definieren (welche Beispielprojekte?).
4. **Experten-Review-Prozess** für die KB klären (wer, wann).
