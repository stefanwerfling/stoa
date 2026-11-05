import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadLabels, sampleFindings, summarizeValidation, type ExternalManifest, type FindingLabel, type LabelFile} from '../src/evaluation/ExternalValidation.js';
import {IDENTITY_SCHEME, keyString} from '../src/FindingIdentity.js';
import type {Finding} from '../src/Types.js';

// Phase 5 of the quality-hardening spec: the external validation counts only
// what a reviewer classified — precision over TP/FP, `unclear` apart, recall
// only inside the files read in full — and refuses label files that would
// make those numbers mean something else.

const here = dirname(fileURLToPath(import.meta.url));
const corpus = join(here, '..', 'validation', 'external');
const work = mkdtempSync(join(tmpdir(), 'stoa-external-'));
after(() => rmSync(work, {recursive: true, force: true}));

const ROOT = '/root';

const finding = (file: string, symbol: string, rule = 'R-ERR-SWALLOWED'): Finding => ({
    id: `finding:${rule}:${ROOT}/${file}:1:0`,
    rule: {id: rule, version: '1.0.0'},
    ruleSet: 'default@1',
    location: {file: `${ROOT}/${file}`, range: {startLine: 1, startCol: 0, endLine: 1, endCol: 0}, symbol},
    observation: {statement: 'x', evidence: []},
    interpretation: {principles: [], dimensions: []},
    severity: 'low',
    confidence: 0.5,
    certaintyBasis: 'syntactic',
    remediation: {suggestion: 'x'},
    source: 'deterministic'
});

const label = (file: string, symbol: string, verdict: FindingLabel['verdict'], rule = 'R-ERR-SWALLOWED'): FindingLabel => ({file, rule, symbol, verdict, reason: 'checked'});

const labelFile = (labels: FindingLabel[], fnScope: LabelFile['fnScope'] = {files: [], rules: []}, falseNegatives: LabelFile['falseNegatives'] = []): LabelFile => ({
    identity: IDENTITY_SCHEME,
    reviewer: 'test',
    reviewedAt: '2026-11-05',
    sampling: 'test',
    labels,
    fnScope,
    falseNegatives
});

test('precision counts only TP and FP; unclear and unreviewed findings are counted apart and never extrapolated', () => {
    const findings = [finding('a.ts', 'f>catch#0'), finding('a.ts', 'g>catch#0'), finding('b.ts', 'h>catch#0'), finding('c.ts', 'i>catch#0'), finding('d.ts', 'j>catch#0')];
    const summary = summarizeValidation(findings, labelFile([label('a.ts', 'f>catch#0', 'TP'), label('a.ts', 'g>catch#0', 'FP'), label('b.ts', 'h>catch#0', 'unclear')]), ROOT);
    assert.deepEqual(summary.total, {key: '', produced: 5, reviewed: 3, truePositives: 1, falsePositives: 1, unclear: 1, falseNegatives: 0, precision: 0.5, recall: null});
});

test('a rule nobody classified gets no precision, not 0 % or 100 %', () => {
    const summary = summarizeValidation([finding('a.ts', 'f>catch#0'), finding('a.ts', 'f', 'R-DEEP-NESTING')], labelFile([label('a.ts', 'f>catch#0', 'TP')]), ROOT);
    const nesting = summary.byRule.find((row) => row.key === 'R-DEEP-NESTING');
    assert.equal(nesting?.reviewed, 0);
    assert.equal(nesting?.precision, null);
    assert.equal(nesting?.recall, null);
});

test('recall is computed only inside fnScope: TPs outside it do not count, misses inside it do', () => {
    const findings = [finding('scope.ts', 'f>catch#0'), finding('other.ts', 'g>catch#0')];
    const labels = labelFile([label('scope.ts', 'f>catch#0', 'TP'), label('other.ts', 'g>catch#0', 'TP')], {files: ['scope.ts'], rules: ['*']}, [
        {file: 'scope.ts', rule: 'R-ERR-SWALLOWED', line: 9, reason: 'missed empty catch'}
    ]);
    const summary = summarizeValidation(findings, labels, ROOT);
    assert.equal(summary.total.truePositives, 2);
    assert.equal(summary.total.falseNegatives, 1);
    assert.equal(summary.total.recall, 0.5);
    assert.equal(summary.byLanguage.find((row) => row.key === 'TypeScript/JavaScript')?.recall, 0.5);
});

test('fnScope.rules narrows the scope to the listed rules', () => {
    const findings = [finding('scope.ts', 'f>catch#0'), finding('scope.ts', 'f', 'R-DEEP-NESTING')];
    // R-DEEP-NESTING is outside the rule scope, so its finding may stay unlabeled.
    const summary = summarizeValidation(findings, labelFile([label('scope.ts', 'f>catch#0', 'TP')], {files: ['scope.ts'], rules: ['R-ERR-SWALLOWED']}), ROOT);
    assert.equal(summary.total.recall, 1);
});

test('an unlabeled finding inside fnScope or a miss outside it is an error, not a silent gap', () => {
    const findings = [finding('scope.ts', 'f>catch#0'), finding('scope.ts', 'g>catch#0')];
    assert.throws(
        () => summarizeValidation(findings, labelFile([label('scope.ts', 'f>catch#0', 'TP')], {files: ['scope.ts'], rules: ['*']}), ROOT),
        /every finding in fnScope must be labeled; missing: scope\.ts::R-ERR-SWALLOWED::g>catch#0/
    );
    assert.throws(
        () => summarizeValidation([], labelFile([], {files: ['scope.ts'], rules: ['*']}, [{file: 'elsewhere.ts', rule: 'R-ERR-SWALLOWED', line: 1, reason: 'x'}]), ROOT),
        /lies outside fnScope/
    );
});

test('labels the run no longer produces are stale: listed, counted nowhere else', () => {
    const summary = summarizeValidation([finding('a.ts', 'f>catch#0')], labelFile([label('a.ts', 'f>catch#0', 'TP'), label('a.ts', 'gone>catch#0', 'FP')]), ROOT);
    assert.deepEqual(summary.stale.map(keyString), [keyString({file: 'a.ts', rule: 'R-ERR-SWALLOWED', symbol: 'gone>catch#0'})]);
    assert.equal(summary.total.reviewed, 1);
    assert.equal(summary.total.falsePositives, 0);
});

test('the review sample is deterministic: at most N per rule, independent of the finding order', () => {
    const findings = Array.from({length: 12}, (_, index) => finding(`f${index}.ts`, `s${index}>catch#0`)).concat([finding('n.ts', 'deep', 'R-DEEP-NESTING')]);
    const forward = sampleFindings(findings, ROOT, 5).map(keyString);
    const backward = sampleFindings([...findings].reverse(), ROOT, 5).map(keyString);
    assert.deepEqual(forward, backward);
    assert.equal(forward.filter((key) => key.includes('R-ERR-SWALLOWED')).length, 5);
    assert.equal(forward.filter((key) => key.includes('R-DEEP-NESTING')).length, 1);
});

test('loadLabels rejects another identity scheme, a label given twice and an unknown verdict', () => {
    const write = (name: string, content: unknown): string => {
        const path = join(work, name);
        writeFileSync(path, JSON.stringify(content), 'utf8');
        return path;
    };
    const valid = labelFile([label('a.ts', 'f>catch#0', 'TP')]);
    assert.deepEqual(loadLabels(write('valid.json', valid)), valid);
    assert.throws(() => loadLabels(write('scheme.json', {...valid, identity: IDENTITY_SCHEME - 1})), /"identity" must be/);
    assert.throws(() => loadLabels(write('twice.json', {...valid, labels: [label('a.ts', 'f>catch#0', 'TP'), label('a.ts', 'f>catch#0', 'FP')]})), /labeled twice/);
    assert.throws(() => loadLabels(write('verdict.json', {...valid, labels: [{...label('a.ts', 'f>catch#0', 'TP'), verdict: 'maybe'}]})), /"verdict" must be TP, FP or unclear/);
});

test('every project of the external corpus pins a full commit and has a loadable label file marked as a model review', () => {
    const projects = readdirSync(corpus, {withFileTypes: true}).filter((entry) => entry.isDirectory());
    assert.ok(projects.length >= 3, 'the spec asks for 3–5 projects');
    for (const project of projects) {
        const manifest = JSON.parse(readFileSync(join(corpus, project.name, 'manifest.json'), 'utf8')) as ExternalManifest;
        assert.equal(manifest.name, project.name);
        assert.match(manifest.commit, /^[0-9a-f]{40}$/, `${project.name}: commit must be a full SHA`);
        assert.ok(manifest.license !== '' && manifest.licenseFile !== '', `${project.name}: licence must be recorded`);
        const labels = loadLabels(join(corpus, project.name, 'labels.json'));
        assert.match(labels.reviewer, /model review/, `${project.name}: a model review must say so`);
        assert.ok(labels.fnScope.files.length > 0, `${project.name}: recall needs files read in full`);
    }
});
