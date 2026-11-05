import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initCpp} from '../src/analysis/CppAdapter.js';
import {initDart} from '../src/analysis/DartAdapter.js';
import {assignSiteSymbols} from '../src/analysis/SiteIdentity.js';
import {TypeScriptAdapter} from '../src/analysis/TypeScriptAdapter.js';
import {applyBaseline, baselineScheme, IncompleteAnalysisError, loadBaseline, saveBaseline} from '../src/Baseline.js';
import {migrateBaseline} from '../src/BaselineMigration.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {findingKey, IDENTITY_SCHEME, keyString, type IdentityScheme} from '../src/FindingIdentity.js';
import {analyze, analyzeAsync} from '../src/Pipeline.js';
import type {AnalysisReport} from '../src/Types.js';

// Finding identity scheme 2 (src/FindingIdentity.ts): symbol identity is the
// declaration's qualified path (namespaces included), a finding site is named
// relative to its enclosing declaration (`load>catch#0`) or, for an import, by
// its module — so an edit elsewhere in the file renames nothing. A baseline
// records its scheme; one of another scheme is refused, or migrated
// explicitly (`--migrate-baseline`).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

let work: string;

before(async () => {
    await initDart();
    await initCpp();
    work = mkdtempSync(join(tmpdir(), 'stoa-identity-scheme-'));
});

after(() => {
    rmSync(work, {recursive: true, force: true});
});

const project = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(work, 'case-'));
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
    }
    return dir;
};

const analyzeDir = (dir: string, scheme?: IdentityScheme): ReturnType<typeof analyze> =>
    analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, ...(scheme !== undefined ? {identityScheme: scheme} : {})});

/** The symbols of one fact kind for one file, in source order. */
const symbolsOf = (files: Record<string, string>, name: string, kind: string, scheme?: IdentityScheme): string[] =>
    analyzeDir(project(files), scheme)
        .facts.filter((fact) => fact.kind === kind && basename(fact.subject.file) === name)
        .sort((a, b) => a.subject.range.startLine - b.subject.range.startLine || a.subject.range.startCol - b.subject.range.startCol)
        .map((fact) => fact.subject.symbol ?? '');

const functionsOf = (name: string, content: string): string[] => symbolsOf({[name]: content}, name, 'metric.functionLength');

test('namespaces: same-named functions and methods in two namespaces are two identities (TS, PHP, C++)', () => {
    assert.deepEqual(
        functionsOf('a.ts', ['namespace Admin { export function validate(): void {} }', 'namespace Customer { export function validate(): void {} }', 'namespace A.B { export function f(): void {} }', ''].join('\n')),
        ['Admin.validate', 'Customer.validate', 'A.B.f']
    );
    assert.deepEqual(
        functionsOf('a.php', ['<?php', 'namespace Admin { function validate() {} class User { public function save() {} } }', 'namespace Customer { function validate() {} class User { public function save() {} } }', ''].join('\n')),
        ['Admin\\validate', 'Admin\\User.save', 'Customer\\validate', 'Customer\\User.save']
    );
    assert.deepEqual(
        functionsOf(
            'a.cpp',
            [
                'namespace admin { void validate() {} }',
                'namespace customer { void validate() {} }',
                'namespace io { struct Buffer { void reset() {} }; }',
                'namespace io { void Buffer::flush() {} }',
                'void io::Buffer::close() {}',
                'namespace { void helper() {} }',
                ''
            ].join('\n')
        ),
        ['admin::validate', 'customer::validate', 'io::Buffer::reset', 'io::Buffer::flush', 'io::Buffer::close', '(anonymous)::helper']
    );
});

test('a PHP namespace qualifies class-level identities too (one file, two namespaces, one class name)', () => {
    const migration = (namespace: string): string =>
        `namespace ${namespace} { final class Version1 extends AbstractMigration { public function up(Schema $schema): void { $this->addSql('CREATE TABLE t (id INT)'); } } }`;
    const dir = project({'m.php': ['<?php', migration('A'), migration('B'), ''].join('\n')});
    const symbols = analyzeDir(dir)
        .report.findings.filter((finding) => finding.rule.id === 'R-MIGRATION-NO-DOWN' || finding.rule.id === 'R-MIGRATION-UNGUARDED-DDL')
        .map((finding) => `${finding.rule.id} ${finding.location.symbol ?? ''}`)
        .sort();
    // Scheme 1 numbered the DDL per class (`ddl#0` twice: one key for two findings).
    assert.deepEqual(symbols, ['R-MIGRATION-NO-DOWN A\\Version1', 'R-MIGRATION-NO-DOWN B\\Version1', 'R-MIGRATION-UNGUARDED-DDL A\\Version1.up>ddl#0', 'R-MIGRATION-UNGUARDED-DDL B\\Version1.up>ddl#0']);
});

test('Dart: an unnamed extension is a scope of its own, so its method no longer shares a top-level function\'s symbol', () => {
    assert.deepEqual(functionsOf('a.dart', ['extension on List<String> { void save() {} }', 'void save() {}', ''].join('\n')), ['(extension on List<String>).save', 'save']);
    assert.deepEqual(symbolsOf({'a.dart': 'extension on List<String> { void save() {} }\nvoid save() {}\n'}, 'a.dart', 'metric.functionLength', 1), ['save#0', 'save#1']);
});

test('overloads: C++ by parameter types (names and defaults dropped), a unique name stays bare; TS overloads are one implementation', () => {
    assert.deepEqual(
        functionsOf('a.cpp', ['void f(const char* s, int& n) {}', 'void f(std::vector<int> v = {}) {}', 'void f(int) {}', 'void g(int x) {}', ''].join('\n')),
        ['f(const char*, int&)', 'f(std::vector<int>)', 'f(int)', 'g']
    );
    assert.deepEqual(functionsOf('a.ts', 'export function ov(a: string): void;\nexport function ov(a: number): void;\nexport function ov(a: unknown): void {}\n'), ['ov']);
});

test('modules: the same name in two files is two identities (the file is part of the key)', () => {
    const six = 'a: number, b: number, c: number, d: number, e: number, f: number';
    const dir = project({'a.ts': `export function validate(${six}): number { return a; }\n`, 'b.ts': `export function validate(${six}): number { return a; }\n`});
    const keys = analyzeDir(dir)
        .report.findings.filter((finding) => finding.rule.id === 'R-FN-TOO-MANY-PARAMS')
        .map((finding) => keyString(findingKey(dir, finding)));
    assert.deepEqual(keys, ['a.ts::R-FN-TOO-MANY-PARAMS::validate', 'b.ts::R-FN-TOO-MANY-PARAMS::validate']);
});

const CATCHES: Record<string, {name: string; fn: (name: string) => string; header?: string}> = {
    TypeScript: {name: 'a.ts', fn: (name) => `export function ${name}(): void { try { JSON.parse('x'); } catch { } }`},
    PHP: {name: 'a.php', header: '<?php', fn: (name) => `function ${name}() { try { f(); } catch (\\Exception $e) { } }`},
    Dart: {name: 'a.dart', fn: (name) => `void ${name}() { try { f(); } catch (e) { } }`},
    'C++': {name: 'a.cpp', fn: (name) => `void ${name}() { try { f(); } catch (...) { } }`}
};

for (const [language, {name, fn, header}] of Object.entries(CATCHES)) {
    test(`${language}: a site is named in its declaration — a new site in another declaration and shifted lines rename nothing; a renamed declaration renames its sites`, () => {
        const file = (...functions: string[]): Record<string, string> => ({[name]: [...(header !== undefined ? [header] : []), ...functions, ''].join('\n')});
        const before = symbolsOf(file(fn('load'), fn('save')), name, 'ast.emptyCatch');
        const inserted = symbolsOf(file('', '', fn('early'), fn('load'), fn('save')), name, 'ast.emptyCatch');
        const renamed = symbolsOf(file(fn('read'), fn('save')), name, 'ast.emptyCatch');
        assert.deepEqual(before, ['load>catch#0', 'save>catch#0']);
        assert.deepEqual(inserted, ['early>catch#0', 'load>catch#0', 'save>catch#0']);
        assert.deepEqual(renamed, ['read>catch#0', 'save>catch#0'], 'the identity follows its declaration: a baseline reports the renamed one as new and the old one as fixed');
        // Scheme 1 numbered per file: the insertion shifted both old sites.
        assert.deepEqual(symbolsOf(file('', '', fn('early'), fn('load'), fn('save')), name, 'ast.emptyCatch', 1), ['catch#0', 'catch#1', 'catch#2']);
    });
}

test('imports are named by their module; an import added above renames none; the same module twice is told apart by order', () => {
    const imports = (lines: string[]): string[] => symbolsOf({'a.ts': [...lines, 'export const x = 1;', ''].join('\n')}, 'a.ts', 'deps.import');
    assert.deepEqual(imports(["import {a} from './a';", "import {b} from './b';"]), ['import:./a', 'import:./b']);
    assert.deepEqual(imports(["import {c} from './c';", "import {a} from './a';", "import {b} from './b';"]), ['import:./c', 'import:./a', 'import:./b']);
    assert.deepEqual(imports(["import {a} from './a';", "import {a2} from './a';"]), ['import:./a#0', 'import:./a#1']);
});

test('site identities do not depend on the order of the facts', () => {
    const adapter = new TypeScriptAdapter();
    const content = ['import {a} from "./a";', 'export class S {', '    load(): void { try { a(); } catch { } try { a(); } catch { } }', '}', 'export function f(): void { try { a(); } catch { } }', ''].join('\n');
    const parsed = adapter.parse({path: join(work, 'order.ts'), content});
    const legacy = adapter.extractFacts(parsed, {rootDir: work, identityScheme: 1});
    parsed.release?.();
    const symbolsById = (facts: ReturnType<typeof assignSiteSymbols>): string[] => facts.map((fact) => `${fact.kind} ${fact.subject.range.startLine}:${fact.subject.range.startCol} ${fact.subject.symbol ?? ''}`).sort();
    const forward = symbolsById(assignSiteSymbols(legacy, 2));
    assert.deepEqual(symbolsById(assignSiteSymbols([...legacy].reverse(), 2)), forward);
    assert.ok(forward.includes('ast.emptyCatch 3:33 S.load>catch#0') && forward.includes('ast.emptyCatch 3:56 S.load>catch#1') && forward.includes('ast.emptyCatch 5:42 f>catch#0'), forward.join('\n'));
});

test('--jobs: worker extraction yields the same identities as the sequential run (all four languages)', async () => {
    const dir = project({
        'a.ts': 'namespace N { export function f(): void { try { JSON.parse("x"); } catch { } } }\n',
        'b.php': '<?php\nnamespace App { function f() { try { g(); } catch (\\Exception $e) { } } }\n',
        'c.dart': 'extension on String { void f() { try { g(); } catch (e) { } } }\n',
        'd.cpp': 'namespace io { void f(int) { try { g(); } catch (...) { } } void f(double) {} }\n'
    });
    const keysOf = async (jobs: number): Promise<string[]> =>
        (await analyzeAsync({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, jobs})).report.findings.map((finding) => keyString(findingKey(dir, finding)));
    const sequential = await keysOf(1);
    assert.deepEqual(await keysOf(2), sequential);
    assert.ok(sequential.includes('a.ts::R-ERR-SWALLOWED::N.f>catch#0') && sequential.includes('b.php::R-ERR-SWALLOWED::App\\f>catch#0') && sequential.includes('c.dart::R-ERR-SWALLOWED::(extension on String).f>catch#0') && sequential.includes('d.cpp::R-ERR-SWALLOWED::io::f(int)>catch#0'), sequential.join('\n'));
});

test('baseline files record their scheme; one without it is scheme 1 and is refused for comparison, never silently compared', () => {
    const dir = project({'a.ts': "export function f(): void { try { JSON.parse('x'); } catch { } }\n"});
    const {report} = analyzeDir(dir);
    const path = join(dir, 'baseline.json');
    saveBaseline(path, report, dir);
    const saved = loadBaseline(path);
    assert.equal(saved?.identity, IDENTITY_SCHEME);
    writeFileSync(path, JSON.stringify({version: 1, findings: [{file: 'a.ts', rule: 'R-ERR-SWALLOWED', symbol: 'catch#0'}]}));
    const legacy = loadBaseline(path);
    assert.ok(legacy !== null && baselineScheme(legacy) === 1);
    assert.throws(() => applyBaseline(report, legacy, dir), /uses finding identity scheme 1, this stoa uses scheme 2.*--migrate-baseline/);
    writeFileSync(path, JSON.stringify({version: 1, identity: 7, findings: []}));
    assert.throws(() => loadBaseline(path), /"identity" must be 1 or 2/);
});

test('migrateBaseline pairs each finding with itself across both schemes, drops (and lists) what is no longer reproduced, refuses a partial scan', () => {
    const dir = project({'a.ts': "export function f(): void { try { JSON.parse('x'); } catch { } }\nexport function g(): void { try { JSON.parse('y'); } catch { } }\n"});
    const legacy = analyzeDir(dir, 1).report;
    const current = analyzeDir(dir).report;
    const old = {version: 1 as const, findings: [...legacy.findings.map((finding) => findingKey(dir, finding)), {file: 'gone.ts', rule: 'R-ERR-SWALLOWED', symbol: 'catch#0'}]};
    const migration = migrateBaseline(old, legacy, current, dir);
    assert.equal(migration.baseline.identity, IDENTITY_SCHEME);
    assert.deepEqual(migration.baseline.findings.map(keyString), current.findings.map((finding) => keyString(findingKey(dir, finding))).sort());
    assert.deepEqual(migration.unmatched.map(keyString), ['gone.ts::R-ERR-SWALLOWED::catch#0']);
    const partial: AnalysisReport = {...legacy, coverage: {...legacy.coverage, status: 'partial'}};
    assert.throws(() => migrateBaseline(old, partial, current, dir), IncompleteAnalysisError);
});

const cli = (path: string, args: string[]): {status: number; stdout: string; stderr: string} => {
    const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', path, ...args], {cwd: root, encoding: 'utf8'});
    return {status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr};
};

test('CLI: a scheme-1 baseline exits 1 untouched without --migrate-baseline; with it, it is converted in place and compared, and new sites are attributed correctly afterwards', () => {
    const fn = (name: string): string => `export function ${name}(): void { try { JSON.parse('x'); } catch { } }`;
    const dir = project({'a.ts': `${fn('load')}\n${fn('save')}\n`});
    const path = join(work, `baseline-${basename(dir)}.json`);
    const legacyKeys = analyzeDir(dir, 1).report.findings.map((finding) => findingKey(dir, finding));
    const legacyText = `${JSON.stringify({version: 1, findings: [...legacyKeys, {file: 'gone.ts', rule: 'R-ERR-SWALLOWED', symbol: 'catch#4'}]}, null, 2)}\n`;
    writeFileSync(path, legacyText);

    const refused = cli(dir, ['--baseline', path, '--format', 'json']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /uses finding identity scheme 1, this stoa uses scheme 2.*--migrate-baseline/);
    assert.equal(readFileSync(path, 'utf8'), legacyText, 'nothing compared, nothing written');

    const migrated = cli(dir, ['--baseline', path, '--migrate-baseline', '--format', 'json']);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.match(migrated.stderr, /migrated from finding identity scheme 1 to 2: \d+ entries carried over, 1 not reproduced by the current code \(dropped\)/);
    assert.match(migrated.stderr, /dropped: gone\.ts::R-ERR-SWALLOWED::catch#4/);
    const written = JSON.parse(readFileSync(path, 'utf8')) as {identity: number; findings: {symbol: string}[]};
    assert.equal(written.identity, 2);
    assert.ok(written.findings.some((entry) => entry.symbol === 'load>catch#0') && written.findings.some((entry) => entry.symbol === 'save>catch#0'));
    const report = JSON.parse(migrated.stdout) as {findings: {baselineStatus?: string}[]; baseline: {newCount: number; fixedCount: number}};
    assert.equal(report.baseline.newCount, 0);
    assert.equal(report.baseline.fixedCount, 0);

    // The defect scheme 1 had: a catch added in a NEW function above the
    // others made the new one "known" and an old one "new". Now the new site
    // is the new finding, and the old ones stay known.
    writeFileSync(join(dir, 'a.ts'), `${fn('early')}\n${fn('load')}\n${fn('save')}\n`);
    const after = cli(dir, ['--baseline', path, '--format', 'json']);
    assert.equal(after.status, 0, after.stderr);
    const swallowed = (JSON.parse(after.stdout) as {findings: {rule: {id: string}; location: {symbol: string}; baselineStatus: string}[]}).findings
        .filter((finding) => finding.rule.id === 'R-ERR-SWALLOWED')
        .map((finding) => `${finding.location.symbol} ${finding.baselineStatus}`);
    assert.deepEqual(swallowed, ['early>catch#0 new', 'load>catch#0 known', 'save>catch#0 known']);
});

test('CLI: --migrate-baseline without --baseline is a usage error', () => {
    const result = cli(project({'a.ts': 'export const x = 1;\n'}), ['--migrate-baseline']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--migrate-baseline requires --baseline/);
});
