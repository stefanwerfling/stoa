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
const rule = (findings: Finding[]): Finding[] => findings.filter((f) => f.rule.id === 'R-VALIDATION-MISSING-BACKEND');

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
