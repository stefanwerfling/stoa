import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {diffFindings, isSemanticallyEqual} from '../src/FindingDiff.js';
import {duplicateIdentityText, duplicateKeys, keyString} from '../src/FindingIdentity.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {RuleEngine} from '../src/rules/RuleEngine.js';
import {RuleSet} from '../src/rules/RuleSet.js';
import type {AnalysisReport, Fact, Finding} from '../src/Types.js';

// Finding identity spec, phase 2: one identity definition (FindingIdentity.ts)
// in the evaluator, the baseline, the snapshot diff and the de-duplication;
// no merging of different findings; a shift told apart from a change;
// a repeated identity reported as a rule defect. CLI paths run the real
// processes (`stoa analyze`/`stoa eval`, scripts/compare-findings.ts).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

interface Run {
    status: number;
    stdout: string;
    stderr: string;
}

const run = (args: string[], env: Record<string, string> = {}): Run => {
    const result = spawnSync('node', ['--import', 'tsx', ...args], {cwd: root, encoding: 'utf8', env: {...process.env, ...env}});
    return {status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr};
};

const cli = (args: string[], env: Record<string, string> = {}): Run => run(['src/Cli.ts', ...args], env);

const compare = (args: string[]): Run => run(['scripts/compare-findings.ts', ...args]);

const SERVICE = [
    'declare function work(): void;',
    'export function load(): void {',
    '    try { work(); } catch (e) {}',
    '}',
    'export function save(): void {',
    '    try { work(); } catch (e) {}',
    '}',
    ''
].join('\n');

const withProject = (body: (dir: string, project: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-identity-'));
    const project = join(dir, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'service.ts'), SERVICE);
    try {
        body(dir, project);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
};

// ---------------------------------------------------------------------------
// De-duplication

const engine = (): RuleEngine =>
    new RuleEngine(
        KnowledgeBase.loadFromDirectory(join(root, 'knowledge', 'marcus'), DEFAULT_CONFIG.knowledgeBase),
        RuleSet.loadFromDirectory(join(root, 'rules', 'default'), 'default@1'),
        'en',
        []
    );

const catchFact = (symbol: string): Fact => ({
    id: `fact:/p/a.ts:ast.catchSwallowsError:${symbol}:3`,
    kind: 'ast.catchSwallowsError',
    subject: {file: '/p/a.ts', symbol, kindOf: 'catch-clause', range: {startLine: 3, startCol: 10, endLine: 3, endCol: 20}},
    value: true,
    evidence: [{source: 'ast', detail: 'ast.catchSwallowsError'}],
    certainty: 'syntactic',
    producedBy: {adapter: 'test', version: '1'}
});

test('de-duplication: two subjects at one position with different symbols are two findings, never merged', () => {
    const findings = engine().evaluate([catchFact('a>catch#0'), catchFact('b>catch#0')]);
    assert.deepEqual(findings.map((finding) => `${finding.rule.id} ${finding.location.symbol}`).sort(), ['R-ERR-SWALLOWED a>catch#0', 'R-ERR-SWALLOWED b>catch#0']);
});

test('de-duplication: the same subject reported twice is still one finding (one problem, counted once)', () => {
    const findings = engine().evaluate([catchFact('a>catch#0'), {...catchFact('a>catch#0'), id: 'fact:other'}]);
    assert.equal(findings.length, 1);
});

// ---------------------------------------------------------------------------
// Shared identity helpers

test('duplicateKeys lists each repeated identity once, in key order; the text names count and keys', () => {
    const key = (symbol: string) => ({file: 'a.ts', rule: 'R', symbol});
    const repeated = duplicateKeys([key('y'), key('x'), key('y'), key('x'), key('y'), key('z')]);
    assert.deepEqual(repeated.map(keyString), ['a.ts::R::x', 'a.ts::R::y']);
    assert.equal(duplicateIdentityText(repeated), '2 identities (file, rule, symbol) produced by more than one finding — a rule defect: a.ts::R::x, a.ts::R::y');
    assert.deepEqual(duplicateKeys([key('x')]), []);
});

// ---------------------------------------------------------------------------
// FindingDiff

const finding = (symbol: string, line: number, extra: Partial<Finding> = {}): Finding => ({
    id: `finding:R-ERR-SWALLOWED:/r/a.ts:${line}:4`,
    rule: {id: 'R-ERR-SWALLOWED', version: '1'},
    ruleSet: 'default@1',
    location: {file: '/r/a.ts', range: {startLine: line, startCol: 4, endLine: line, endCol: 9}, symbol},
    observation: {statement: `catch in ${symbol}`, evidence: []},
    interpretation: {principles: [], dimensions: ['robustness']},
    severity: 'high',
    confidence: 0.9,
    certaintyBasis: 'syntactic',
    remediation: {suggestion: 's'},
    source: 'deterministic',
    ...extra
});

test('FindingDiff: a shift is "moved", a content change is "changed" with its fields, the rest added/removed', () => {
    const diff = diffFindings(
        [finding('load>catch#0', 3), finding('save>catch#0', 6), finding('gone>catch#0', 9), finding('same>catch#0', 12)],
        [finding('load>catch#0', 5), finding('save>catch#0', 6, {severity: 'medium'}), finding('new>catch#0', 20), finding('same>catch#0', 12)],
        '/r'
    );
    assert.equal(diff.pairing, 'identity');
    assert.equal(diff.same, 1);
    assert.deepEqual(diff.moved.map(keyString), ['a.ts::R-ERR-SWALLOWED::load>catch#0']);
    assert.deepEqual(diff.changed, [{key: {file: 'a.ts', rule: 'R-ERR-SWALLOWED', symbol: 'save>catch#0'}, fields: ['.severity']}]);
    assert.deepEqual(diff.added.map(keyString), ['a.ts::R-ERR-SWALLOWED::new>catch#0']);
    assert.deepEqual(diff.removed.map(keyString), ['a.ts::R-ERR-SWALLOWED::gone>catch#0']);
    assert.equal(isSemanticallyEqual(diff), false);
    const shiftOnly = diffFindings([finding('load>catch#0', 3)], [finding('load>catch#0', 4)], '/r');
    assert.equal(isSemanticallyEqual(shiftOnly), true);
    assert.equal(shiftOnly.moved.length, 1);
});

test('FindingDiff: a repeated identity is listed, never paired or merged', () => {
    const diff = diffFindings([finding('load>catch#0', 3)], [finding('load>catch#0', 3), finding('load>catch#0', 7)], '/r');
    assert.deepEqual(diff.duplicates.after.map(keyString), ['a.ts::R-ERR-SWALLOWED::load>catch#0']);
    assert.deepEqual([diff.same, diff.moved.length, diff.added.length, diff.removed.length], [0, 0, 0, 0]);
    assert.equal(isSemanticallyEqual(diff), false);
});

test('FindingDiff (position pairing): a changed identity is "renamed", the quoting statement is no change, a moved finding of unchanged name still pairs', () => {
    const diff = diffFindings(
        [finding('catch#0', 3), finding('catch#1', 6), finding('Kept', 9)],
        [finding('load>catch#0', 3), finding('save>catch#0', 6, {severity: 'low'}), finding('Kept', 11)],
        '/r',
        'position'
    );
    assert.deepEqual(diff.renamed.map((entry) => `${entry.before.symbol} -> ${entry.after.symbol}`), ['catch#0 -> load>catch#0', 'catch#1 -> save>catch#0']);
    assert.deepEqual(diff.changed, [{key: {file: 'a.ts', rule: 'R-ERR-SWALLOWED', symbol: 'save>catch#0'}, fields: ['.severity']}]);
    assert.deepEqual(diff.moved.map(keyString), ['a.ts::R-ERR-SWALLOWED::Kept']);
    assert.deepEqual([diff.added.length, diff.removed.length], [0, 0]);
});

// ---------------------------------------------------------------------------
// Evaluator: the manifest's identity scheme

const evalWith = (project: string, dir: string, manifest: Record<string, unknown>): Run => {
    const path = join(dir, 'expected.json');
    writeFileSync(path, JSON.stringify(manifest));
    return cli(['eval', project, '--expected', path, '--format', 'json']);
};

const EXPECTED = [
    {file: 'service.ts', rule: 'R-ERR-SWALLOWED', symbol: 'load>catch#0'},
    {file: 'service.ts', rule: 'R-ERR-SWALLOWED', symbol: 'save>catch#0'}
];

test('CLI eval: a manifest without "identity" is scheme 1 and refused with the reason; an older scheme too; scheme 3 passes; an invalid value is malformed', () => {
    withProject((dir, project) => {
        const legacy = evalWith(project, dir, {findings: EXPECTED});
        assert.equal(legacy.status, 1);
        assert.match(legacy.stderr, /uses finding identity scheme 1 \(it has no "identity" field\), this stoa uses scheme 3 .*nothing was evaluated/);
        assert.equal(legacy.stdout, '');
        const old = evalWith(project, dir, {identity: 1, findings: EXPECTED});
        assert.equal(old.status, 1);
        assert.match(old.stderr, /uses finding identity scheme 1, this stoa uses scheme 3/);
        const previous = evalWith(project, dir, {identity: 2, findings: EXPECTED});
        assert.equal(previous.status, 1);
        assert.match(previous.stderr, /uses finding identity scheme 2, this stoa uses scheme 3/);
        assert.equal(previous.stdout, '');
        const invalid = evalWith(project, dir, {identity: 4, findings: EXPECTED});
        assert.equal(invalid.status, 1);
        assert.match(invalid.stderr, /"identity" must be 1, 2 or 3 when present, got 4/);
        const current = evalWith(project, dir, {identity: 3, findings: EXPECTED});
        assert.equal(current.status, 0, current.stderr);
        assert.equal((JSON.parse(current.stdout) as {outcome: string}).outcome, 'passed');
    });
});

test('CLI eval: a repeated produced identity still fails the evaluation (integrity violation)', () => {
    withProject((dir, project) => {
        const path = join(dir, 'expected.json');
        writeFileSync(path, JSON.stringify({identity: 3, findings: EXPECTED}));
        const result = cli(['eval', project, '--expected', path, '--format', 'json'], {STOA_TEST_DUPLICATE_IDENTITY: '1'});
        assert.equal(result.status, 1);
        assert.match(result.stderr, /identity collision/);
        assert.equal((JSON.parse(result.stdout) as {duplicates: unknown[]}).duplicates.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Baseline: shift vs change, and a repeated identity

const analyzeWith = (project: string, args: string[], env: Record<string, string> = {}): Run => cli(['analyze', project, ...args], env);

const summaryOf = (output: string): NonNullable<AnalysisReport['baseline']> => (JSON.parse(output) as AnalysisReport).baseline as NonNullable<AnalysisReport['baseline']>;

test('CLI baseline: a position shift keeps every finding known; a new site in another function is the one new finding; a renamed function is new + fixed', () => {
    withProject((dir, project) => {
        const baseline = join(dir, 'baseline.json');
        assert.equal(analyzeWith(project, ['--baseline', baseline, '--update-baseline', '--format', 'json']).status, 0);
        writeFileSync(join(project, 'service.ts'), `// a header\n// that shifts every line\n\n${SERVICE}`);
        const shifted = summaryOf(analyzeWith(project, ['--baseline', baseline, '--format', 'json']).stdout);
        assert.deepEqual([shifted.newCount, shifted.knownCount, shifted.fixedCount], [0, 2, 0]);
        writeFileSync(join(project, 'service.ts'), `${SERVICE}export function extra(): void {\n    try { work(); } catch (e) {}\n}\n`.replace('export function load(): void {', 'export function load(): void {\n    try { work(); } catch (e) {}'));
        const grown = JSON.parse(analyzeWith(project, ['--baseline', baseline, '--format', 'json']).stdout) as AnalysisReport;
        assert.deepEqual(
            grown.findings.filter((entry) => entry.baselineStatus === 'new').map((entry) => entry.location.symbol).sort(),
            ['extra>catch#0', 'load>catch#1']
        );
        assert.equal(grown.baseline?.knownCount, 2);
        writeFileSync(join(project, 'service.ts'), SERVICE.replace('function save', 'function store'));
        const renamed = summaryOf(analyzeWith(project, ['--baseline', baseline, '--format', 'json']).stdout);
        assert.deepEqual([renamed.newCount, renamed.knownCount, renamed.fixedCount], [1, 1, 1]);
        assert.deepEqual(renamed.fixed.map(keyString), ['service.ts::R-ERR-SWALLOWED::save>catch#0']);
    });
});

test('CLI baseline: a repeated identity is reported (stderr, JSON, Markdown) and never merged; --update-baseline refuses it', () => {
    withProject((dir, project) => {
        const baseline = join(dir, 'baseline.json');
        assert.equal(analyzeWith(project, ['--baseline', baseline, '--update-baseline', '--format', 'json']).status, 0);
        const before = readFileSync(baseline, 'utf8');
        const duplicate = {STOA_TEST_DUPLICATE_IDENTITY: '1'};
        const json = analyzeWith(project, ['--baseline', baseline, '--format', 'json'], duplicate);
        assert.equal(json.status, 0);
        assert.match(json.stderr, /WARNING: identity collision — 1 identity \(file, rule, symbol\) produced by more than one finding — a rule defect: service\.ts::R-ERR-SWALLOWED::/);
        const report = JSON.parse(json.stdout) as AnalysisReport;
        assert.equal(report.findings.length, 3);
        assert.equal(report.baseline?.duplicateIdentities?.length, 1);
        const markdown = analyzeWith(project, ['--baseline', baseline], duplicate);
        assert.match(markdown.stdout, /- Baseline: 0 new, 3 known, 0 fixed, 1 identity collision\(s\), status unreliable/);
        const update = analyzeWith(project, ['--baseline', baseline, '--update-baseline'], duplicate);
        assert.equal(update.status, 1);
        assert.match(update.stderr, /refusing to update baseline .*produced by more than one finding/);
        assert.equal(readFileSync(baseline, 'utf8'), before);
        const clean = analyzeWith(project, ['--baseline', baseline, '--format', 'json']);
        assert.equal(summaryOf(clean.stdout).duplicateIdentities, undefined);
    });
});

// ---------------------------------------------------------------------------
// Snapshot and snapshot diff (scripts/compare-findings.ts)

const snapshotOf = (dir: string, project: string, name: string): string => {
    const targets = join(dir, 'targets.json');
    writeFileSync(targets, JSON.stringify([{name: 'p', path: project}]));
    const out = join(dir, name);
    const result = compare(['snapshot', out, '--targets', targets]);
    assert.equal(result.status, 0, result.stderr);
    return out;
};

test('snapshot diff: identical → same (exit 0); a shift → moved; a new finding → CHANGED with "+"; a repeated identity → INTEGRITY', () => {
    withProject((dir, project) => {
        const first = snapshotOf(dir, project, 'first');
        assert.deepEqual(JSON.parse(readFileSync(join(first, 'snapshot.json'), 'utf8')), {identity: 3});
        const again = compare(['diff', first, snapshotOf(dir, project, 'again')]);
        assert.equal(again.status, 0);
        assert.match(again.stdout, /^same {6}p\.jsonl$/m);

        writeFileSync(join(project, 'service.ts'), `// shifted\n${SERVICE}`);
        const shifted = compare(['diff', first, snapshotOf(dir, project, 'shifted')]);
        assert.equal(shifted.status, 1);
        assert.match(shifted.stdout, /^moved {5}p\.jsonl \(same 0, moved 2, changed 0, renamed 0, \+0 -0\)$/m);

        writeFileSync(join(project, 'service.ts'), `${SERVICE}export function extra(): void {\n    try { work(); } catch (e) {}\n}\n`);
        const grown = compare(['diff', first, snapshotOf(dir, project, 'grown')]);
        assert.equal(grown.status, 1);
        assert.match(grown.stdout, /^CHANGED {3}p\.jsonl \(same 2, moved 0, changed 0, renamed 0, \+1 -0\)\n {2}\+ service\.ts::R-ERR-SWALLOWED::extra>catch#0$/m);

        const doubled = join(dir, 'doubled');
        mkdirSync(doubled);
        writeFileSync(join(doubled, 'snapshot.json'), JSON.stringify({identity: 3}));
        const lines = readFileSync(join(first, 'p.jsonl'), 'utf8');
        writeFileSync(join(doubled, 'p.jsonl'), `${lines}${lines.split('\n')[0] ?? ''}\n`);
        const integrity = compare(['diff', first, doubled]);
        assert.equal(integrity.status, 1);
        assert.match(integrity.stdout, /^INTEGRITY p\.jsonl/m);
        assert.match(integrity.stdout, /! duplicate after: service\.ts::R-ERR-SWALLOWED::load>catch#0/);
    });
});

test('snapshot diff across identity schemes: said so, paired by position, a changed identity listed as renamed', () => {
    withProject((dir, project) => {
        const current = snapshotOf(dir, project, 'current');
        const legacy = join(dir, 'legacy');
        mkdirSync(legacy);
        // A scheme-1 snapshot (no snapshot.json): the same findings under their old names.
        writeFileSync(
            join(legacy, 'p.jsonl'),
            readFileSync(join(current, 'p.jsonl'), 'utf8').replaceAll('load>catch#0', 'catch#0').replaceAll('save>catch#0', 'catch#1')
        );
        const result = compare(['diff', legacy, current]);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /identity schemes differ \(before 1, after 3\): findings are paired by position/);
        assert.match(result.stdout, /= service\.ts::R-ERR-SWALLOWED::catch#0 -> service\.ts::R-ERR-SWALLOWED::load>catch#0/);
        assert.match(result.stdout, /= service\.ts::R-ERR-SWALLOWED::catch#1 -> service\.ts::R-ERR-SWALLOWED::save>catch#0/);
        assert.match(result.stdout, /\(same 0, moved 0, changed 0, renamed 2, \+0 -0\)/);
        unlinkSync(join(current, 'snapshot.json'));
        // Both scheme 1 now: paired by identity, so the old names read as removed/added.
        assert.match(compare(['diff', legacy, current]).stdout, /\+2 -2/);
    });
});
