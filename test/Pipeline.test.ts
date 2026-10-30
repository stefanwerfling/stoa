import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {analyze} from '../src/Pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixture = join(here, 'fixtures', 'sample');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

test('analyze produces a report with versions, coverage and line-count facts', () => {
    const {report, facts} = analyze({rootPath: fixture, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    assert.equal(report.versions.engine, '0.1.0');
    assert.equal(report.versions.adapters.typescript, '0.2.0');
    assert.ok(report.coverage.filesAnalyzed >= 2, 'both fixture files analyzed');
    assert.ok(facts.some((fact) => fact.kind === 'file.lineCount'));
});

test('analysis is deterministic (byte-identical findings across two runs)', () => {
    const a = analyze({rootPath: fixture, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    const b = analyze({rootPath: fixture, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    assert.equal(JSON.stringify(a.report.findings), JSON.stringify(b.report.findings));
    assert.equal(JSON.stringify(a.facts), JSON.stringify(b.facts));
});

test('knowledge base loads the six MVP principles', () => {
    const kb = KnowledgeBase.loadFromDirectory(knowledgeDir, 'marcus@1');
    assert.equal(kb.size(), 6);
    assert.ok(kb.get('marcus.control'), 'marcus.control present');
    assert.ok(kb.get('marcus.simplicity'), 'marcus.simplicity present');
});

test('a normal run never marks coverage as incomplete (the memory guard only acts under real pressure)', () => {
    const {report} = analyze({rootPath: fixture, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    assert.equal(report.coverage.analysisIncomplete, undefined);
    assert.equal(report.coverage.stoppedAtFile, undefined);
});

test('the memory guard stops ingestion rather than crash, and marks the report as genuinely incomplete (not a silently full result)', () => {
    const progress: Array<{filesProcessed: number}> = [];
    const {report, facts} = analyze({
        rootPath: fixture,
        knowledgeDir,
        ruleSetDir,
        config: DEFAULT_CONFIG,
        memoryGuard: {checkEveryFiles: 1, criticalRatio: 0}, // 0 => always "critical", a deterministic trigger without real memory pressure
        onProgress: (_snapshot, p) => progress.push(p)
    });
    assert.equal(report.coverage.analysisIncomplete, true);
    assert.ok(typeof report.coverage.stoppedAtFile === 'string' && report.coverage.stoppedAtFile.length > 0);
    assert.equal(report.coverage.filesAnalyzed, 0, 'stopped before the first file was processed, at the first check');
    assert.deepEqual(facts, [], 'nothing was produced yet, so nothing was lost either — the report says so rather than claiming a complete scan');
    assert.ok(progress.length > 0, 'onProgress is actually invoked, not just accepted and ignored');
});
