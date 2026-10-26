import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import {toSarif} from '../src/reporting/SarifReporter.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const corpusProject = join(here, 'corpus', 'project');

const buildSarif = () => {
    const report = analyze({
        rootPath: corpusProject,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG
    }).report;
    return {report, sarif: JSON.parse(toSarif(report, {baseDir: corpusProject}))};
};

test('SARIF envelope is valid 2.1.0 with the stoa driver', () => {
    const {sarif} = buildSarif();
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0].tool.driver.name, 'stoa');
    assert.ok(Array.isArray(sarif.runs[0].results));
});

test('every finding becomes one result with a valid rule index and relative location', () => {
    const {report, sarif} = buildSarif();
    const run = sarif.runs[0];
    assert.equal(run.results.length, report.findings.length);
    for (const result of run.results) {
        assert.equal(run.tool.driver.rules[result.ruleIndex].id, result.ruleId);
        const region = result.locations[0].physicalLocation.region;
        assert.ok(region.startLine >= 1 && region.startColumn >= 1);
        const uri = result.locations[0].physicalLocation.artifactLocation.uri;
        assert.ok(!uri.startsWith('/') && !uri.includes('\\'), `uri should be a relative forward-slash path: ${uri}`);
    }
});

test('severity maps to SARIF level', () => {
    const {sarif} = buildSarif();
    const results = sarif.runs[0].results;
    const swallow = results.find((r: {ruleId: string}) => r.ruleId === 'R-ERR-SWALLOWED');
    const cognitive = results.find((r: {ruleId: string}) => r.ruleId === 'R-COMPLEXITY-COGNITIVE');
    assert.equal(swallow.level, 'error', 'high -> error');
    assert.equal(cognitive.level, 'warning', 'medium -> warning');
});

test('SARIF output is deterministic for a fixed baseDir', () => {
    const report = analyze({
        rootPath: corpusProject,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG
    }).report;
    assert.equal(toSarif(report, {baseDir: corpusProject}), toSarif(report, {baseDir: corpusProject}));
});
