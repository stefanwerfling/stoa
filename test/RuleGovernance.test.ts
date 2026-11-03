import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {applyFindingFilter, parseFindingFilter} from '../src/FindingFilter.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {analyze} from '../src/Pipeline.js';
import {toMarkdown} from '../src/reporting/Reporter.js';
import {toSarif} from '../src/reporting/SarifReporter.js';
import type {ProjectRule, ProjectRuleInput} from '../src/rules/ProjectRule.js';
import {RuleEngine} from '../src/rules/RuleEngine.js';
import {RuleSet} from '../src/rules/RuleSet.js';
import type {AnalysisReport, Certainty, Finding, RuleMaturity} from '../src/Types.js';

// Flutter quality track E1: rule maturity (E1a), the central confidence cap
// for project rules (E1b) and the output filters (E1c).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const sample = join(here, 'fixtures', 'sample');

const findingOf = (id: string, certaintyBasis: Certainty, confidence: number): Finding => ({
    id,
    rule: {id: 'R-TEST', version: '1.0.0'},
    ruleSet: 'default',
    location: {file: '/x.ts', range: {startLine: 1, startCol: 0, endLine: 1, endCol: 1}},
    observation: {statement: 's', evidence: []},
    interpretation: {principles: [], dimensions: ['robustness']},
    severity: 'low',
    confidence,
    certaintyBasis,
    remediation: {suggestion: 's'},
    source: 'deterministic'
});

const ruleOf = (findings: Finding[], maturity?: RuleMaturity): ProjectRule => ({
    id: 'R-TEST',
    version: '1.0.0',
    ...(maturity !== undefined ? {maturity} : {}),
    evaluate: (_input: ProjectRuleInput) => findings.map((finding) => ({...finding}))
});

// No declarative rules: only the project rules under test produce findings.
const emptyRuleSetDir = mkdtempSync(join(tmpdir(), 'stoa-empty-ruleset-'));
after(() => rmSync(emptyRuleSetDir, {recursive: true, force: true}));

const engineWith = (rules: ProjectRule[]): RuleEngine =>
    new RuleEngine(KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase), RuleSet.loadFromDirectory(emptyRuleSetDir, 'empty'), 'en', rules);

test('E1b: a project rule\'s confidence is capped by its certainty basis, like declarative rules', () => {
    const findings = engineWith([
        ruleOf([findingOf('a', 'semantic-heuristic', 0.9), findingOf('b', 'external-tool', 0.95), findingOf('c', 'syntactic', 0.95), findingOf('d', 'semantic-heuristic', 0.3)])
    ]).evaluate([]);
    assert.deepEqual(
        findings.map((finding) => `${finding.id} ${finding.confidence}`),
        ['a 0.6', 'b 0.9', 'c 0.95', 'd 0.3']
    );
});

test('E1a: an experimental project rule marks every finding; a stable one does not; stable wins when merged', () => {
    const experimental = engineWith([ruleOf([findingOf('a', 'syntactic', 0.8)], 'experimental')]).evaluate([]);
    assert.equal(experimental[0]?.ruleMaturity, 'experimental');
    const stable = engineWith([ruleOf([findingOf('a', 'syntactic', 0.8)])]).evaluate([]);
    assert.equal(stable[0]?.ruleMaturity, undefined);
    const merged = engineWith([ruleOf([findingOf('a', 'syntactic', 0.8)], 'experimental'), ruleOf([findingOf('a', 'syntactic', 0.8)])]).evaluate([]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.ruleMaturity, undefined);
});

test('E1a: a declarative rule with "maturity": "experimental" marks its findings; the schema accepts only stable/experimental', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-maturity-'));
    try {
        cpSync(ruleSetDir, dir, {recursive: true});
        const file = join(dir, 'R-ERR-SWALLOWED.json');
        const rule = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        writeFileSync(file, JSON.stringify({...rule, maturity: 'experimental'}));
        const findings = analyze({rootPath: sample, knowledgeDir, ruleSetDir: dir, config: DEFAULT_CONFIG}).report.findings;
        assert.deepEqual(findings.map((finding) => `${finding.rule.id} ${finding.ruleMaturity ?? 'stable'}`), ['R-ERR-SWALLOWED experimental']);

        const ajv = new Ajv2020({allErrors: true, strict: false});
        for (const name of ['fact.schema.json', 'principle.schema.json', 'finding.schema.json']) {
            ajv.addSchema(JSON.parse(readFileSync(join(root, 'schemas', name), 'utf8')) as object);
        }
        const validate = ajv.compile(JSON.parse(readFileSync(join(root, 'schemas', 'rule.schema.json'), 'utf8')) as object);
        assert.equal(validate({...rule, maturity: 'experimental'}), true);
        assert.equal(validate({...rule, maturity: 'stable'}), true);
        assert.equal(validate({...rule, maturity: 'beta'}), false);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('E1a: without any experimental rule the default output carries no maturity marker', () => {
    const report = analyze({rootPath: sample, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report;
    assert.equal(report.findings.some((finding) => finding.ruleMaturity !== undefined), false);
    assert.equal(report.filter, undefined);
});

const reportOf = (findings: Finding[]): AnalysisReport => ({
    versions: {engine: 'e', ruleSet: 'r', knowledgeBase: 'k', adapters: {}},
    coverage: {status: 'complete', filesSelected: 1, filesAnalyzed: 1, filesSkipped: 0, filesCancelled: 0, excludedByReason: {}, excludedSample: [], factCount: 1},
    findings
});

test('E1c: filters keep matching findings and record the criteria and the hidden count', () => {
    const experimental: Finding = {...findingOf('e', 'syntactic', 0.9), ruleMaturity: 'experimental'};
    const report = reportOf([findingOf('a', 'syntactic', 0.9), findingOf('b', 'semantic-heuristic', 0.6), findingOf('c', 'syntactic', 0.4), experimental]);
    const unchanged = applyFindingFilter(report, {});
    assert.equal(unchanged, report, 'an empty filter returns the report untouched (no filter summary)');
    const filtered = applyFindingFilter(report, {minConfidence: 0.5, certainty: ['syntactic'], excludeExperimental: true});
    assert.deepEqual(filtered.findings.map((finding) => finding.id), ['a']);
    assert.deepEqual(filtered.filter, {minConfidence: 0.5, certainty: ['syntactic'], excludeExperimental: true, hiddenCount: 3});
    assert.match(toMarkdown(filtered, {lang: 'de'}), /- Filter: min\. Konfidenz 0\.50, Sicherheit syntactic, ohne experimentelle Regeln — 3 Befunde ausgeblendet/);
    assert.match(toMarkdown(applyFindingFilter(report, {certainty: ['syntactic']})), /### R-TEST – \/x\.ts:1 \[experimental\]/);
    const sarif = JSON.parse(toSarif(filtered)) as {runs: {invocations: {properties: {filter?: unknown}}[]}[]};
    assert.deepEqual(sarif.runs[0]?.invocations[0]?.properties.filter, filtered.filter);
});

test('E1c: option parsing rejects invalid values', () => {
    assert.deepEqual(parseFindingFilter({minConfidence: '0.7', certainty: ['syntactic,external-tool'], noExperimental: true}), {minConfidence: 0.7, certainty: ['syntactic', 'external-tool'], excludeExperimental: true});
    assert.ok('error' in parseFindingFilter({minConfidence: '1.5'}));
    assert.ok('error' in parseFindingFilter({minConfidence: 'abc'}));
    assert.ok('error' in parseFindingFilter({minConfidence: ''}));
    assert.ok('error' in parseFindingFilter({certainty: ['heuristic']}));
    assert.deepEqual(parseFindingFilter({noExperimental: false}), {});
});

const runCli = (args: string[]): {status: number; stdout: string; stderr: string} => {
    const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', sample, ...args], {cwd: root, encoding: 'utf8'});
    return {status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr};
};

test('E1c CLI: --min-confidence / --certainty hide findings visibly; invalid values are usage errors', () => {
    const shown = runCli(['--format', 'json', '--min-confidence', '0.5']);
    assert.equal(shown.status, 0);
    const shownReport = JSON.parse(shown.stdout) as AnalysisReport;
    assert.equal(shownReport.findings.length, 1);
    assert.deepEqual(shownReport.filter, {minConfidence: 0.5, hiddenCount: 0});

    const hidden = JSON.parse(runCli(['--format', 'json', '--certainty', 'semantic-heuristic']).stdout) as AnalysisReport;
    assert.equal(hidden.findings.length, 0);
    assert.deepEqual(hidden.filter, {certainty: ['semantic-heuristic'], hiddenCount: 1});

    const invalid = runCli(['--min-confidence', '2']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /--min-confidence expects a number between 0 and 1/);
    assert.match(runCli(['--certainty', 'maybe']).stderr, /--certainty expects one or more of/);
});

test('E1c CLI: a baseline written in the same run still holds the findings the filter hides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-filter-baseline-'));
    try {
        const baseline = join(dir, 'baseline.json');
        const run = runCli(['--format', 'json', '--baseline', baseline, '--update-baseline', '--min-confidence', '0.95']);
        const report = JSON.parse(run.stdout) as AnalysisReport;
        assert.equal(report.findings.length, 0);
        assert.equal(report.filter?.hiddenCount, 1);
        const saved = JSON.parse(readFileSync(baseline, 'utf8')) as {findings: unknown[]};
        assert.equal(saved.findings.length, 1);
        // The next run with the same baseline and no filter: the finding is known, nothing "fixed".
        const next = JSON.parse(runCli(['--format', 'json', '--baseline', baseline]).stdout) as AnalysisReport;
        assert.equal(next.baseline?.knownCount, 1);
        assert.equal(next.baseline?.fixedCount, 0);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
