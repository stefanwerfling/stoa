import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadValidationContract} from '../src/contracts/ValidationContract.js';
import {loadExpected} from '../src/evaluation/Corpus.js';
import {evaluate} from '../src/evaluation/Evaluator.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';

// A dedicated golden corpus for Validation Trace ID / dataflow analysis
// (Phase 6 of the "Analysis Correctness, Dataflow Verification & Cross-Layer
// Validation" spec), mirroring the existing test/corpus/{project,expected.json}
// precision/recall pattern (see Evaluation.test.ts / HtmlA11y.test.ts) rather
// than inventing a second ground-truth mechanism. Covers all 16 explicitly
// required test groups in one consolidated, navigable place — see the
// per-case comments in corpus/*.ts for which group each belongs to, and
// expected.json's description for the full list.
//
// Every individual capability already has a dedicated, more granular test
// elsewhere (BackendValidation.test.ts, ValidationContract.test.ts,
// ValidationDataflow.test.ts); this corpus's distinct value is a single
// precision/recall gate over a realistic, self-contained project shape —
// the kind of corpus-wide regression a scattered set of per-feature unit
// tests cannot by itself guarantee (a new true positive appearing is caught
// the same way as a new false positive: both move the gate off 100%).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const base = join(here, 'fixtures', 'validation-dataflow-corpus');
const corpus = join(base, 'corpus');
const contractPath = join(base, 'contract.json');

test('validation/dataflow golden corpus: precision/recall 100% across all 16 required test groups', () => {
    const contract = loadValidationContract(contractPath);
    const findings = analyze({rootPath: corpus, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, validationContract: contract}).report.findings;
    const result = evaluate(findings, loadExpected(join(base, 'expected.json')), corpus);
    assert.equal(result.overall.precision, 1, `false positives: ${JSON.stringify(result.falsePositives)}`);
    assert.equal(result.overall.recall, 1, `false negatives: ${JSON.stringify(result.falseNegatives)}`);
    assert.equal(result.overall.truePositives, 20);
    assert.equal(result.overall.falsePositives, 0);
    assert.equal(result.overall.falseNegatives, 0);
    assert.deepEqual(result.duplicateExpected, [], 'the manifest itself has no duplicate identities');
    assert.deepEqual(result.duplicates, [], 'no produced finding is accidentally emitted twice for the same identity');
});

test('the feature stays fully inert without a contract: zero R-VALIDATION-CONTRACT-* findings, the backend-trust-boundary rules unaffected', () => {
    const findings = analyze({rootPath: corpus, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
    assert.ok(!findings.some((f) => f.rule.id.startsWith('R-VALIDATION-CONTRACT')), 'no contract loaded — none of the contract-gated rules can fire');
    assert.ok(findings.some((f) => f.rule.id === 'R-VALIDATION-MISSING-BACKEND'), 'the non-contract rules are unaffected by whether a contract is loaded');
});
