import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';

// "Analysis Completion Integrity" (Phase 2 of the "Analysis Completion
// Integrity & Memory-Bounded Evaluation" spec): coverage.status is the single,
// centrally-managed verdict, structured exclusion reasons replace freeform
// strings, and an intentional exclusion must never, by itself, make a run
// `partial` — only a genuine coverage gap (a file Stoa actually intended to
// analyze but could not reach) does.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

test('a normal, fully-reached run is status "complete", with analysisIncomplete absent and every count zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-status-'));
    try {
        writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
        const {report} = analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
        assert.equal(report.coverage.status, 'complete');
        assert.equal(report.coverage.analysisIncomplete, undefined);
        assert.equal(report.coverage.filesCancelled, 0);
        assert.deepEqual(report.coverage.excludedByReason, {});
        assert.deepEqual(report.coverage.excludedSample, []);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('structural exclusions (config-excluded, oversized, unsupported language) are counted but never force "partial" — only a real coverage gap does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-status-structural-'));
    try {
        writeFileSync(join(dir, 'keep.ts'), 'export const x = 1;\n');
        writeFileSync(join(dir, 'config-excluded.ts'), 'export const y = 1;\n');
        writeFileSync(join(dir, 'huge.ts'), `export const z = '${'a'.repeat(200)}';\n`);
        writeFileSync(join(dir, 'picture.png'), 'not a real png, just unsupported');

        const {report} = analyze({
            rootPath: dir,
            knowledgeDir,
            ruleSetDir,
            config: {...DEFAULT_CONFIG, include: ['**/*'], exclude: ['**/config-excluded.ts'], maxFileBytes: 50}
        });

        assert.equal(report.coverage.status, 'complete', 'every dropped file here is a structural exclusion, never a coverage gap');
        assert.equal(report.coverage.analysisIncomplete, undefined);
        assert.equal(report.coverage.filesAnalyzed, 1, 'only keep.ts was actually analyzed');
        assert.equal(report.coverage.excludedByReason.excluded_by_config, 1);
        assert.equal(report.coverage.excludedByReason.file_too_large, 1);
        assert.equal(report.coverage.excludedByReason.unsupported_language, 1);
        assert.equal(report.coverage.excludedByReason.read_error, undefined);
        assert.equal(report.coverage.excludedByReason.analysis_cancelled, undefined);
        const sampleReasons = new Set(report.coverage.excludedSample.map((f) => f.reason));
        assert.deepEqual(sampleReasons, new Set(['excluded_by_config', 'file_too_large', 'unsupported_language']));
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('a memory-guard abort is status "partial", with abortReason/stoppedAtFile set and the un-reached tail counted as analysis_cancelled, not silently dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-status-abort-'));
    try {
        writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
        writeFileSync(join(dir, 'b.ts'), 'export const y = 1;\n');
        writeFileSync(join(dir, 'c.ts'), 'export const z = 1;\n');

        const {report} = analyze({
            rootPath: dir,
            knowledgeDir,
            ruleSetDir,
            config: DEFAULT_CONFIG,
            memoryGuard: {checkEveryFiles: 1, criticalRatio: 0} // deterministic abort on the very first check
        });

        assert.equal(report.coverage.status, 'partial');
        assert.equal(report.coverage.analysisIncomplete, true);
        assert.equal(report.coverage.abortReason, 'memory_limit');
        assert.ok(typeof report.coverage.stoppedAtFile === 'string' && report.coverage.stoppedAtFile.length > 0);
        assert.equal(report.coverage.filesCancelled, report.coverage.filesSelected, 'nothing was reached before the first check, so the whole selection is cancelled');
        assert.equal(report.coverage.excludedByReason.analysis_cancelled, report.coverage.filesCancelled, 'the cancelled tail is visible in the structured breakdown too, not only as a bare count');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('excludedSample is bounded even when the number of excluded files is large — the exact count still lives in excludedByReason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-status-sample-cap-'));
    try {
        writeFileSync(join(dir, 'keep.ts'), 'export const x = 1;\n');
        const EXCLUDED_COUNT = 30; // above Pipeline.ts's EXCLUDED_SAMPLE_LIMIT (20)
        for (let i = 0; i < EXCLUDED_COUNT; i += 1) {
            writeFileSync(join(dir, `dropped${i}.ts`), 'export const y = 1;\n');
        }
        const {report} = analyze({
            rootPath: dir,
            knowledgeDir,
            ruleSetDir,
            config: {...DEFAULT_CONFIG, exclude: ['**/dropped*.ts']}
        });
        assert.equal(report.coverage.status, 'complete');
        assert.equal(report.coverage.excludedByReason.excluded_by_config, EXCLUDED_COUNT, 'the exact count is never capped');
        assert.ok(report.coverage.excludedSample.length < EXCLUDED_COUNT, 'the sample list IS bounded, unlike the count');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
