import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildRealWorldReport, surfaceOf} from '../src/evaluation/RealWorldReport.js';
import type {CoverageSummary, Finding} from '../src/Types.js';

// Unit tests for the pure real-world report builder: deterministic output over
// synthetic findings, so the harness logic is covered without needing a real repo.

const finding = (over: {file: string; rule: string; symbol: string; line: number}): Finding => ({
    id: `${over.rule}:${over.symbol}`,
    rule: {id: over.rule, version: '1.0.0'},
    ruleSet: 'default',
    location: {file: over.file, range: {startLine: over.line, startCol: 0, endLine: over.line, endCol: 1}, symbol: over.symbol},
    observation: {statement: `${over.rule} at ${over.symbol}`, evidence: [{fact: 'ui.x', value: '<x>', certainty: 'syntactic'}]},
    interpretation: {principles: [], dimensions: ['accessibility']},
    severity: 'medium',
    confidence: 0.8,
    certaintyBasis: 'syntactic',
    remediation: {suggestion: 'fix it'},
    source: 'deterministic'
});

const coverage: CoverageSummary = {filesSelected: 10, filesAnalyzed: 9, filesSkipped: 1, factCount: 42};

const baseInput = {
    targetPath: '/repo',
    generatedAt: '2026-10-28T00:00:00.000Z',
    engineVersion: '0.1.0',
    coverage,
    sampleSize: 2,
    elapsedMs: 123
};

test('surfaceOf classifies files by extension, Angular before plain HTML', () => {
    assert.equal(surfaceOf('src/app/foo.component.html'), 'Angular');
    assert.equal(surfaceOf('public/index.html'), 'HTML');
    assert.equal(surfaceOf('ui/Button.tsx'), 'JSX');
    assert.equal(surfaceOf('ui/App.vue'), 'Vue');
    assert.equal(surfaceOf('lib/widget.dart'), 'Flutter/Dart');
    assert.equal(surfaceOf('style.css'), '.css');
    assert.equal(surfaceOf('Makefile'), '(no extension)');
});

test('report is deterministic, filters to a11y, and caps the sample per rule', () => {
    const findings: Finding[] = [
        finding({file: 'b.html', rule: 'R-A11Y-IMG-ALT', symbol: 'img#0', line: 5}),
        finding({file: 'a.html', rule: 'R-A11Y-IMG-ALT', symbol: 'img#0', line: 2}),
        finding({file: 'a.html', rule: 'R-A11Y-IMG-ALT', symbol: 'img#1', line: 9}),
        finding({file: 'a.vue', rule: 'R-A11Y-CONTRAST-TEXT', symbol: 'contrast#0', line: 1}),
        // a non-a11y finding must be excluded from the samples/surface/rule tables
        finding({file: 'a.ts', rule: 'R-COMPLEXITY-COGNITIVE', symbol: 'fn#0', line: 3})
    ];
    const report = buildRealWorldReport({...baseInput, findings});

    assert.ok(report.includes('| Accessibility findings | 4 |'), 'counts only the 4 a11y findings');
    assert.ok(report.includes('| Total findings | 5 |'));
    assert.ok(report.includes('| HTML | 3 |') && report.includes('| Vue | 1 |'), 'surface breakdown');
    assert.ok(!report.includes('R-COMPLEXITY-COGNITIVE'), 'non-a11y rule is excluded');
    assert.ok(report.includes('### R-A11Y-IMG-ALT (3)'), 'per-rule heading shows the full count');
    // sampleSize=2: the first two IMG-ALT findings in deterministic order (a.html:2, a.html:9)
    assert.ok(report.includes('`a.html:2:0` [img#0]'), 'sample is sorted by file then line');
    assert.ok(report.includes('`a.html:9:0` [img#1]'));
    assert.ok(!report.includes('`b.html:5:0`'), 'the third IMG-ALT finding is beyond the sample cap');

    // Determinism: same input → byte-identical output.
    assert.equal(buildRealWorldReport({...baseInput, findings}), report);
});

test('report states counts-not-precision and handles an empty a11y set', () => {
    const report = buildRealWorldReport({...baseInput, findings: []});
    assert.ok(report.includes('counts, not precision'));
    assert.ok(report.includes('_No accessibility findings._'));
});
