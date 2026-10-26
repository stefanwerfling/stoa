import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const corpusProject = join(here, 'corpus', 'project');

const cycleFindings = (): Finding[] => {
    return analyze({
        rootPath: corpusProject,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG
    }).report.findings.filter((finding) => finding.rule.id === 'R-DEP-CYCLE');
};

test('R-DEP-CYCLE reports one finding per cycle, listing its members', () => {
    const findings = cycleFindings();
    assert.equal(findings.length, 1, 'the CycleA <-> CycleB cycle, counted once');
    const finding = findings[0];
    assert.ok(finding !== undefined);
    assert.equal(finding.location.symbol, 'CycleA.ts,CycleB.ts');
    assert.equal(finding.severity, 'high');
    assert.equal(finding.interpretation.principles[0]?.id, 'marcus.cooperation');
    assert.ok(finding.interpretation.dimensions.includes('dependencies'));
});

test('non-relative imports (PHP namespaces, bare specifiers) do not create cycles', () => {
    // Service.php uses `use App\...` and no corpus file forms another cycle, so
    // exactly one cycle (the TS pair) must be reported.
    assert.equal(cycleFindings().length, 1);
});
