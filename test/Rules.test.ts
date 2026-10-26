import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixtures = join(here, 'fixtures', 'rules');

const analyzePath = (path: string): Finding[] => {
    return analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};

const bySymbol = (findings: Finding[], symbol: string): Finding[] => {
    return findings.filter((finding) => finding.location.symbol === symbol);
};

test('R-ERR-SWALLOWED fires on empty and swallowing catches, not on rethrow', () => {
    const findings = analyzePath(join(root, 'test', 'fixtures', 'metrics', 'Catch.ts'))
        .filter((finding) => finding.rule.id === 'R-ERR-SWALLOWED');
    assert.equal(findings.length, 2, 'two swallowed catches (empty + return null), not the rethrow');
    assert.ok(findings.every((finding) => finding.severity === 'high'));
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.obstacle');
});

test('R-COMPLEXITY-COGNITIVE fires on a tangled function', () => {
    const findings = analyzePath(join(fixtures, 'Complex.ts'));
    const cognitive = bySymbol(findings, 'tangled').filter((f) => f.rule.id === 'R-COMPLEXITY-COGNITIVE');
    assert.equal(cognitive.length, 1);
    assert.equal(cognitive[0]?.interpretation.principles[0]?.id, 'marcus.simplicity');
    assert.ok(cognitive[0] !== undefined && cognitive[0].confidence > 0 && cognitive[0].confidence <= 1);
});

test('context beats threshold: the stoa:allow-complexity marker suppresses findings (AC-8)', () => {
    const findings = analyzePath(join(fixtures, 'Complex.ts'));
    assert.equal(bySymbol(findings, 'tangledAllowed').length, 0, 'suppressed function yields no findings');
    assert.ok(bySymbol(findings, 'tangled').length > 0, 'the unsuppressed twin still reports');
});

test('R-FN-TOO-MANY-PARAMS escalates severity with parameter count', () => {
    const findings = analyzePath(join(fixtures, 'Params.ts')).filter((f) => f.rule.id === 'R-FN-TOO-MANY-PARAMS');
    assert.equal(bySymbol(findings, 'five')[0]?.severity, 'low');
    assert.equal(bySymbol(findings, 'eight')[0]?.severity, 'medium');
});

test('R-SIDEEFFECT-NONDETERMINISM flags direct clock/RNG use (marcus.control)', () => {
    const findings = analyzePath(join(root, 'test', 'corpus', 'project', 'Clock.ts')).filter(
        (f) => f.rule.id === 'R-SIDEEFFECT-NONDETERMINISM'
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.control');
    assert.ok(findings[0]?.interpretation.dimensions.includes('side-effect-control'));
});

test('R-DEP-UNUSED flags an unused import but not a used one', () => {
    const unused = analyzePath(join(root, 'test', 'corpus', 'project', 'UnusedImport.ts')).filter(
        (f) => f.rule.id === 'R-DEP-UNUSED'
    );
    assert.equal(unused.length, 1);
    assert.equal(unused[0]?.observation.statement, 'Unused import: node:fs.');

    const usedImport = analyzePath(join(root, 'test', 'corpus', 'project', 'CycleA.ts')).filter(
        (f) => f.rule.id === 'R-DEP-UNUSED'
    );
    assert.equal(usedImport.length, 0);
});

test('R-DEEP-IMPORT flags an import that reaches into internals', () => {
    const findings = analyzePath(join(root, 'test', 'corpus', 'project', 'DeepImport.ts')).filter(
        (f) => f.rule.id === 'R-DEEP-IMPORT'
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.cooperation');
    assert.ok(findings[0]?.observation.statement.includes('../internal/secret.js'));
});

test('findings carry observation evidence and are deterministic', () => {
    const a = analyzePath(join(fixtures, 'Complex.ts'));
    const b = analyzePath(join(fixtures, 'Complex.ts'));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.ok(a[0] !== undefined && a[0].observation.evidence.length >= 1);
    assert.ok(a[0] !== undefined && a[0].source === 'deterministic');
});
