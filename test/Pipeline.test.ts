import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
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

test('without cacheDir, coverage.cacheHits is absent — the default behavior reads/writes nothing beyond the analysis target', () => {
    const {report} = analyze({rootPath: fixture, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    assert.equal(report.coverage.cacheHits, undefined);
});

test('with cacheDir: the second run on unchanged files is served from the cache and produces IDENTICAL facts/findings to the first', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'stoa-cache-pipeline-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'stoa-cache-store-'));
    try {
        writeFileSync(join(projectDir, 'greeter.ts'), 'export class Greeter {\n  greet(): string { return "hi"; }\n}\n');

        const first = analyze({rootPath: projectDir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});
        assert.equal(first.report.coverage.cacheHits, 0, 'nothing could be cached yet on the very first run');

        const second = analyze({rootPath: projectDir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});
        assert.ok((second.report.coverage.cacheHits ?? 0) > 0, 'the second run actually hits the cache instead of re-parsing');
        assert.equal(JSON.stringify(second.report.findings), JSON.stringify(first.report.findings), 'a cached run is not just fast — it is byte-identical to a fresh one');
        assert.equal(JSON.stringify(second.facts), JSON.stringify(first.facts));
    } finally {
        rmSync(projectDir, {recursive: true, force: true});
        rmSync(cacheDir, {recursive: true, force: true});
    }
});

test('with cacheDir: editing a file after caching is reflected on the next run — the cache never serves stale facts for changed content', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'stoa-cache-pipeline-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'stoa-cache-store-'));
    try {
        const target = join(projectDir, 'thing.ts');
        writeFileSync(target, 'export function a(): number {\n  return 1;\n}\n');
        const first = analyze({rootPath: projectDir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});

        writeFileSync(target, 'export function a(): number {\n  return 1;\n}\nexport function b(): number {\n  return 2;\n}\n');
        const second = analyze({rootPath: projectDir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});

        assert.equal(second.report.coverage.cacheHits, 0, 'changed content is a cache miss, not a stale hit');
        assert.notEqual(JSON.stringify(second.facts), JSON.stringify(first.facts), 'the new function is actually reflected, not masked by a stale cache entry');
        assert.ok(second.facts.some((f) => f.kind === 'deps.export' && JSON.stringify(f.value).includes('b')), 'the newly added export is genuinely present in the re-extracted facts');
    } finally {
        rmSync(projectDir, {recursive: true, force: true});
        rmSync(cacheDir, {recursive: true, force: true});
    }
});
