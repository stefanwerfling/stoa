# Vision – Stoic Code Analysis Engine (Arbeitstitel: *stoa*)

> Status: Konzeptphase. Dieses Dokument beschreibt Ziele, Nichtziele und
> Anwendungsfälle. Es enthält bewusst **keine** Implementierungsvorgaben.
> Offene Entscheidungen sind in [open-questions.md](./open-questions.md) gesammelt.
> Der Projektname ist vorläufig.

## 1. Kurzfassung

*stoa* ist eine eigenständige, deterministische Code-Analyse-Engine. Sie
übersetzt ausgewählte, quellengeprüfte Gedanken aus Marc Aurels
*Selbstbetrachtungen* in nachvollziehbare, technische Prüfkriterien für
Quellcode und Architektur.

Der Kern ist **kein** LLM. Der Kern ist eine klassische statische Analyse
(AST-, Kontrollfluss-, Abhängigkeitsanalyse) mit einer versionierten
Regel-Engine. Philosophie liefert dabei ausschließlich den **Deutungsrahmen**
(„warum ist dieser Befund relevant?"), nicht den Befund selbst. Ein LLM ist
eine optionale, klar abgegrenzte Ergänzung für Aufgaben, die strukturelle
Analyse allein nicht zuverlässig leisten kann.

## 2. Problem

Statische Analysewerkzeuge (ESLint, PHPStan, Psalm, SonarQube, …) liefern
viele einzelne, technisch korrekte Befunde. Entwicklerinnen und Entwickler
erleben diese Befunde jedoch häufig als:

- **unzusammenhängend** – jede Regel steht für sich, es fehlt ein roter Faden;
- **wertungsarm begründet** – „Cyclomatic Complexity 14 > 10" erklärt *dass*,
  aber nicht überzeugend *warum* und *mit welcher Konsequenz*;
- **stilistisch statt substanziell** – subjektive Präferenzen erscheinen als
  objektive Mängel.

*stoa* versucht nicht, bessere Linter-Regeln zu erfinden. *stoa* versucht, einen
**konsistenten, begründeten Bewertungsrahmen** über technische Befunde zu legen
und Befunde dort zu priorisieren, wo sie tatsächliche Wartbarkeit,
Verständlichkeit und Robustheit betreffen.

## 3. Vision

> Eine Analyse-Engine, die technische Beobachtungen transparent mit einem
> begründeten Qualitätsverständnis verknüpft – nachvollziehbar, reproduzierbar
> und ehrlich über ihre Grenzen.

Dazu verbindet *stoa* sieben Bausteine:

1. eine **strukturierte, zitierfähige** philosophische Wissensbasis;
2. eine **explizite Übersetzung** von Prinzipien in Softwarekriterien
   (inklusive dokumentierter Grenzen und Gegenbeispiele);
3. **statische Code- und Strukturanalyse** über Sprachadapter;
4. eine **deterministische, versionierte Regel-Engine**;
5. eine **optionale semantische Bewertung** durch ein LLM (abschaltbar);
6. ein **transparentes Befundmodell** mit getrennter Schwere und Konfidenz;
7. **begründete, aber unverbindliche** Verbesserungsvorschläge.

## 4. Leitprinzipien des Produkts

Diese Prinzipien gelten für *stoa* selbst – unabhängig davon, welchen Code es
analysiert.

| # | Leitprinzip | Bedeutung für das Produkt |
|---|-------------|---------------------------|
| L1 | **Determinismus zuerst** | Der Kern liefert bei gleichem Input und gleicher Version identische Befunde. LLM-Anteile sind getrennt, markiert und abschaltbar. |
| L2 | **Evidenz vor Wertung** | Jeder Befund nennt die konkrete technische Beobachtung (Datei, Stelle, Metrik). Die philosophische Deutung ist nachgelagert und als Deutung gekennzeichnet. |
| L3 | **Schwere ≠ Konfidenz** | Wie schwer ein Problem wäre und wie sicher wir es erkannt haben, sind zwei getrennte Achsen. |
| L4 | **Kontext schlägt Schwellenwert** | Keine Regel bewertet eine Metrik isoliert als „schlecht". Lange Funktionen, viele Parameter etc. sind nur *Signale*. |
| L5 | **Keine Philosophie als Fakt** | *stoa* gibt philosophische Bewertungen nie als objektive Wahrheit aus. Zuordnungen sind begründet, aber als Interpretation markiert. |
| L6 | **Quellen­treue** | Keine erfundenen Textstellen, Kapitel oder Aussagen. Unsichere Zuordnungen werden gekennzeichnet. Siehe [philosophical-foundation.md](./philosophical-foundation.md). |
| L7 | **Vorschlag statt Eingriff** | *stoa* analysiert und empfiehlt. Es ändert Quellcode nicht ohne ausdrückliche Freigabe. |
| L8 | **Erweiterbar, nicht festgenagelt** | Weder an Marc Aurel noch an eine Programmiersprache gebunden. Quelle, Interpretation, Regel und Sprachadapter sind getrennt. |

## 5. Zielgruppen und Anwendungsfälle

### Zielgruppen
- **Einzelentwickler / kleine Teams**, die ihre Codebasis mit einem begründeten
  Qualitätsblick betrachten wollen (der Kontext dieses Projekts: PHP- und
  TypeScript/Node-Ökosystem).
- **Tech Leads / Reviewer**, die Review-Schwerpunkte priorisieren wollen.
- **Lehrkontexte**, in denen der *Warum*-Teil von Codequalität vermittelt wird.

### Anwendungsfälle (UC)

| ID | Anwendungsfall | Beschreibung | MVP? |
|----|----------------|--------------|------|
| UC-1 | **Projekt­scan (CLI)** | `stoa analyze ./src` erzeugt einen reproduzierbaren Bericht mit Befunden, Evidenz und Vorschlägen. | ✅ |
| UC-2 | **Einzeldatei-Analyse** | Schnelle Rückmeldung zu einer Datei, z. B. im Editor-Workflow. | ✅ |
| UC-3 | **Diff-/PR-Analyse** | Nur geänderte Dateien/Zeilen bewerten, für CI und Pull Requests. | ◻ (Ausbaustufe) |
| UC-4 | **Qualitätsprofil** | Mehrdimensionales Profil statt Einzelnote; Trend über Commits. | ◻ |
| UC-5 | **Semantische Vertiefung** | Optionale LLM-Einschätzung zu ausgewählten Befunden (z. B. „ist diese Abstraktion wirklich überflüssig?"). | ◻ (optional) |
| UC-6 | **Baseline / Suppression** | Bestehende Befunde als Baseline akzeptieren, nur Regressionen melden. | ◻ |
| UC-7 | **Eigene Wissensbasis** | Teams ergänzen eigene Prinzipien/Quellen und Regeln. | ◻ |

## 6. Nichtziele

Ausdrücklich **nicht** Ziel dieses Projekts:

- **N1** – Marc-Aurel-Zitate in einen LLM-Prompt zu geben und die Antwort als
  „stoische Analyse" auszugeben. Genau das soll *stoa* ersetzen.
- **N2** – Eine philosophisch „objektiv korrekte" Codebewertung zu behaupten.
  Codequalität ist hier eine **technische Operationalisierung**, keine
  messbare Naturgröße.
- **N3** – Bestehende etablierte Werkzeuge (Compiler, ESLint, PHPStan, Psalm)
  neu zu implementieren. *stoa* **integriert** und **deutet** deren Ergebnisse,
  wo sinnvoll.
- **N4** – Ein weiterer reiner Style-Linter zu sein. Stilpräferenzen ohne
  belegbare Qualitätswirkung sind kein Befund (siehe L4).
- **N5** – Automatisches, unbeaufsichtigtes Umschreiben von Code.
- **N6** – Vollständige semantische Programmverifikation oder Beweis von
  Korrektheit.
- **N7** – Ein einzelner „Score", der komplexe Qualität in eine Zahl presst und
  Scheingenauigkeit erzeugt (ein aggregierter Wert ist *optional* und immer von
  seinem Profil begleitet).

## 7. Abgrenzung zu bestehenden Werkzeugen

| Werkzeug­klasse | Was es tut | Was *stoa* anders/zusätzlich tut |
|-----------------|------------|----------------------------------|
| Linter (ESLint) | Stil + einfache Fehlermuster | Verknüpft Befunde mit Qualitätsdimensionen + begründetem Rahmen; filtert reine Stilregeln bewusst aus. |
| Typprüfer (tsc, PHPStan, Psalm) | Typ-/Nullsicherheit | Nutzt deren Diagnosen als **Evidenzquelle**, deutet sie aber im Kontext von Fehlerbehandlung/Robustheit. |
| SonarQube | Breite Metrik-/Smell-Sammlung, Scores | Transparentere Herleitung, getrennte Schwere/Konfidenz, kein Optimieren-auf-eine-Zahl, explizite Gegenbeispiele je Regel. |
| LLM-Code-Review | Freitext-Einschätzung | Deterministischer Kern + markierte, belegpflichtige LLM-Ergänzung statt reiner Freitext-Meinung. |

## 8. Erfolgskriterien (konzeptuell)

Das Projekt ist als Konzept erfolgreich, wenn:

- jede Beispiel-Regel ein **positives und ein negatives** Beispiel besitzt
  (Befund gerechtfertigt / nicht gerechtfertigt);
- jede philosophische Zuordnung eine **nachvollziehbare Quelle** und eine
  **explizite Konfidenz** trägt;
- der deterministische Kern **ohne LLM** sinnvolle Ergebnisse liefert;
- Fehlalarme (False Positives) an einem Referenzkorpus **messbar** sind
  (siehe [evaluation.md](./evaluation.md)).

Konkrete, prüfbare Abnahmekriterien für den MVP stehen in
[roadmap.md](./roadmap.md#2-abnahmekriterien).

## 9. Verwandte Dokumente

- [philosophical-foundation.md](./philosophical-foundation.md) – Quellen & Methodik
- [architecture.md](./architecture.md) – Komponenten & Datenflüsse
- [knowledge-model.md](./knowledge-model.md) – Datenmodell der Wissensbasis
- [rule-model.md](./rule-model.md) – Regeln & Ausführung
- [finding-model.md](./finding-model.md) – Befunde & Bewertung
- [evaluation.md](./evaluation.md) – Validierung & Qualitätsmessung
- [technology-decision.md](./technology-decision.md) – Architekturvergleich
- [roadmap.md](./roadmap.md) – MVP & Meilensteine
- [open-questions.md](./open-questions.md) – offene Entscheidungen & Risiken
