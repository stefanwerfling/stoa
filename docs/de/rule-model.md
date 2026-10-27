# Regelmodell – Definition & Ausführung der Regel-Engine

> Status: Konzeptphase. Definiert, wie Regeln aufgebaut sind, wie sie
> deterministisch ausgeführt werden und wie sie an Prinzipien gekoppelt sind.
> Datenbasis: Facts aus [architecture.md](./architecture.md#a-source-analysis).

## 1. Grundsätze

- **Regeln prüfen technisch, nicht philosophisch.** Eine Regel wertet Facts aus.
  Die philosophische Deutung kommt über die referenzierten Prinzipien hinzu
  (Trennung aus [knowledge-model.md](./knowledge-model.md)).
- **Determinismus.** Gleiche Facts + gleiche Regelversion + gleiche Config ⇒
  identische Findings. Keine Uhr, kein Zufall, keine Netzabhängigkeit.
- **Facts statt AST.** Regeln sehen nur das neutrale Fact-Schema, nie den
  rohen sprach­spezifischen AST → Sprachunabhängigkeit, leichte Testbarkeit.
  Adapter für TS/JS (ts-morph), PHP (glayzzle) und Dart/Flutter (tree-sitter/WASM)
  liefern dieselben Facts; die Metrik-/Fehlerbehandlungsregeln gelten dadurch
  sprachübergreifend unverändert.
- **Kontext vor Schwelle.** Eine Regel darf eine Metrik nie allein als Mangel
  werten; sie muss Kontext-/Ausnahmesignale berücksichtigen (Leitprinzip L4).
- **Kein Stil als Mangel.** Regeln, die nur subjektive Stilpräferenz abbilden,
  sind unzulässig (Nichtziel N4).

## 2. Fact-Schema (Eingang der Regeln)

Facts sind normalisierte, sprach­neutrale Beobachtungen. Minimalform:

```jsonc
{
  "id": "fact:...",
  "kind": "metric.cognitiveComplexity", // stabile Fact-Art
  "subject": {                           // worauf bezieht sich der Fact
    "file": "src/user.ts",
    "symbol": "formatAddress",
    "kindOf": "function",
    "range": { "startLine": 10, "startCol": 1, "endLine": 48, "endCol": 2 }
  },
  "value": 25,                           // je nach kind: number | bool | string | struct
  "evidence": [                          // woraus abgeleitet
    { "source": "ast", "detail": "nesting depth 5" }
  ],
  "certainty": "syntactic",              // syntactic | semantic-heuristic | external-tool
  "producedBy": { "adapter": "typescript", "version": "0.1.0" }
}
```

`certainty` ist entscheidend: sie begrenzt die maximale Finding-Konfidenz
(ein rein heuristischer Fact kann keine Hochkonfidenz-Regel auslösen).

## 3. Regeldefinition

Eine Regel muss laut Auftrag angeben: *welches Merkmal*, *welche Bedingung*,
*welche Prinzipien*, *welche Evidenz*, *wann kein Befund*, *welche Schwere/
Sicherheit*. Modell:

```jsonc
{
  "id": "R-COMPLEXITY-COGNITIVE",
  "version": "1.0.0",
  "title": "Übermäßige kognitive Komplexität",
  "feature": "metric.cognitiveComplexity",   // untersuchtes Merkmal (Fact kind)
  "appliesTo": ["function", "method"],
  "principles": ["marcus.simplicity"],         // Prinzip-Referenzen (KB)
  "dimensions": ["complexity", "understandability"],

  "trigger": {                                 // wann ein Befund ausgelöst wird
    "all": [
      { "fact": "metric.cognitiveComplexity", "op": ">=", "value": 15 }
    ]
  },

  "requiredEvidence": [                         // ohne diese Facts kein Befund
    "metric.cognitiveComplexity", "metric.nestingDepth"
  ],

  "suppressWhen": {                             // wann KEIN Befund gerechtfertigt ist
    "any": [
      { "fact": "flag.generatedCode", "op": "==", "value": true },
      { "fact": "flag.hasTests", "op": "==", "value": true,
        "and": [{ "fact": "metric.cognitiveComplexity", "op": "<", "value": 30 }] },
      { "fact": "shape.isFlatSwitch", "op": "==", "value": true }
    ]
  },

  "severity": {                                 // abgeleitet, nicht fix
    "base": "medium",
    "escalateWhen": [
      { "fact": "metric.cognitiveComplexity", "op": ">=", "value": 30, "to": "high" },
      { "fact": "metric.churn", "op": ">=", "value": 10, "to": "high" }
    ]
  },

  "confidence": {
    "base": 0.7,
    "capBy": "certainty",                       // syntactic→1.0, heuristic→0.6, extern→0.9
    "reduceWhen": [
      { "fact": "doc.hasComplexityRationale", "op": "==", "value": true, "by": 0.3 }
    ]
  },

  "message": "Kognitive Komplexität {value} in {symbol} erschwert Verständnis.",
  "remediationRef": "fix:reduce-cognitive-complexity",
  "tests": "tests/rules/R-COMPLEXITY-COGNITIVE/"   // Pflicht: Testkatalog
}
```

### Feldbedeutung (Kurz)
| Feld | Zweck |
|------|-------|
| `feature` / `requiredEvidence` | welches Merkmal; ohne die genannten Facts **kein** Lauf (vermeidet Raten) |
| `trigger` | Bedingungen, die einen Kandidaten erzeugen |
| `suppressWhen` | explizite Nicht-Befund-Bedingungen (Kontext!) |
| `severity` / `confidence` | **getrennt** abgeleitet; Konfidenz durch `certainty` gedeckelt |
| `principles` / `dimensions` | Kopplung an KB & Bewertungsmodell |
| `tests` | verpflichtender Testkatalog je Regel |

## 4. Ausführungsmodell

```mermaid
flowchart TB
    FS[(Fact Store)] --> SEL[1. Regel-Selektion\nnach feature/requiredEvidence]
    SEL --> TRG[2. trigger prüfen]
    TRG -->|kein Treffer| DROP[verwerfen]
    TRG -->|Treffer| SUP[3. suppressWhen prüfen]
    SUP -->|unterdrückt| DROP
    SUP -->|bleibt| SEV[4. severity ableiten]
    SEV --> CONF[5. confidence ableiten\n+ cap durch certainty]
    CONF --> EMIT[6. Finding erzeugen\n+ Prinzip-Deutung anhängen]
    EMIT --> DEDUP[7. De-Duplizierung\npro Fundstelle/Problem]
```

**Eigenschaften:**
- **Reihenfolge-unabhängig**: Regeln lesen nur den Fact Store; keine
  Reihenfolgenabhängigkeit zwischen Regeln (reine Funktion `facts → findings`).
- **Stabile Sortierung** der Findings (Datei, Zeile, Regel-ID) für byte-stabile
  Ausgabe.
- **Keine Regel darf Facts erzeugen** – nur lesen (Schichtregel).

## 5. Regelsatz `default@1` (umgesetzt)

> Der tatsächlich implementierte Regelsatz (20 Regeln). Gesamtüberblick, Facts
> und Opt-in-Flags: [implementation-status.md](./implementation-status.md).

Deklarative Regeln (`rules/default/*.json`, Default aktiv):

| Regel-ID | Feature (Fact) | Prinzip | Dimension | Charakter |
|----------|----------------|---------|-----------|-----------|
| `R-COMPLEXITY-COGNITIVE` | `metric.cognitiveComplexity` (+ `nestingDepth`) | `marcus.simplicity` | Komplexität | syntaktisch |
| `R-DEEP-NESTING` | `metric.nestingDepth` | `marcus.simplicity` | Komplexität | syntaktisch |
| `R-FN-TOO-MANY-PARAMS` | `metric.parameterCount` | `marcus.purpose` | Verantwortungsgrenzen | syntaktisch |
| `R-WIDE-PUBLIC-SURFACE` | `metric.exportCount` | `marcus.purpose` | Verantwortungsgrenzen | syntaktisch (nur TS/JS) |
| `R-ERR-SWALLOWED` | `ast.catchSwallowsError` | `marcus.obstacle` | Fehlerbehandlung | syntaktisch |
| `R-SIDEEFFECT-NONDETERMINISM` | `ast.usesNondeterminism` | `marcus.control` | Seiteneffekt-Kontrolle | heuristisch |
| `R-DEP-UNUSED` | `deps.importUnused` | `marcus.cooperation` | Abhängigkeiten | syntaktisch |
| `R-DEEP-IMPORT` | `deps.importDeep` | `marcus.cooperation` | Abhängigkeiten | syntaktisch |
| `R-TYPE-UNSOUND` | `external.tsc` | `marcus.judgment` | Belegbarkeit, Robustheit | external-tool, opt-in `--typecheck` |
| `R-FLOATING-PROMISE` | `external.floatingPromise` | `marcus.obstacle` | Fehlerbehandlung, Robustheit | external-tool, opt-in `--typecheck` |

Persistenz / ORM (TypeORM, nur TS/JS, Default aktiv):

| Regel-ID | Feature (Fact) | Prinzip | Dimension | Charakter |
|----------|----------------|---------|-----------|-----------|
| `R-ORM-SYNCHRONIZE-ENABLED` | `orm.synchronizeEnabled` | `marcus.control` | Seiteneffekt-Kontrolle, Robustheit | heuristisch |
| `R-ORM-SYNC-WITH-MIGRATIONS` | `orm.syncWithMigrations` | `marcus.judgment` | Belegbarkeit, Robustheit | heuristisch |
| `R-ORM-ENTITY-NO-PK` | `orm.entityNoPrimaryKey` | `marcus.judgment` | Robustheit, Belegbarkeit | syntaktisch (`@Entity` / `#[ORM\Entity]`) |
| `R-ORM-EAGER-RELATION` | `orm.eagerRelation` | `marcus.control` | Seiteneffekt-Kontrolle, Robustheit | syntaktisch (TypeORM + Doctrine) |
| `R-ORM-NULLABLE-NO-DEFAULT` | `migration.nullableNoDefault` | `marcus.obstacle` | Robustheit, Fehlerbehandlung | heuristisch (NOT-NULL-Add im `up()`) |
| `R-MIGRATION-UNGUARDED-DDL` | `migration.unguardedDdl` | `marcus.obstacle` | Robustheit, Fehlerbehandlung | heuristisch (nur Migrationsdateien) |
| `R-MIGRATION-NO-DOWN` | `migration.noDown` | `marcus.judgment` | Robustheit, Belegbarkeit | syntaktisch (nur Migrationsdateien) |
| `R-MIGRATION-DATA-LOSS` | `migration.dataLoss` | `marcus.judgment` | Robustheit, Belegbarkeit | heuristisch (Drops im `up()`) |

> `R-MIGRATION-UNGUARDED-DDL` greift nur in Migrationsdateien (Klasse
> `implements MigrationInterface`) und erfasst zwei Wege: Roh-SQL
> (`CREATE/DROP TABLE`, `ADD/DROP COLUMN` ohne `IF [NOT] EXISTS`) und die
> Query-Builder-API (`createTable`/`dropTable` ohne `ifNotExist`/`ifExist`,
> `addColumn`/`dropColumn` ohne umgebenden `hasColumn()`-Check). Bewusst
> konservativ (confidence 0.7): `IF [NOT] EXISTS` ist ein Sicherheitsnetz, kein
> Ersatz für einen sauberen Baseline-Stand, und der echte DB-Zustand ist erst
> zur Laufzeit bekannt (→ CI-Migration gegen frische DB).

> `R-MIGRATION-NO-DOWN` meldet eine Migrationsklasse ohne `down()` oder mit
> leerem `down()` (nicht rückrollbar). Ein bewusst werfendes `down()`
> (ausdrücklich einwegige Migration) gilt als dokumentierte Entscheidung und
> wird nicht gemeldet.

> `R-MIGRATION-DATA-LOSS` meldet zerstörende Schritte im `up()` (`DROP TABLE`/
> `DROP COLUMN` bzw. `dropTable`/`dropColumn`) — unabhängig vom `IF EXISTS`-Guard,
> denn der Guard verhindert den Absturz, nicht den Datenverlust. Gescoped auf
> `up()`, damit erwartete Drops im `down()` (Rücknahme eines Create) nicht
> getroffen werden; ergänzt damit `R-MIGRATION-UNGUARDED-DDL` (Existenz-Guard) um
> die Datenverlust-Perspektive.

> `R-ORM-NULLABLE-NO-DEFAULT` meldet im `up()` eine `NOT NULL`-Spalte ohne
> `DEFAULT` (Roh-SQL `ADD COLUMN … NOT NULL`, oder `addColumn` mit explizitem
> `isNullable: false` ohne `default`) — bricht gegen eine gefüllte Tabelle.
> Auto-increment/generated und ein fehlendes explizites `isNullable` bleiben
> außen vor (konservativ).

> **Doctrine (PHP):** Die vier Migrationsregeln (`R-MIGRATION-UNGUARDED-DDL`,
> `R-MIGRATION-DATA-LOSS`, `R-MIGRATION-NO-DOWN`, `R-ORM-NULLABLE-NO-DEFAULT`)
> greifen auch für Doctrine-Migrationen (`extends AbstractMigration`). Das Roh-SQL
> wird aus `$this->addSql('…')` gelesen; die SQL-Prüfungen sind sprachneutral
> (gemeinsames Modul `MigrationSql`). Auch die **DBAL-Schema-API** wird erfasst
> (`$schema->dropTable()`/`$table->dropColumn()` im `up()` → Data-Loss;
> `$table->addColumn(…, ['notnull' => true])` ohne `default` → Nullable); dort
> gibt es kein `IF [NOT] EXISTS`, daher greift die Unguarded-Regel nur bei Roh-SQL.
> Ebenso greifen `R-ORM-ENTITY-NO-PK`
> (`@Entity` ohne `@Id`) und `R-ORM-EAGER-RELATION` (Relation mit `fetch EAGER`)
> — sowohl über **PHP-8-Attribute** (`#[ORM\Entity]`, `#[ORM\ManyToOne(fetch:
> 'EAGER')]`) als auch über **Annotations-Docblocks** (`@ORM\Entity`, der ältere
> Stil; `fetch="EAGER"`). Der TypeORM-Query-Builder-Pfad bleibt naturgemäß
> TS-seitig.

Prozedurale Regeln (`ProjectRule`, cross-file):

| Regel-ID | Grundlage | Prinzip | Dimension | Charakter |
|----------|-----------|---------|-----------|-----------|
| `R-DEP-CYCLE` | Modulgraph aus `deps.import` (Tarjan-SCC) | `marcus.cooperation` | Abhängigkeiten | syntaktisch |
| `R-UNUSED-EXPORT` | `deps.export` × `deps.importName` | `marcus.cooperation` | Abhängigkeiten | heuristisch, opt-in `--dead-exports` |

> **Noch nicht umgesetzt** (als Ideen dokumentiert): `R-RESP-MIXED-CONCERNS`
> (Schicht-/Namespace-Mischung, `marcus.purpose`) und `R-ARCH-LAYER-VIOLATION`
> (Import gegen deklarierte Schichtregel, `marcus.judgment`).

> Reine Stilregeln (Einrückung, Anführungszeichen, Namenslänge) sind
> **ausgeschlossen**. Solche Prüfungen bleiben bei ESLint/CS-Fixer.

## 6. Versionierung & Determinismus-Garantien

- **Regel-Version (semver)** je Regel; **Regelsatz-Version** (`default@1`) bündelt
  Regeln + Schwellen. Berichte stempeln beide (Reproduzierbarkeit).
- Schwellen (`value`-Grenzen) sind **Teil der Regelversion** – eine
  Schwellenänderung ist eine Versionsänderung, nicht eine stille Config-Drift.
- **Config-Overrides** sind erlaubt, werden aber im Bericht ausgewiesen (damit
  „warum weicht mein Ergebnis ab?" beantwortbar bleibt).

## 7. Testbarkeit (Pflicht je Regel)

Jede Regel besitzt einen Testkatalog mit mindestens:
- **≥ 1 positiver Fixture** (löst Befund korrekt aus),
- **≥ 1 negativer Fixture** (löst korrekt *keinen* Befund aus — prüft
  `suppressWhen`/Gegenbeispiele),
- **Snapshot** des erzeugten Findings (Felder, Schwere, Konfidenz).

Siehe [evaluation.md](./evaluation.md#3-tests-und-referenzkorpus).

## 8. Grenzen des Regelmodells

- Regeln sind nur so gut wie die Facts. Fehlende interprozedurale Datenflüsse
  begrenzen z. B. `R-SIDEEFFECT-IN-PURE`.
- Kontextregeln (`suppressWhen`) brauchen zuverlässige Kontext-Facts
  (Tests vorhanden? generiert? dokumentiert?) — deren Qualität ist selbst zu testen.
- Semantische Urteile („Abstraktion wirklich überflüssig?") gehören **nicht** in
  deterministische Regeln, sondern in die optionale LLM-Schicht (als separat
  markierte, belegpflichtige Ergänzung).
