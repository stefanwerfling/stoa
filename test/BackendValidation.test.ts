import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

// Trust-boundary rule R-VALIDATION-MISSING-BACKEND, exercised through the real
// analysis path. The TypeScript adapter is synchronous (ts-morph), so no grammar
// init is needed here.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixtures = join(here, 'fixtures', 'backend-validation');

const analyzeFixture = (file: string): Finding[] => {
    return analyze({rootPath: join(fixtures, file), knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};
const byRule = (findings: Finding[], ruleId: string): Finding[] => findings.filter((f) => f.rule.id === ruleId);
const rule = (findings: Finding[]): Finding[] => byRule(findings, 'R-VALIDATION-MISSING-BACKEND');
const massAssignment = (findings: Finding[]): Finding[] => byRule(findings, 'R-VALIDATION-MASS-ASSIGNMENT');

test('flags handlers that read req.body / req.query without recognized validation', () => {
    const findings = rule(analyzeFixture('unvalidated.ts'));
    assert.deepEqual(
        findings.map((f) => `${f.location.range.startLine}:${f.observation.evidence[0]?.value}`).sort(),
        ['14:req.query', '7:req.body'],
        'the body-persisting POST and the query-using GET are both flagged with their input source'
    );
    const first = findings[0];
    assert.equal(first?.rule.id, 'R-VALIDATION-MISSING-BACKEND');
    assert.equal(first?.interpretation.principles[0]?.id, 'marcus.judgment');
    assert.ok(first?.interpretation.dimensions.includes('robustness'));
    assert.equal(first?.certaintyBasis, 'semantic-heuristic', 'reported as a heuristic risk, not a syntactic certainty');
});

test('does not flag handlers that validate via Zod, vts, a manual 400 guard, a route schema, or read only params', () => {
    const findings = rule(analyzeFixture('validated.ts'));
    assert.deepEqual(findings, [], 'all recognized validation styles suppress the finding; params are out of scope');
});

test('mass assignment: flags Object.assign, a direct persistence call and a spread persistence call fed the raw request payload', () => {
    const findings = massAssignment(analyzeFixture('mass-assignment.ts'));
    assert.deepEqual(
        findings.map((f) => `${f.location.range.startLine}:${f.observation.evidence[0]?.value}`),
        ['9:Object.assign(…, req.body)', '15:save(req.body)', '21:update({...(req.body as Record<string, unknown>)})']
    );
    const first = findings[0];
    assert.equal(first?.interpretation.principles[0]?.id, 'marcus.judgment');
    assert.ok(first?.interpretation.dimensions.includes('robustness'));
    assert.equal(first?.severity, 'high');
    assert.equal(first?.certaintyBasis, 'semantic-heuristic');
});

test('mass assignment: still flags a raw alias reaching save() even when the handler itself rejects malformed input, but not an allow-listed object', () => {
    // /vts2 and /manual both satisfy R-VALIDATION-MISSING-BACKEND (they reject bad
    // input), but neither narrows the saved value's shape — the two concerns are
    // independent, and the raw object still carries any unchecked extra property.
    // /zod, /vts and /schema narrow via a validator/route schema; /allowlist reads
    // only body.name into a fresh literal (a single-field pluck, no alias, no spread).
    const findings = massAssignment(analyzeFixture('validated.ts'));
    assert.deepEqual(
        findings.map((f) => `${f.location.range.startLine}:${f.observation.evidence[0]?.value}`),
        ['39:save(body)', '46:save(body)']
    );
});
