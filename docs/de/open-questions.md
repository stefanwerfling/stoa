# Offene Fragen, Risiken & Annahmen

> Status: Konzeptphase. Sammelt ungeklärte Entscheidungen (mit vorläufiger
> Empfehlung), Risiken und explizite Annahmen.
>
> **Mit ✅ markierte Entscheidungen sind inzwischen umgesetzt** — der konkrete
> Ist-Stand steht in [implementation-status.md](./implementation-status.md).

## 1. Offene Entscheidungen (mit vorläufiger Empfehlung)

| ID | Frage | Optionen | Vorläufige Empfehlung |
|----|-------|----------|-----------------------|
| OQ-1 | **Erste Zielsprache** | TS/JS · PHP | **✅ Umgesetzt:** TS/JS zuerst; PHP als zweiter Adapter gebaut (M6). |
| OQ-2 | **Kernlaufzeit** | TS (Var. B) · Hybrid (Var. C) | **✅ Umgesetzt:** TS-Kern, Schema-neutral (Austritt zu Hybrid weiterhin offen; siehe [technology-decision.md](./technology-decision.md)). |
| OQ-3 | **PHP-Parser** | Subprozess (`nikic/php-parser`) · reiner JS-Parser (`php-parser`/glayzzle) · eigener Parser | **Entschieden (M6): `php-parser`/glayzzle** — in-process, kein PHP/Composer, deterministisch testbar. Fact-Schema identisch, daher revidierbar. |
| OQ-4 | **Interprozeduraler Datenfluss** | nur lokal · projektweit | **✅ Umgesetzt (lokal):** Metriken/Facts je Funktion lokal. Projektweiter Datenfluss weiterhin spätere Stufe. |
| OQ-5 | **Default-Single-Score** | an · aus | **✅ Entschieden:** kein Default-Single-Score; Befunde tragen Dimensionen. Ein aggregiertes Dimensionen-Profil ist noch nicht gebaut. |
| OQ-6 | **Kohäsionsmetrik** | LCOM-Variante · eigene Heuristik | offen; mit Experten/Empirie am Korpus kalibrieren (Risiko Fehlalarm). |
| OQ-7 | **Prinzip-Benennung** | `marcus.*` · `stoic.*` | **✅ Umgesetzt:** `marcus.*`. Umbenennung zu `stoic.*` erst, wenn Epiktet als Quelle dazukommt (offen). |
| OQ-8 | **LLM-Default** | lokal · extern · aus | **Aus** (implementiert): No-Op-Default; optionaler Anthropic-Adapter (Opus 4.8), anbieterneutral, groundedness-geprüft, außerhalb des deterministischen Kerns. |
| OQ-9 | **Lizenz der Engine** | — | **✅ Entschieden:** MIT. Translationslizenzen getrennt (nur gemeinfreie Texte verbatim). |
| OQ-10 | **Dokumentationssprache** | DE · EN | **✅ Umgesetzt:** Docs in `docs/de` **und** `docs/en` (1:1); zusätzlich lokalisierte Ausgabe (`--lang en|de`). |
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

> ✅ Erledigt im Zuge der Umsetzung: OQ-1/OQ-2 bestätigt (TS/JS + TS-Kern);
> Precision-Gate für AC-5 in den Tests verankert; Golden-Korpus definiert
> (`test/corpus/`). **Weiterhin offen:** Experten-Review-Prozess für die
> philosophischen Interpretationen (wer, wann). Aktueller Ist-Stand:
> [implementation-status.md](./implementation-status.md).
