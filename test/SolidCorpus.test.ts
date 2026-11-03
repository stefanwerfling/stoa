import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadArchitectureConfig} from '../src/architecture/ArchitectureConfig.js';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {loadExpected} from '../src/evaluation/Corpus.js';
import {evaluate} from '../src/evaluation/Evaluator.js';
import {findingKey, keyString} from '../src/FindingIdentity.js';
import {analyze} from '../src/Pipeline.js';

// Flutter quality track E7: the SOLID golden corpus (precision gate) and the
// uniqueness of SOLID finding identities (baseline / eval key).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const corpus = join(here, 'corpus', 'solid');
const project = join(corpus, 'project');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

before(async () => {
    await initDart();
});

test('E7 SOLID corpus: precision and recall 100 % with --solid (stage 1)', () => {
    const {findings} = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true}).report;
    const result = evaluate(findings, loadExpected(join(corpus, 'expected.json')), project);
    assert.deepEqual([result.overall.truePositives, result.overall.falsePositives, result.overall.falseNegatives], [7, 0, 0]);
});

test('E7 SOLID corpus: precision and recall 100 % with --solid --architecture (stage 2 replaces stage 1)', () => {
    const architecture = loadArchitectureConfig(join(corpus, 'stoa.architecture.json'));
    const {findings} = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true, architecture}).report;
    const result = evaluate(findings, loadExpected(join(corpus, 'expected-architecture.json')), project);
    assert.deepEqual([result.overall.truePositives, result.overall.falsePositives, result.overall.falseNegatives], [7, 0, 0]);
});

test('E7 SOLID corpus: without --solid the corpus produces no finding at all', () => {
    assert.deepEqual(analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings, []);
});

test('E7: every SOLID finding has a unique identity (file, rule, symbol) — several targets of one class/file never collide in a baseline', () => {
    const fixtures = join(here, 'fixtures', 'solid');
    const runs = [
        {rootPath: join(fixtures, 'dip-layer')},
        {rootPath: join(fixtures, 'dip-concrete')},
        {rootPath: join(fixtures, 'contracts')},
        {rootPath: join(fixtures, 'dip-declared', 'project'), architecture: loadArchitectureConfig(join(fixtures, 'dip-declared', 'stoa.architecture.json'))}
    ];
    for (const run of runs) {
        const solidFindings = analyze({...run, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true}).report.findings.filter((finding) => finding.rule.id.startsWith('R-SOLID-'));
        const keys = solidFindings.map((finding) => keyString(findingKey(run.rootPath, finding)));
        assert.ok(keys.length > 0, run.rootPath);
        assert.equal(new Set(keys).size, keys.length, `duplicate identity in ${run.rootPath}`);
    }
});

test('E7 CLI: `stoa eval --solid --architecture` scores the corpus and passes', () => {
    const result = spawnSync(
        'node',
        ['--import', 'tsx', 'src/Cli.ts', 'eval', project, '--expected', join(corpus, 'expected-architecture.json'), '--solid', '--architecture', join(corpus, 'stoa.architecture.json'), '--format', 'json'],
        {cwd: root, encoding: 'utf8'}
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as {overall: {precision: number}}).overall.precision, 1);
});
