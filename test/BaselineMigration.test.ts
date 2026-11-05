import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {duplicateMigrationText, migrateBaseline, migrationSummary} from '../src/BaselineMigration.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {findingKey, IDENTITY_SCHEME, keyString, type FindingKey, type IdentityScheme} from '../src/FindingIdentity.js';
import {analyze} from '../src/Pipeline.js';
import {toMarkdown} from '../src/reporting/Reporter.js';
import type {AnalysisReport, Finding} from '../src/Types.js';

// Phase 3 of the quality-hardening spec: a baseline migration classifies
// every entry — matched, notReproducible, ambiguous, duplicate — with the
// reason, never assigns an entry it cannot pair unambiguously, and says what
// it did (stderr, JSON `baseline.migration`, Markdown).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const work = mkdtempSync(join(tmpdir(), 'stoa-migration-'));
after(() => rmSync(work, {recursive: true, force: true}));

const ROOT = '/root';

/** A finding at `line` of `file` (its position, `Finding.id`) named `symbol`. */
const finding = (file: string, symbol: string, line: number, rule = 'R-ERR-SWALLOWED'): Finding => ({
    id: `finding:${rule}:${ROOT}/${file}:${line}:0`,
    rule: {id: rule, version: '1.0.0'},
    ruleSet: 'default@1',
    location: {file: `${ROOT}/${file}`, range: {startLine: line, startCol: 0, endLine: line, endCol: 0}, symbol},
    observation: {statement: 'x', evidence: []},
    interpretation: {principles: [], dimensions: []},
    severity: 'low',
    confidence: 0.5,
    certaintyBasis: 'syntactic',
    remediation: {suggestion: 'x'},
    source: 'deterministic'
});

const report = (findings: Finding[], scheme: IdentityScheme = IDENTITY_SCHEME): AnalysisReport => ({
    versions: {engine: 'e', ruleSet: 'r', knowledgeBase: 'k', adapters: {}, identity: scheme},
    coverage: {status: 'complete', filesSelected: 1, filesAnalyzed: 1, filesSkipped: 0, filesCancelled: 0, excludedByReason: {}, excludedSample: [], factCount: 0},
    findings
});

const key = (file: string, symbol: string, rule = 'R-ERR-SWALLOWED'): FindingKey => ({file, rule, symbol});

const baselineOf = (findings: FindingKey[]): {version: 1; identity: 2; findings: FindingKey[]} => ({version: 1, identity: 2, findings});

/** Every entry as `<old key> <outcome> <reason> -> <current key>`. */
const outcomes = (migration: ReturnType<typeof migrateBaseline>): string[] =>
    migration.entries.map((item) => `${keyString(item.entry)} ${item.outcome}${item.reason !== undefined ? ` ${item.reason}` : ''}${item.current !== undefined ? ` -> ${item.current.symbol}` : ''}`);

test('each entry gets exactly one outcome with its reason: matched, notReproducible (no legacy finding / no current finding)', () => {
    const legacy = report([finding('a.ts', 'catch#0', 1), finding('a.ts', 'catch#1', 5), finding('b.ts', 'catch#0', 2)], 2);
    // b.ts's finding is not produced at that position any more under the
    // current scheme: the two runs disagree, which is never papered over.
    const current = report([finding('a.ts', 'load>catch#0', 1), finding('a.ts', 'save>catch#0', 5), finding('b.ts', 'f>catch#0', 3)]);
    const old = baselineOf([key('a.ts', 'catch#1'), key('a.ts', 'catch#0'), key('gone.ts', 'catch#0'), key('b.ts', 'catch#0')]);
    const migration = migrateBaseline(old, legacy, current, ROOT);
    assert.deepEqual(outcomes(migration), [
        'a.ts::R-ERR-SWALLOWED::catch#0 matched -> load>catch#0',
        'a.ts::R-ERR-SWALLOWED::catch#1 matched -> save>catch#0',
        'b.ts::R-ERR-SWALLOWED::catch#0 notReproducible noCurrentFinding',
        'gone.ts::R-ERR-SWALLOWED::catch#0 notReproducible noLegacyFinding'
    ]);
    assert.equal(migration.from, 2);
    assert.equal(migration.to, IDENTITY_SCHEME);
    assert.deepEqual(migration.baseline?.findings.map((entry) => entry.symbol), ['load>catch#0', 'save>catch#0']);
});

test('ambiguous: an identity the old scheme gives to two findings is never assigned to either', () => {
    const legacy = report([finding('a.ts', 'catch#0', 1), finding('a.ts', 'catch#0', 9)], 2);
    const current = report([finding('a.ts', 'load>catch#0', 1), finding('a.ts', 'save>catch#0', 9)]);
    const migration = migrateBaseline(baselineOf([key('a.ts', 'catch#0')]), legacy, current, ROOT);
    assert.deepEqual(outcomes(migration), ['a.ts::R-ERR-SWALLOWED::catch#0 ambiguous legacyIdentityShared']);
    assert.deepEqual(migration.baseline?.findings, []);
});

test('ambiguous: two findings at one position (one Finding.id) cannot be told apart across schemes, in either run', () => {
    // Two findings of one rule at the same place under different symbols —
    // pairing by position alone could swap them.
    const legacy = report([finding('a.ts', 'x#0', 4), finding('a.ts', 'y#0', 4)], 2);
    const current = report([finding('a.ts', 'f>x#0', 4), finding('a.ts', 'f>y#0', 4)]);
    const migration = migrateBaseline(baselineOf([key('a.ts', 'x#0'), key('a.ts', 'y#0')]), legacy, current, ROOT);
    assert.deepEqual(outcomes(migration), ['a.ts::R-ERR-SWALLOWED::x#0 ambiguous positionShared', 'a.ts::R-ERR-SWALLOWED::y#0 ambiguous positionShared']);
    // Shared only in the legacy run: still not assigned.
    const single = migrateBaseline(baselineOf([key('a.ts', 'x#0')]), legacy, report([finding('a.ts', 'f>x#0', 4)]), ROOT);
    assert.deepEqual(outcomes(single), ['a.ts::R-ERR-SWALLOWED::x#0 ambiguous positionShared']);
});

test('duplicate: an entry whose current identity is produced twice blocks the migration (nothing to write), and says which identity', () => {
    const legacy = report([finding('a.ts', 'catch#0', 1)], 2);
    const current = report([finding('a.ts', 'load>catch#0', 1), finding('a.ts', 'load>catch#0', 7)]);
    const migration = migrateBaseline(baselineOf([key('a.ts', 'catch#0')]), legacy, current, ROOT);
    assert.deepEqual(outcomes(migration), ['a.ts::R-ERR-SWALLOWED::catch#0 duplicate targetIdentityShared -> load>catch#0']);
    assert.equal(migration.baseline, null);
    assert.match(duplicateMigrationText(migration), /refusing to migrate the baseline .*a\.ts::R-ERR-SWALLOWED::load>catch#0/);
});

test('the result depends only on the inputs: entry and finding order change nothing', () => {
    const legacyFindings = [finding('a.ts', 'catch#0', 1), finding('a.ts', 'catch#1', 5), finding('c.ts', 'catch#0', 2)];
    const currentFindings = [finding('a.ts', 'load>catch#0', 1), finding('a.ts', 'save>catch#0', 5), finding('c.ts', '(module)>catch#0', 2)];
    const entries = [key('c.ts', 'catch#0'), key('a.ts', 'catch#1'), key('a.ts', 'catch#0'), key('gone.ts', 'catch#3')];
    const forward = migrateBaseline(baselineOf(entries), report(legacyFindings, 2), report(currentFindings), ROOT);
    const reversed = migrateBaseline(baselineOf([...entries].reverse()), report([...legacyFindings].reverse(), 2), report([...currentFindings].reverse()), ROOT);
    assert.deepEqual(reversed, forward);
    assert.deepEqual(migrationSummary(reversed), migrationSummary(forward));
});

test('migrationSummary: counts per outcome, every renamed entry old -> new, every dropped entry with outcome and reason', () => {
    const legacy = report([finding('a.ts', 'catch#0', 1), finding('a.ts', 'catch#0', 3), finding('b.ts', 'import:x', 1, 'R-DEP-UNUSED')], 2);
    const current = report([finding('a.ts', 'f>catch#0', 1), finding('a.ts', 'g>catch#0', 3), finding('b.ts', 'import:x', 1, 'R-DEP-UNUSED')]);
    const old = baselineOf([key('a.ts', 'catch#0'), key('b.ts', 'import:x', 'R-DEP-UNUSED'), key('gone.ts', 'catch#0')]);
    const summary = migrationSummary(migrateBaseline(old, legacy, current, ROOT));
    assert.deepEqual(
        {matched: summary.matched, notReproducible: summary.notReproducible, ambiguous: summary.ambiguous, duplicate: summary.duplicate, from: summary.from, to: summary.to},
        {matched: 1, notReproducible: 1, ambiguous: 1, duplicate: 0, from: 2, to: IDENTITY_SCHEME}
    );
    assert.deepEqual(summary.renamed, [], 'an unchanged identity is matched, not renamed');
    assert.deepEqual(
        summary.dropped.map((item) => `${item.outcome} ${item.reason} ${keyString(item.entry)}`),
        ['ambiguous legacyIdentityShared a.ts::R-ERR-SWALLOWED::catch#0', 'notReproducible noLegacyFinding gone.ts::R-ERR-SWALLOWED::catch#0']
    );
    const renamed = migrationSummary(migrateBaseline(baselineOf([key('a.ts', 'catch#0')]), report([finding('a.ts', 'catch#0', 1)], 2), report([finding('a.ts', 'f>catch#0', 1)]), ROOT));
    assert.deepEqual(renamed.renamed, [{from: key('a.ts', 'catch#0'), to: key('a.ts', 'f>catch#0')}]);
});

test('Markdown: a migration in the report shows one line of counts and the dropped entries (de and en)', () => {
    const summary = migrationSummary(
        migrateBaseline(baselineOf([key('a.ts', 'catch#0'), key('gone.ts', 'catch#0')]), report([finding('a.ts', 'catch#0', 1)], 2), report([finding('a.ts', 'f>catch#0', 1)]), ROOT)
    );
    const withMigration: AnalysisReport = {
        ...report([finding('a.ts', 'f>catch#0', 1)]),
        baseline: {newCount: 0, knownCount: 1, fixedCount: 0, fixed: [], migration: summary}
    };
    const en = toMarkdown(withMigration, {lang: 'en'});
    assert.match(en, / {2}- migrated from finding identity scheme 2 → 3: 1 carried over \(1 renamed\), 1 not reproducible, 0 ambiguous, 0 duplicate\n {4}- not reproducible \(noLegacyFinding\): gone\.ts R-ERR-SWALLOWED catch#0/);
    const de = toMarkdown(withMigration, {lang: 'de'});
    assert.match(de, /migriert von Finding-Identitätsschema 2 → 3: 1 übernommen \(1 umbenannt\), 1 nicht reproduzierbar, 0 mehrdeutig, 0 doppelt/);
    assert.doesNotMatch(toMarkdown(report([finding('a.ts', 'f>catch#0', 1)]), {lang: 'en'}), /migrated from/);
});

// --- through the real CLI --------------------------------------------------

const project = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(work, 'case-'));
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
    }
    return dir;
};

const cli = (path: string, args: string[], env: Record<string, string> = {}): {status: number; stdout: string; stderr: string} => {
    const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', path, ...args], {cwd: root, encoding: 'utf8', env: {...process.env, ...env}});
    return {status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr};
};

const legacyKeys = (dir: string, scheme: IdentityScheme): FindingKey[] =>
    analyze({
        rootPath: dir,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG,
        identityScheme: scheme
    }).report.findings.map((item) => findingKey(dir, item));

const swallow = (name: string): string => `export function ${name}(): void { try { JSON.parse('x'); } catch { } }`;

test('CLI: the JSON report carries the identity scheme and the migration (counts, renamed, dropped with reason); the reasons are on stderr', () => {
    const dir = project({'a.ts': `${swallow('load')}\n${swallow('save')}\n`});
    const path = join(work, 'json-baseline.json');
    writeFileSync(path, `${JSON.stringify({version: 1, identity: 2, findings: [...legacyKeys(dir, 2), key('gone.ts', 'catch#0')]})}\n`);
    const result = cli(dir, ['--baseline', path, '--migrate-baseline', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {versions: {identity: number}; baseline: {newCount: number; migration: ReturnType<typeof migrationSummary>}};
    assert.equal(parsed.versions.identity, IDENTITY_SCHEME);
    const migration = parsed.baseline.migration;
    assert.equal(migration.from, 2);
    assert.equal(migration.notReproducible, 1);
    assert.deepEqual(migration.dropped, [{outcome: 'notReproducible', reason: 'noLegacyFinding', entry: key('gone.ts', 'catch#0')}]);
    assert.ok(migration.matched >= 2);
    assert.equal(parsed.baseline.newCount, 0);
    assert.match(result.stderr, /migrated from finding identity scheme 2 to 3: \d+ entries carried over, 1 not reproduced by the current code \(dropped\), 0 ambiguous \(dropped\), 0 duplicate/);
    assert.match(result.stderr, /dropped: gone\.ts::R-ERR-SWALLOWED::catch#0 \(not reproducible — no finding has this identity under the old scheme\)/);
    // Migrating again: the file is current now — said so, nothing rewritten.
    const written = readFileSync(path, 'utf8');
    const again = cli(dir, ['--baseline', path, '--migrate-baseline', '--format', 'json']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /already uses finding identity scheme 3 — nothing to migrate/);
    assert.equal(readFileSync(path, 'utf8'), written);
    assert.equal((JSON.parse(again.stdout) as {baseline: {migration?: unknown}}).baseline.migration, undefined);
});

test('CLI: a migration that would write a duplicate identity exits 1 and leaves the old baseline untouched', () => {
    const dir = project({'a.ts': `${swallow('load')}\n`});
    const path = join(work, 'dup-baseline.json');
    const text = `${JSON.stringify({version: 1, identity: 2, findings: legacyKeys(dir, 2)})}\n`;
    writeFileSync(path, text);
    // The test hook repeats the first current finding under its identity.
    const result = cli(dir, ['--baseline', path, '--migrate-baseline', '--format', 'json'], {STOA_TEST_DUPLICATE_IDENTITY: '1'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1 duplicate/);
    assert.match(result.stderr, /refusing to migrate the baseline \(it could not be read back\): 1 identity .*nothing was compared or written/);
    assert.equal(readFileSync(path, 'utf8'), text);
});

test('CLI: without a baseline an identity collision is still named on stderr, the exit code unchanged', () => {
    const dir = project({'a.ts': `${swallow('load')}\n`});
    const plain = cli(dir, ['--format', 'json']);
    const collided = cli(dir, ['--format', 'json'], {STOA_TEST_DUPLICATE_IDENTITY: '1'});
    assert.equal(collided.status, plain.status);
    assert.doesNotMatch(plain.stderr, /identity collision/);
    assert.match(collided.stderr, /WARNING: identity collision — 1 identity \(file, rule, symbol\) produced by more than one finding/);
});

test('CLI: --migrate-baseline with a baseline file that does not exist yet says there is nothing to migrate', () => {
    const dir = project({'a.ts': 'export const x = 1;\n'});
    const result = cli(dir, ['--baseline', join(work, 'missing.json'), '--migrate-baseline', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /does not exist yet — nothing to migrate/);
});
