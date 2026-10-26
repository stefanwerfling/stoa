import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixture = join(here, 'fixtures', 'typecheck', 'Unsound.ts');

const typeFindings = (typecheck: boolean): Finding[] =>
    analyze({
        rootPath: fixture,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG,
        typecheck
    }).report.findings.filter((f) => f.rule.id === 'R-TYPE-UNSOUND');

test('R-TYPE-UNSOUND fires only when the type checker is enabled', () => {
    assert.equal(typeFindings(false).length, 0, 'off by default');
    const on = typeFindings(true);
    assert.ok(on.length >= 2, 'the assignment error and the possibly-undefined access');
});

test('type-check findings carry the right principle, dimension and certainty', () => {
    const finding = typeFindings(true)[0];
    assert.ok(finding);
    assert.equal(finding?.interpretation.principles[0]?.id, 'marcus.judgment');
    assert.ok(finding?.interpretation.dimensions.includes('decision-evidence'));
    assert.equal(finding?.certaintyBasis, 'external-tool');
    assert.ok(finding !== undefined && finding.confidence <= 0.9);
    assert.ok(finding?.observation.statement.startsWith('Type checker:'));
});

test('type-check analysis is deterministic', () => {
    assert.equal(JSON.stringify(typeFindings(true)), JSON.stringify(typeFindings(true)));
});
