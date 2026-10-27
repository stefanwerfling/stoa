import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {evaluate} from '../src/evaluation/Evaluator.js';
import {loadExpected} from '../src/evaluation/Corpus.js';
import type {ExpectedFinding} from '../src/evaluation/EvaluationTypes.js';
import type {Certainty, Finding, QualityDimension, Severity} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const evalFixture = join(here, 'fixtures', 'eval');
const ROOT = '/repo';

// A fully-typed minimal finding; only file/rule/symbol drive the evaluator, the
// rest are inert defaults so no `any` or cast is needed.
const makeFinding = (relativeFile: string, rule: string, symbol: string): Finding => {
    const certainty: Certainty = 'syntactic';
    const severity: Severity = 'medium';
    const dimension: QualityDimension = 'robustness';
    return {
        id: `${relativeFile}:${rule}:${symbol}`,
        rule: {id: rule, version: '1.0.0'},
        ruleSet: 'default',
        location: {file: `${ROOT}/${relativeFile}`, range: {startLine: 1, startCol: 0, endLine: 1, endCol: 0}, symbol},
        observation: {statement: 'x', evidence: [{fact: 'f', value: true, certainty}]},
        interpretation: {principles: [], dimensions: [dimension]},
        severity,
        confidence: 0.5,
        certaintyBasis: certainty,
        remediation: {suggestion: 's'},
        source: 'deterministic'
    };
};

const expected = (relativeFile: string, rule: string, symbol: string): ExpectedFinding => ({file: relativeFile, rule, symbol});

test('1.4.1 a missing expected finding yields a false negative (recall < 1)', () => {
    const result = evaluate([makeFinding('a.ts', 'R-X', 's1')], [expected('a.ts', 'R-X', 's1'), expected('a.ts', 'R-X', 's2')], ROOT);
    assert.equal(result.overall.falseNegatives, 1);
    assert.equal(result.overall.falsePositives, 0);
    assert.ok(result.overall.recall < 1);
    assert.deepEqual(result.falseNegatives, [{file: 'a.ts', rule: 'R-X', symbol: 's2'}]);
});

test('1.4.2 an unexpected finding is a false positive', () => {
    const result = evaluate([makeFinding('a.ts', 'R-X', 's1')], [], ROOT);
    assert.equal(result.overall.falsePositives, 1);
    assert.equal(result.overall.falseNegatives, 0);
    assert.ok(result.overall.precision < 1);
    assert.deepEqual(result.falsePositives, [{file: 'a.ts', rule: 'R-X', symbol: 's1'}]);
});

test('1.4.3 same-named files in different directories do not collide', () => {
    const findings = [makeFinding('src/User.ts', 'R-X', 'ctor'), makeFinding('tests/fixtures/User.ts', 'R-X', 'ctor')];
    const manifest = [expected('src/User.ts', 'R-X', 'ctor'), expected('tests/fixtures/User.ts', 'R-X', 'ctor')];
    const result = evaluate(findings, manifest, ROOT);
    assert.equal(result.overall.truePositives, 2);
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);

    // The two paths are genuinely distinct: expecting only one leaves the other as FP and the expected one as FN.
    const partial = evaluate(findings, [expected('src/User.ts', 'R-X', 'ctor')], ROOT);
    assert.equal(partial.overall.falsePositives, 1);
    assert.deepEqual(partial.falsePositives, [{file: 'tests/fixtures/User.ts', rule: 'R-X', symbol: 'ctor'}]);
});

test('1.4.4 duplicate produced findings do not inflate metrics and are reported', () => {
    const findings = [makeFinding('a.ts', 'R-X', 's1'), makeFinding('a.ts', 'R-X', 's1')];
    const result = evaluate(findings, [expected('a.ts', 'R-X', 's1')], ROOT);
    assert.equal(result.overall.truePositives, 1, 'the duplicate is not counted twice');
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);
    assert.equal(result.overall.precision, 1);
    assert.equal(result.overall.recall, 1);
    assert.equal(result.overall.producedCount, 2, 'raw count still reflects both findings');
    assert.deepEqual(result.duplicates, [{file: 'a.ts', rule: 'R-X', symbol: 's1'}]);
});

test('1.4.5 a fully matching corpus is perfect', () => {
    const findings = [makeFinding('a.ts', 'R-X', 's1'), makeFinding('b.ts', 'R-Y', 's2')];
    const result = evaluate(findings, [expected('a.ts', 'R-X', 's1'), expected('b.ts', 'R-Y', 's2')], ROOT);
    assert.equal(result.overall.precision, 1);
    assert.equal(result.overall.recall, 1);
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);
    assert.equal(result.duplicates.length, 0);
});

test('2.3 a duplicate expected identity is reported, not silently collapsed', () => {
    const result = evaluate([makeFinding('a.ts', 'R-X', 's1')], [expected('a.ts', 'R-X', 's1'), expected('a.ts', 'R-X', 's1')], ROOT);
    assert.deepEqual(result.duplicateExpected, [{file: 'a.ts', rule: 'R-X', symbol: 's1'}]);
    // The duplicate collapses for matching (one TP), but is surfaced as an error.
    assert.equal(result.overall.truePositives, 1);
    assert.equal(result.overall.falseNegatives, 0);
});

test('2.4 a malformed manifest throws an explicit error', () => {
    assert.throws(() => loadExpected(join(evalFixture, 'expected-malformed.json')), /finding #0 has an empty or non-string "rule"/);
});

test('2.5 precision/recall on empty sets are the documented vacuous 1.0', () => {
    const empty = evaluate([], [], ROOT);
    assert.equal(empty.overall.precision, 1);
    assert.equal(empty.overall.recall, 1);
    assert.equal(empty.overall.producedCount, 0);
    assert.equal(empty.overall.truePositives, 0);
});

test('2.6 zero produced against non-empty expected is recall 0 (not a misleading pass)', () => {
    const result = evaluate([], [expected('a.ts', 'R-X', 's1')], ROOT);
    assert.equal(result.overall.recall, 0);
    assert.equal(result.overall.falseNegatives, 1);
    assert.equal(result.overall.producedCount, 0);
    // Precision is vacuously 1 (no predictions) — only meaningful with producedCount 0.
    assert.equal(result.overall.precision, 1);
});

// 1.4.6 — the CLI exit code must follow the evaluation result, end to end.
const runEvalCli = (expectedFile: string): number => {
    try {
        execFileSync('node', ['--import', 'tsx', 'src/Cli.ts', 'eval', join(evalFixture, 'project'), '--expected', join(evalFixture, expectedFile)], {cwd: root, stdio: 'ignore'});
        return 0;
    } catch (error) {
        return typeof (error as {status?: number}).status === 'number' ? (error as {status: number}).status : 1;
    }
};

test('1.4.6 CLI eval exits 0 on a match, non-zero on a false negative or false positive', () => {
    assert.equal(runEvalCli('expected-ok.json'), 0, 'exact match passes');
    assert.notEqual(runEvalCli('expected-missing.json'), 0, 'a missing expected finding (false negative, no false positive) must fail');
    assert.notEqual(runEvalCli('expected-empty.json'), 0, 'a spurious finding (false positive) must fail');
});

test('2.8 CLI eval fails on a duplicate expected identity and on a malformed manifest', () => {
    assert.notEqual(runEvalCli('expected-dup.json'), 0, 'a duplicate expected identity must fail the evaluation');
    assert.notEqual(runEvalCli('expected-malformed.json'), 0, 'a malformed manifest must fail the evaluation');
});
