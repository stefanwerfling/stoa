import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixtures = join(here, 'fixtures', 'rules');

const analyzePath = (path: string): Finding[] => {
    return analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};

const bySymbol = (findings: Finding[], symbol: string): Finding[] => {
    return findings.filter((finding) => finding.location.symbol === symbol);
};

test('R-ERR-SWALLOWED fires on empty and swallowing catches, not on rethrow', () => {
    const findings = analyzePath(join(root, 'test', 'fixtures', 'metrics', 'Catch.ts'))
        .filter((finding) => finding.rule.id === 'R-ERR-SWALLOWED');
    assert.equal(findings.length, 2, 'two swallowed catches (empty + return null), not the rethrow');
    assert.ok(findings.every((finding) => finding.severity === 'high'));
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.obstacle');
});

test('R-COMPLEXITY-COGNITIVE fires on a tangled function', () => {
    const findings = analyzePath(join(fixtures, 'Complex.ts'));
    const cognitive = bySymbol(findings, 'tangled').filter((f) => f.rule.id === 'R-COMPLEXITY-COGNITIVE');
    assert.equal(cognitive.length, 1);
    assert.equal(cognitive[0]?.interpretation.principles[0]?.id, 'marcus.simplicity');
    assert.ok(cognitive[0] !== undefined && cognitive[0].confidence > 0 && cognitive[0].confidence <= 1);
});

test('context beats threshold: the stoa:allow-complexity marker suppresses findings (AC-8)', () => {
    const findings = analyzePath(join(fixtures, 'Complex.ts'));
    assert.equal(bySymbol(findings, 'tangledAllowed').length, 0, 'suppressed function yields no findings');
    assert.ok(bySymbol(findings, 'tangled').length > 0, 'the unsuppressed twin still reports');
});

test('R-FN-TOO-MANY-PARAMS escalates severity with parameter count', () => {
    const findings = analyzePath(join(fixtures, 'Params.ts')).filter((f) => f.rule.id === 'R-FN-TOO-MANY-PARAMS');
    assert.equal(bySymbol(findings, 'five')[0]?.severity, 'low');
    assert.equal(bySymbol(findings, 'eight')[0]?.severity, 'medium');
});

test('R-SIDEEFFECT-NONDETERMINISM flags direct clock/RNG use (marcus.control)', () => {
    const findings = analyzePath(join(root, 'test', 'corpus', 'project', 'Clock.ts')).filter(
        (f) => f.rule.id === 'R-SIDEEFFECT-NONDETERMINISM'
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.control');
    assert.ok(findings[0]?.interpretation.dimensions.includes('side-effect-control'));
});

test('R-DEP-UNUSED flags an unused import but not a used one', () => {
    const unused = analyzePath(join(root, 'test', 'corpus', 'project', 'UnusedImport.ts')).filter(
        (f) => f.rule.id === 'R-DEP-UNUSED'
    );
    assert.equal(unused.length, 1);
    assert.equal(unused[0]?.observation.statement, 'Unused import: node:fs.');

    const usedImport = analyzePath(join(root, 'test', 'corpus', 'project', 'CycleA.ts')).filter(
        (f) => f.rule.id === 'R-DEP-UNUSED'
    );
    assert.equal(usedImport.length, 0);
});

test('R-DEEP-IMPORT flags an import that reaches into internals', () => {
    const findings = analyzePath(join(root, 'test', 'corpus', 'project', 'DeepImport.ts')).filter(
        (f) => f.rule.id === 'R-DEEP-IMPORT'
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.cooperation');
    assert.ok(findings[0]?.observation.statement.includes('../internal/secret.js'));
});

test('R-WIDE-PUBLIC-SURFACE flags a module with many exports', () => {
    const findings = analyzePath(join(root, 'test', 'corpus', 'project', 'WideSurface.ts')).filter(
        (f) => f.rule.id === 'R-WIDE-PUBLIC-SURFACE'
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.purpose');
    assert.ok(findings[0]?.interpretation.dimensions.includes('responsibility-boundaries'));
    assert.equal(findings[0]?.observation.statement, 'Module exposes 15 public exports.');
});

test('R-ORM-SYNCHRONIZE-ENABLED flags synchronize:true and ?? true, but not false', () => {
    const findings = analyzePath(join(root, 'test', 'fixtures', 'orm', 'Variants.ts')).filter(
        (f) => f.rule.id === 'R-ORM-SYNCHRONIZE-ENABLED'
    );
    assert.equal(findings.length, 2, 'explicit true + default-true; the false one is not flagged');
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.control');
    assert.ok(findings.some((f) => f.observation.statement.includes('defaults to true')));
});

test('R-ORM-SYNC-WITH-MIGRATIONS fires only when synchronize and migrations coexist', () => {
    const conflict = analyzePath(join(root, 'test', 'corpus', 'project', 'OrmMigrationsConflict.ts')).filter(
        (f) => f.rule.id === 'R-ORM-SYNC-WITH-MIGRATIONS'
    );
    assert.equal(conflict.length, 1);
    assert.equal(conflict[0]?.interpretation.principles[0]?.id, 'marcus.judgment');

    const syncOnly = analyzePath(join(root, 'test', 'corpus', 'project', 'OrmConfig.ts')).filter(
        (f) => f.rule.id === 'R-ORM-SYNC-WITH-MIGRATIONS'
    );
    assert.equal(syncOnly.length, 0, 'synchronize without migrations is not the conflict');
});

test('R-MIGRATION-UNGUARDED-DDL flags unguarded CREATE/DROP TABLE, only in migration files', () => {
    const migration = analyzePath(join(root, 'test', 'corpus', 'project', 'MigrationUnsafe.ts')).filter(
        (f) => f.rule.id === 'R-MIGRATION-UNGUARDED-DDL'
    );
    assert.equal(migration.length, 2, 'unguarded CREATE + DROP; the IF NOT EXISTS one is not flagged');
    assert.equal(migration[0]?.interpretation.principles[0]?.id, 'marcus.obstacle');
    assert.ok(migration.some((f) => f.observation.statement.includes('CREATE TABLE')));
    assert.ok(migration.some((f) => f.observation.statement.includes('DROP TABLE')));

    const plain = analyzePath(join(root, 'test', 'fixtures', 'migration', 'NotAMigration.ts')).filter(
        (f) => f.rule.id === 'R-MIGRATION-UNGUARDED-DDL'
    );
    assert.equal(plain.length, 0, 'a CREATE TABLE string outside a migration file is not the concern');
});

test('R-MIGRATION-UNGUARDED-DDL flags createTable/dropTable without the existence guard', () => {
    const builder = analyzePath(join(root, 'test', 'corpus', 'project', 'MigrationBuilder.ts')).filter(
        (f) => f.rule.id === 'R-MIGRATION-UNGUARDED-DDL'
    );
    assert.equal(builder.length, 2, 'unguarded createTable + dropTable; createTable(..., true) is guarded');
    assert.ok(builder.some((f) => f.observation.statement.includes('createTable()')));
    assert.ok(builder.some((f) => f.observation.statement.includes('dropTable()')));
});

test('R-MIGRATION-UNGUARDED-DDL flags column changes, but a hasColumn check guards them', () => {
    const columns = analyzePath(join(root, 'test', 'corpus', 'project', 'MigrationColumns.ts')).filter(
        (f) => f.rule.id === 'R-MIGRATION-UNGUARDED-DDL'
    );
    assert.equal(columns.length, 3, 'raw ADD COLUMN + addColumn() + dropColumn()');
    assert.ok(columns.some((f) => f.observation.statement.includes('ADD COLUMN')));
    assert.ok(columns.some((f) => f.observation.statement.includes('addColumn()')));
    assert.ok(columns.some((f) => f.observation.statement.includes('dropColumn()')));

    const guarded = analyzePath(join(root, 'test', 'fixtures', 'migration', 'GuardedColumns.ts')).filter(
        (f) => f.rule.id === 'R-MIGRATION-UNGUARDED-DDL'
    );
    assert.equal(guarded.length, 0, 'a surrounding hasColumn() check suppresses the finding');
});

test('R-MIGRATION-NO-DOWN flags a missing or empty down(), but not a throwing one', () => {
    const notReversible = analyzePath(join(root, 'test', 'corpus', 'project', 'MigrationNoDown.ts')).filter(
        (f) => f.rule.id === 'R-MIGRATION-NO-DOWN'
    );
    assert.equal(notReversible.length, 2, 'missing down() + empty down()');
    assert.equal(notReversible[0]?.interpretation.principles[0]?.id, 'marcus.judgment');
    assert.ok(notReversible.some((f) => f.observation.statement.includes('no down()')));
    assert.ok(notReversible.some((f) => f.observation.statement.includes('empty')));

    const throwing = analyzePath(join(root, 'test', 'fixtures', 'migration', 'ThrowDown.ts')).filter(
        (f) => f.rule.id === 'R-MIGRATION-NO-DOWN'
    );
    assert.equal(throwing.length, 0, 'a deliberately throwing down() is a conscious choice');
});

test('R-ORM-ENTITY-NO-PK flags an entity without a primary key, but not when one is declared or inherited', () => {
    const noPk = analyzePath(join(root, 'test', 'corpus', 'project', 'EntityNoPk.ts')).filter(
        (f) => f.rule.id === 'R-ORM-ENTITY-NO-PK'
    );
    assert.equal(noPk.length, 1);
    assert.equal(noPk[0]?.location.symbol, 'Session');
    assert.equal(noPk[0]?.interpretation.principles[0]?.id, 'marcus.judgment');
    assert.equal(noPk[0]?.severity, 'high');

    const withPk = analyzePath(join(root, 'test', 'fixtures', 'orm', 'Entities.ts')).filter(
        (f) => f.rule.id === 'R-ORM-ENTITY-NO-PK'
    );
    assert.equal(withPk.length, 0, '@PrimaryGeneratedColumn, @Column({primary:true}) and an inherited key all count');
});

test('R-ORM-EAGER-RELATION flags eager:true in any argument position, not eager:false or plain relations', () => {
    const eager = analyzePath(join(root, 'test', 'corpus', 'project', 'EagerRelation.ts')).filter(
        (f) => f.rule.id === 'R-ORM-EAGER-RELATION'
    );
    assert.equal(eager.length, 2, 'options as 2nd arg (tags) and as 3rd arg (messages)');
    assert.deepEqual(
        eager.map((f) => f.location.symbol).sort(),
        ['messages', 'tags']
    );
    assert.equal(eager[0]?.interpretation.principles[0]?.id, 'marcus.control');

    const lazy = analyzePath(join(root, 'test', 'fixtures', 'orm', 'Relations.ts')).filter(
        (f) => f.rule.id === 'R-ORM-EAGER-RELATION'
    );
    assert.equal(lazy.length, 0, 'eager:false and a relation without options are not flagged');
});

test('R-MIGRATION-DATA-LOSS flags drops in up() (even guarded), not drops in down()', () => {
    const loss = analyzePath(join(root, 'test', 'corpus', 'project', 'MigrationDataLoss.ts')).filter(
        (f) => f.rule.id === 'R-MIGRATION-DATA-LOSS'
    );
    assert.equal(loss.length, 2, 'guarded DROP TABLE + guarded dropColumn in up()');
    assert.equal(loss[0]?.interpretation.principles[0]?.id, 'marcus.judgment');
    assert.ok(loss.every((f) => f.severity === 'high'));
    assert.ok(loss.some((f) => f.observation.statement.includes('DROP TABLE')));
    assert.ok(loss.some((f) => f.observation.statement.includes('dropColumn()')));

    const downDrop = analyzePath(join(root, 'test', 'corpus', 'project', 'MigrationUnsafe.ts')).filter(
        (f) => f.rule.id === 'R-MIGRATION-DATA-LOSS'
    );
    assert.equal(downDrop.length, 0, 'a DROP TABLE in down() reverses a create and is expected');
});

test('R-ORM-NULLABLE-NO-DEFAULT flags NOT NULL columns with no default, raw and builder', () => {
    const risky = analyzePath(join(root, 'test', 'corpus', 'project', 'MigrationNullable.ts')).filter(
        (f) => f.rule.id === 'R-ORM-NULLABLE-NO-DEFAULT'
    );
    assert.equal(risky.length, 2, 'raw ADD COLUMN NOT NULL + addColumn isNullable:false');
    assert.equal(risky[0]?.interpretation.principles[0]?.id, 'marcus.obstacle');
    assert.ok(risky.some((f) => f.observation.statement.includes('ADD COLUMN')));
    assert.ok(risky.some((f) => f.observation.statement.includes('addColumn()')));

    const fine = analyzePath(join(root, 'test', 'fixtures', 'migration', 'NullableOk.ts')).filter(
        (f) => f.rule.id === 'R-ORM-NULLABLE-NO-DEFAULT'
    );
    assert.equal(fine.length, 0, 'NOT NULL DEFAULT, a nullable column and isNullable:true are all fine');
});

test('the migration rules fire for Doctrine (PHP) via addSql, scoped to up() and down()', () => {
    const up = analyzePath(join(root, 'test', 'corpus', 'project', 'MigrationDoctrineUp.php'));
    const loss = up.filter((f) => f.rule.id === 'R-MIGRATION-DATA-LOSS');
    const nullable = up.filter((f) => f.rule.id === 'R-ORM-NULLABLE-NO-DEFAULT');
    assert.equal(loss.length, 1, 'guarded DROP TABLE in up() still loses data');
    assert.equal(nullable.length, 1, 'ADD COLUMN NOT NULL with no default');
    assert.equal(up.filter((f) => f.rule.id === 'R-MIGRATION-UNGUARDED-DDL').length, 0, 'the IF [NOT] EXISTS guards silence unguarded-DDL');

    const bare = analyzePath(join(root, 'test', 'corpus', 'project', 'MigrationDoctrineBare.php'));
    assert.equal(bare.filter((f) => f.rule.id === 'R-MIGRATION-UNGUARDED-DDL').length, 1, 'unguarded CREATE TABLE');
    const noDown = bare.filter((f) => f.rule.id === 'R-MIGRATION-NO-DOWN');
    assert.equal(noDown.length, 1, 'no down() method');
    assert.equal(noDown[0]?.location.symbol, 'Version20260102');
});

test('findings carry observation evidence and are deterministic', () => {
    const a = analyzePath(join(fixtures, 'Complex.ts'));
    const b = analyzePath(join(fixtures, 'Complex.ts'));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.ok(a[0] !== undefined && a[0].observation.evidence.length >= 1);
    assert.ok(a[0] !== undefined && a[0].source === 'deterministic');
});
