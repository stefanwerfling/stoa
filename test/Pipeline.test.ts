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

test('analyze produces a report with versions, coverage and line-count facts', () => {
    const {report, facts} = analyze({rootPath: fixture, knowledgeDir, config: DEFAULT_CONFIG});
    assert.equal(report.versions.engine, '0.1.0');
    assert.equal(report.versions.adapters.typescript, '0.2.0');
    assert.ok(report.coverage.filesAnalyzed >= 2, 'both fixture files analyzed');
    assert.ok(facts.some((fact) => fact.kind === 'file.lineCount'));
});

test('analysis is deterministic (byte-identical findings across two runs)', () => {
    const a = analyze({rootPath: fixture, knowledgeDir, config: DEFAULT_CONFIG});
    const b = analyze({rootPath: fixture, knowledgeDir, config: DEFAULT_CONFIG});
    assert.equal(JSON.stringify(a.report.findings), JSON.stringify(b.report.findings));
    assert.equal(JSON.stringify(a.facts), JSON.stringify(b.facts));
});

test('knowledge base loads the six MVP principles', () => {
    const kb = KnowledgeBase.loadFromDirectory(knowledgeDir, 'marcus@1');
    assert.equal(kb.size(), 6);
    assert.ok(kb.get('marcus.control'), 'marcus.control present');
    assert.ok(kb.get('marcus.simplicity'), 'marcus.simplicity present');
});
