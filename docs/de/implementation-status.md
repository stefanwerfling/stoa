# Umsetzungsstand

> Stand: 2026-10-26. Diese Seite beschreibt, was **tatsächlich implementiert** ist.
> Die übrigen `docs/`-Dokumente beschreiben die **Entwurfsabsicht** (Konzeptphase)
> und bleiben als Begründung gültig; wo die Umsetzung abweicht, zählt diese Seite.

## Realisierte Architektur

- **TypeScript-Kern** (Variante B), deterministisch, ohne LLM lauffähig.
- **Sprachadapter:** TypeScript/JavaScript (via `ts-morph` / TS-Compiler-API) und
  **PHP** (via `php-parser`/glayzzle, rein in-process — kein Subprozess).
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

## Regelkatalog (20)

Deklarative Regeln (`rules/default/*.json`), Default aktiv:

| Regel | Prinzip | Dimension | Sprachen |
|-------|---------|-----------|----------|
| R-COMPLEXITY-COGNITIVE | marcus.simplicity | Komplexität | TS, PHP |
| R-DEEP-NESTING | marcus.simplicity | Komplexität | TS, PHP |
| R-FN-TOO-MANY-PARAMS | marcus.purpose | Verantwortungsgrenzen | TS, PHP |
| R-WIDE-PUBLIC-SURFACE | marcus.purpose | Verantwortungsgrenzen | TS/JS |
| R-ERR-SWALLOWED | marcus.obstacle | Fehlerbehandlung | TS, PHP |
| R-SIDEEFFECT-NONDETERMINISM | marcus.control | Seiteneffekt-Kontrolle | TS, PHP |
| R-DEP-UNUSED | marcus.cooperation | Abhängigkeiten | TS, PHP |
| R-DEEP-IMPORT | marcus.cooperation | Abhängigkeiten | TS, PHP |
| R-TYPE-UNSOUND | marcus.judgment | Belegbarkeit, Robustheit | TS (opt-in `--typecheck`) |
| R-FLOATING-PROMISE | marcus.obstacle | Fehlerbehandlung, Robustheit | TS (opt-in `--typecheck`) |
| R-ORM-SYNCHRONIZE-ENABLED | marcus.control | Seiteneffekt-Kontrolle, Robustheit | TS/JS |
| R-ORM-SYNC-WITH-MIGRATIONS | marcus.judgment | Belegbarkeit, Robustheit | TS/JS |
| R-ORM-ENTITY-NO-PK | marcus.judgment | Robustheit, Belegbarkeit | TS/JS (`@Entity`-Klassen) |
| R-ORM-EAGER-RELATION | marcus.control | Seiteneffekt-Kontrolle, Robustheit | TS/JS (`@Entity`-Relationen) |
| R-ORM-NULLABLE-NO-DEFAULT | marcus.obstacle | Robustheit, Fehlerbehandlung | TS/JS, PHP (NOT-NULL-Add im `up()`) |
| R-MIGRATION-UNGUARDED-DDL | marcus.obstacle | Robustheit, Fehlerbehandlung | TS/JS, PHP (nur Migrationsdateien) |
| R-MIGRATION-NO-DOWN | marcus.judgment | Robustheit, Belegbarkeit | TS/JS, PHP (nur Migrationsdateien) |
| R-MIGRATION-DATA-LOSS | marcus.judgment | Robustheit, Belegbarkeit | TS/JS, PHP (Drops im `up()`) |

Prozedurale Regeln (`ProjectRule`, cross-file):

| Regel | Prinzip | Dimension | Hinweis |
|-------|---------|-----------|---------|
| R-DEP-CYCLE | marcus.cooperation | Abhängigkeiten | Tarjan-SCC über relative Importe; type-only-Importe übersprungen |
| R-UNUSED-EXPORT | marcus.cooperation | Abhängigkeiten | opt-in `--dead-exports`; nur bei Ganzprojekt-Scans sinnvoll |

Alle acht Qualitätsdimensionen haben mindestens eine Regel.

## Erzeugte Facts

`file.lineCount`, `metric.exportCount`, `metric.cyclomaticComplexity`,
`metric.cognitiveComplexity`, `metric.nestingDepth`, `metric.parameterCount`,
`metric.functionLength`, `doc.hasComplexityRationale`, `ast.usesNondeterminism`,
`ast.emptyCatch`, `ast.catchSwallowsError`, `deps.import`, `deps.importUnused`,
`deps.importDeep`, `deps.export`, `deps.importName`, `orm.synchronizeEnabled`,
`orm.syncWithMigrations`, `orm.entityNoPrimaryKey`, `orm.eagerRelation`,
`migration.unguardedDdl`, `migration.noDown`, `migration.dataLoss`,
`migration.nullableNoDefault`, sowie (opt-in) `external.tsc` und
`external.floatingPromise`.

## Qualitätssicherung

- **67 node:test-Fälle** grün (Regeln pos./neg., Extraktion, Schema-Validierung,
  i18n, Determinismus, SARIF, Eval, Semantik-Groundedness).
- **Golden-Korpus** (`test/corpus/`, TS+PHP) mit Ground-Truth; Eval derzeit
  **Precision 100 % · Recall 100 %**. Precision-Gate je Regel (AC-5).
- Dogfooding: stoa analysiert den eigenen `src/`.

## Abweichungen vom Konzept (bewusst, dokumentiert)

- **PHP-Parser:** `php-parser`/glayzzle (rein JS, in-process) statt eines
  `nikic/php-parser`-Subprozesses (OQ-3) — deterministisch & testbar.
- **Typprüfer/floating promises:** in-process über die TS-Compiler-API statt eines
  ESLint-Subprozesses — gleiche Prüfung, kein fragiler externer Prozess.
- **Mehrsprachigkeit:** `LocalizedText`-Felder in Regeln/Prinzipien + i18n-Tabelle.
- **include/exclude:** jetzt wirksam (war in M1 noch vereinfacht).

## Noch offen

Baseline-/Suppression-Workflow; Diff-/PR-Modus; PSR-4-Auflösung, damit
R-DEP-CYCLE/R-UNUSED-EXPORT auch PHP abdecken; generischer ESLint-Fact-Adapter;
Kontext-Facts (`flag.generatedCode`, `hasTests`) für reichhaltigere Suppression;
LLM-Ausgabe-Evaluierung im Maßstab.
