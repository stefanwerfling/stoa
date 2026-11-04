import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';

// Evaluator integrity (Phase 1): `stoa eval` through the REAL CLI process.
// 0 = complete analysis and the evaluation passed; 1 = complete analysis and
// the evaluation failed (FP/FN), or a technical error; 2 = the analysis was
// incomplete — never a pass, even when every finding produced so far matches.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

interface EvalJson {
    overall: {truePositives: number; falsePositives: number; falseNegatives: number};
    analysis: {status: string; stoppedAtFile?: string};
    outcome: string;
}

interface Key {
    file: string;
    rule: string;
    symbol: string;
}

let project: string;
let work: string;
// Two classes in one file with a same-named method: the adapters name a
// function by its bare name, so both findings get one identity — a real,
// still-open identity collision (see implementation-status), used here as the
// source of a duplicate PRODUCED identity through the unmodified CLI.
let collidingProject: string;

const stoa = (args: string[], env: NodeJS.ProcessEnv = {}): {status: number | null; stdout: string; stderr: string} =>
    spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', ...args], {cwd: root, encoding: 'utf8', env: {...process.env, ...env}});

/** The identity keys `analyze` produces for `project` (optionally under the forced-incomplete hook). */
const producedKeys = (env: NodeJS.ProcessEnv = {}): Key[] => {
    const result = stoa(['analyze', project, '--format', 'json'], env);
    const report = JSON.parse(result.stdout) as {findings: {rule: {id: string}; location: {file: string; symbol?: string}}[]};
    return report.findings.map((finding) => ({file: finding.location.file.slice(project.length + 1), rule: finding.rule.id, symbol: finding.location.symbol ?? ''}));
};

const manifest = (name: string, findings: Key[]): string => {
    const path = join(work, name);
    writeFileSync(path, JSON.stringify({findings}, null, 2));
    return path;
};

const evalJson = (expected: string, env: NodeJS.ProcessEnv = {}): {status: number | null; json: EvalJson; stderr: string} => {
    const result = stoa(['eval', project, '--expected', expected, '--format', 'json'], env);
    return {status: result.status, json: JSON.parse(result.stdout) as EvalJson, stderr: result.stderr};
};

before(() => {
    work = mkdtempSync(join(tmpdir(), 'stoa-eval-integrity-'));
    project = join(work, 'project');
    const fileWithEmptyCatch = (name: string): string => [`export function ${name}(): void {`, '    try {', '        JSON.parse("x");', '    } catch {', '    }', '}', ''].join('\n');
    spawnSync('mkdir', ['-p', project]);
    writeFileSync(join(project, 'a.ts'), fileWithEmptyCatch('alpha'));
    writeFileSync(join(project, 'b.ts'), fileWithEmptyCatch('beta'));
    writeFileSync(join(project, 'c.ts'), fileWithEmptyCatch('gamma'));
    collidingProject = join(work, 'colliding');
    spawnSync('mkdir', ['-p', collidingProject]);
    const sixParams = 'a: number, b: number, c: number, d: number, e: number, f: number';
    writeFileSync(join(collidingProject, 'a.ts'), `export class A {\n    run(${sixParams}): number {\n        return a + b + c + d + e + f;\n    }\n}\nexport class B {\n    run(${sixParams}): number {\n        return a + b + c + d + e + f;\n    }\n}\n`);
});

after(() => {
    rmSync(work, {recursive: true, force: true});
});

test('exit 0: complete analysis, every expectation met → outcome passed, analysis complete', () => {
    const keys = producedKeys();
    assert.ok(keys.length >= 3, 'the project produces findings in every file');
    const {status, json} = evalJson(manifest('all.json', keys));
    assert.equal(status, 0);
    assert.deepEqual([json.outcome, json.analysis.status], ['passed', 'complete']);
});

test('exit 1: complete analysis with a false positive (an expectation missing from the manifest) → outcome failed', () => {
    const keys = producedKeys();
    const {status, json} = evalJson(manifest('fp.json', keys.slice(1)));
    assert.equal(status, 1);
    assert.equal(json.outcome, 'failed');
    assert.equal(json.overall.falsePositives, 1);
});

test('exit 1: complete analysis with a false negative (an expected finding never produced) → outcome failed', () => {
    const keys = producedKeys();
    const {status, json} = evalJson(manifest('fn.json', [...keys, {file: 'a.ts', rule: 'R-DOES-NOT-EXIST', symbol: 'alpha'}]));
    assert.equal(status, 1);
    assert.equal(json.outcome, 'failed');
    assert.equal(json.overall.falseNegatives, 1);
});

test('exit 2: analysis stopped by the memory guard → outcome incomplete, analysis partial with the stop file, warning on stderr', () => {
    const {status, json, stderr} = evalJson(manifest('guard.json', producedKeys()), {STOA_TEST_FORCE_INCOMPLETE: '1'});
    assert.equal(status, 2);
    assert.deepEqual([json.outcome, json.analysis.status], ['incomplete', 'partial']);
    assert.ok(json.analysis.stoppedAtFile !== undefined);
    assert.match(stderr, /INCOMPLETE/);
});

test('exit 2: incomplete although every finding produced up to the abort matches the manifest exactly (no FP, no FN) — memory guard', () => {
    // The test hook aborts before the first file, so "everything produced so
    // far" is empty and the metrics are the vacuous 0 FP / 0 FN that used to
    // exit 0. The non-vacuous variant (real findings, all matching) is the
    // read-error test below.
    const env = {STOA_TEST_FORCE_INCOMPLETE: '1'};
    const reached = producedKeys(env);
    assert.ok(reached.length < producedKeys().length, 'the forced abort does not reach every file');
    const {status, json} = evalJson(manifest('reached.json', reached), env);
    assert.deepEqual([json.overall.falsePositives, json.overall.falseNegatives], [0, 0], 'the metrics alone would pass');
    assert.equal(status, 2);
    assert.equal(json.outcome, 'incomplete');
});

test('exit 2: a read error (an unreadable selected file) makes the evaluation incomplete, even when every real finding of the files reached matches', {skip: process.getuid?.() === 0 ? 'root can read a chmod 000 file' : false}, () => {
    const unreadable = join(project, 'c.ts');
    const readable = producedKeys().filter((key) => key.file !== 'c.ts');
    chmodSync(unreadable, 0o000);
    try {
        const {status, json} = evalJson(manifest('read.json', readable));
        assert.ok(readable.length >= 2, 'real findings from the files reached');
        assert.deepEqual([json.overall.falsePositives, json.overall.falseNegatives], [0, 0]);
        assert.equal(status, 2);
        assert.deepEqual([json.outcome, json.analysis.status], ['incomplete', 'partial']);
    } finally {
        chmodSync(unreadable, 0o644);
    }
});

test('a parse failure (grammar unavailable) is a coverage gap and evaluates as incomplete — pipeline + evaluator in a fresh process (the CLI always loads every grammar, so it cannot be provoked there)', () => {
    const dartProject = join(work, 'dart');
    spawnSync('mkdir', ['-p', dartProject]);
    writeFileSync(join(dartProject, 'main.dart'), 'void main() {}\n');
    const script = join(work, 'parse-failure.mts');
    writeFileSync(
        script,
        [
            `import {analyze} from ${JSON.stringify(join(root, 'src', 'Pipeline.ts'))};`,
            `import {DEFAULT_CONFIG} from ${JSON.stringify(join(root, 'src', 'Config.ts'))};`,
            `import {evaluate, evaluationOutcome} from ${JSON.stringify(join(root, 'src', 'evaluation', 'Evaluator.ts'))};`,
            `const {report} = analyze({rootPath: ${JSON.stringify(dartProject)}, knowledgeDir: ${JSON.stringify(join(root, 'knowledge', 'marcus'))}, ruleSetDir: ${JSON.stringify(join(root, 'rules', 'default'))}, config: DEFAULT_CONFIG});`,
            `const result = evaluate(report.findings, [], ${JSON.stringify(dartProject)});`,
            'console.log(JSON.stringify({status: report.coverage.status, sample: report.coverage.excludedSample, outcome: evaluationOutcome(result, {status: report.coverage.status})}));'
        ].join('\n')
    );
    const run = spawnSync('node', ['--import', 'tsx', script], {cwd: root, encoding: 'utf8'});
    const out = JSON.parse(run.stdout) as {status: string; sample: {reason: string; detail?: string}[]; outcome: string};
    assert.equal(out.status, 'partial');
    assert.ok(out.sample.some((entry) => entry.reason === 'read_error' && (entry.detail ?? '').startsWith('parse failed')));
    assert.equal(out.outcome, 'incomplete', 'no finding is expected and none is produced — still never a pass');
});

test('an incomplete evaluation changes nothing on disk: the manifest stays byte-identical, the project gains no file (no baseline, no cache)', () => {
    const expected = manifest('untouched.json', producedKeys());
    const before = readFileSync(expected);
    const filesBefore = readdirSync(project).sort();
    const {status} = evalJson(expected, {STOA_TEST_FORCE_INCOMPLETE: '1'});
    assert.equal(status, 2);
    assert.deepEqual(readFileSync(expected), before);
    assert.deepEqual(readdirSync(project).sort(), filesBefore);
});

test('exit 1: a technical error (nonexistent rule-set directory) is an evaluation error, not a pass', () => {
    const result = stoa(['eval', project, '--expected', manifest('tech.json', []), '--rules', join(work, 'no-such-rules')]);
    assert.equal(result.status, 1);
    assert.notEqual(result.stderr, '');
});

test('markdown: the analysis status and the outcome are stated; an incomplete run says it is never a pass', () => {
    const result = stoa(['eval', project, '--expected', manifest('md.json', producedKeys())], {STOA_TEST_FORCE_INCOMPLETE: '1'});
    assert.equal(result.status, 2);
    assert.match(result.stdout, /- Analysis: partial/);
    assert.match(result.stdout, /- Outcome: incomplete/);
    assert.match(result.stdout, /never a pass/);
});

test('exit 1: duplicate PRODUCED identities fail a complete evaluation even with 0 FP / 0 FN — listed in JSON, named on stderr and in Markdown, nothing dropped', () => {
    const run = stoa(['analyze', collidingProject, '--format', 'json']);
    const produced = (JSON.parse(run.stdout) as {findings: {rule: {id: string}; location: {file: string; symbol?: string}}[]}).findings.map((finding) => ({
        file: finding.location.file.slice(collidingProject.length + 1),
        rule: finding.rule.id,
        symbol: finding.location.symbol ?? ''
    }));
    const unique = [...new Map(produced.map((key) => [`${key.file}::${key.rule}::${key.symbol}`, key])).values()];
    assert.ok(unique.length < produced.length, 'the project produces an identity collision');
    const path = manifest('collision.json', unique);
    const result = stoa(['eval', collidingProject, '--expected', path, '--format', 'json']);
    const json = JSON.parse(result.stdout) as EvalJson & {duplicates: Key[]; overall: {producedCount: number}};
    assert.equal(result.status, 1);
    assert.deepEqual([json.outcome, json.analysis.status], ['failed', 'complete']);
    assert.deepEqual([json.overall.falsePositives, json.overall.falseNegatives], [0, 0], 'the metrics alone would pass');
    assert.deepEqual(json.duplicates, [{file: 'a.ts', rule: 'R-FN-TOO-MANY-PARAMS', symbol: 'run'}]);
    assert.equal(json.overall.producedCount, produced.length, 'nothing dropped');
    assert.match(result.stderr, /identity collision: 1 produced finding/);
    const markdown = stoa(['eval', collidingProject, '--expected', path]);
    assert.equal(markdown.status, 1);
    assert.match(markdown.stdout, /- Outcome: failed/);
    assert.match(markdown.stdout, /identity collision — fails the evaluation[\s\S]*a\.ts · R-FN-TOO-MANY-PARAMS · run/);
});
