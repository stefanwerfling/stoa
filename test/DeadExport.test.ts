import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'deadexports');

const deadExportFindings = (deadExports: boolean): Finding[] =>
    analyze({
        rootPath: project,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG,
        deadExports
    }).report.findings.filter((f) => f.rule.id === 'R-UNUSED-EXPORT');

test('R-UNUSED-EXPORT is opt-in (off by default)', () => {
    assert.equal(deadExportFindings(false).length, 0);
});

test('R-UNUSED-EXPORT flags exports used nowhere, but not imported ones', () => {
    const findings = deadExportFindings(true);
    const names = findings.map((f) => f.location.symbol).sort();
    // `used` is imported by Consumer → not flagged; `dead` and `run` are unused.
    assert.deepEqual(names, ['dead', 'run']);
    assert.ok(!names.includes('used'));
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.cooperation');
});

test('dead-export analysis is deterministic', () => {
    assert.equal(JSON.stringify(deadExportFindings(true)), JSON.stringify(deadExportFindings(true)));
});
