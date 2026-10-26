import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {loadExpected} from '../src/evaluation/Corpus.js';
import {evaluate} from '../src/evaluation/Evaluator.js';
import {analyze} from '../src/Pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const corpusProject = join(here, 'corpus', 'project');
const expectedFile = join(here, 'corpus', 'expected.json');

const runEvaluation = () => {
    const findings = analyze({
        rootPath: corpusProject,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG
    }).report.findings;
    return evaluate(findings, loadExpected(expectedFile));
};

// AC-5: a per-rule precision gate. Rules below the gate would ship as experimental.
const PRECISION_GATE = 0.8;

test('golden corpus: no false positives and no false negatives', () => {
    const result = runEvaluation();
    assert.deepEqual(result.falsePositives, [], 'negative cases must not produce findings');
    assert.deepEqual(result.falseNegatives, [], 'every expected finding must be produced');
});

test('golden corpus: overall precision and recall are perfect', () => {
    const result = runEvaluation();
    assert.equal(result.overall.precision, 1);
    assert.equal(result.overall.recall, 1);
    assert.equal(result.overall.truePositives, 26);
});

test('AC-5: every rule meets the precision gate', () => {
    const result = runEvaluation();
    assert.ok(result.perRule.length >= 4, 'all MVP rules exercised by the corpus');
    for (const rule of result.perRule) {
        assert.ok(rule.precision >= PRECISION_GATE, `${rule.rule} precision ${rule.precision} below gate ${PRECISION_GATE}`);
    }
});

test('evaluation is deterministic', () => {
    assert.equal(JSON.stringify(runEvaluation()), JSON.stringify(runEvaluation()));
});
