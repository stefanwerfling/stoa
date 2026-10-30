import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadValidationContract} from '../src/contracts/ValidationContract.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

// Validation Trace IDs / cross-layer contract verification, exercised through
// the real analysis path. TypeScript-only, scalar Zod schemas only (see
// src/analysis/typescript/ValidationAnnotations.ts and
// src/rules/project/ValidationContractRule.ts for the documented scope).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixtures = join(here, 'fixtures', 'validation-contract');
const contractPath = join(fixtures, 'contract.json');

const analyzeFixture = (contract: ReturnType<typeof loadValidationContract> | null): Finding[] => {
    return analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, validationContract: contract}).report.findings;
};
const vcFindings = (findings: Finding[]): Finding[] => findings.filter((f) => f.rule.id.startsWith('R-VALIDATION-CONTRACT'));
const key = (f: Finding): string => `${f.rule.id}|${f.location.file.split('/').pop()}:${f.location.range.startLine}`;

test('loadValidationContract parses a well-formed contract and rejects a malformed one', () => {
    const contract = loadValidationContract(contractPath);
    assert.equal(contract.version, '1.0.0');
    assert.equal(contract.rules.length, 5);
    assert.ok(contract.rules.some((rule) => rule.id === 'VC-ITEM-QUANTITY-001'));

    assert.throws(() => loadValidationContract(join(fixtures, 'does-not-exist.json')));
});

test('the feature is fully inert without a contract: annotations are extracted but never interpreted', () => {
    const findings = vcFindings(analyzeFixture(null));
    assert.deepEqual(findings, [], 'no R-VALIDATION-CONTRACT-* finding fires when no contract is supplied');
});

test('identical conditions in two files under the same ID produce no finding (the positive baseline)', () => {
    // VC-ITEM-QUANTITY-001 is annotated identically in frontend.ts and backend.ts
    // (z.number().int().min(1).max(100), matching the contract exactly).
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-ITEM-QUANTITY-001')), 'the matching, identical, contract-conformant rule produces zero findings');
});

test('a value-range disagreement between the contract and an implementation is a mismatch, and between two implementations is a conflict', () => {
    // VC-ITEM-PRICE-002: contract min=0; frontend.ts has min=1 (mismatches the
    // contract) while backend.ts has min=0 (matches the contract) — but since
    // their extracted conditions differ from EACH OTHER, both are also flagged
    // as conflicting implementations of the same trace ID.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const keys = findings.map(key).sort();
    assert.ok(keys.includes('R-VALIDATION-CONTRACT-MISMATCH|frontend.ts:8'), 'frontend\'s min=1 disagrees with the contract\'s min=0');
    assert.ok(!keys.includes('R-VALIDATION-CONTRACT-MISMATCH|backend.ts:8'), 'backend\'s min=0 matches the contract — no mismatch (only the conflict, at the same line)');
    assert.ok(keys.includes('R-VALIDATION-CONTRACT-CONFLICT|frontend.ts:8') && keys.includes('R-VALIDATION-CONTRACT-CONFLICT|backend.ts:8'), 'both implementations are flagged as conflicting with each other');

    const mismatch = findings.find((f) => key(f) === 'R-VALIDATION-CONTRACT-MISMATCH|frontend.ts:8');
    assert.ok(mismatch?.observation.statement.includes('min contract=0 actual=1'));
});

test('a normalization disagreement (contract trim-only, code trims and lowercases) is a mismatch', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const mismatch = findings.find((f) => key(f) === 'R-VALIDATION-CONTRACT-MISMATCH|backend.ts:11');
    assert.ok(mismatch, 'VC-EMAIL-FORMAT-003: contract declares normalization=[trim], backend also lowercases');
    assert.ok(mismatch?.observation.statement.includes('normalization contract=trim actual=lowercase,trim'));
});

test('a malformed annotation ID, an ID unknown to the contract, and an unresolvable schema shape each get their own finding', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const keys = findings.map(key);
    assert.ok(keys.includes('R-VALIDATION-CONTRACT-INVALID-ID|misc.ts:6'), '"quantity_bad" does not match the Trace ID format');
    assert.ok(keys.includes('R-VALIDATION-CONTRACT-UNKNOWN-ID|misc.ts:9'), 'VC-GHOST-FIELD-099 is not in the loaded contract');
    assert.ok(keys.includes('R-VALIDATION-CONTRACT-UNRESOLVED|misc.ts:12'), 'z.enum(...) is not a recognized scalar Zod chain');
});

test('a contract rule with no annotation anywhere is reported as not-implemented, anchored at the contract file, low confidence', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const notImplemented = findings.find((f) => f.rule.id === 'R-VALIDATION-CONTRACT-NOT-IMPLEMENTED');
    assert.ok(notImplemented, 'VC-SHIP-WEIGHT-005 has no stoa:validation annotation anywhere in the fixtures');
    assert.ok(notImplemented?.location.file.endsWith('contract.json'), 'anchored at the contract, not a source file (there is none to point at)');
    assert.equal(notImplemented?.confidence, 0.3, 'explicitly low confidence — absence of evidence is not evidence of absence');
    assert.ok(notImplemented?.missingContext?.[0]?.toLowerCase().includes('absence'));
});

test('every validation-contract finding states its principle, dimension and an explicit missingContext', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.equal(findings.length, 8, 'the full fixture set: 1 invalid-id, 1 unknown-id, 1 unresolved, 2 mismatch, 2 conflict, 1 not-implemented');
    for (const finding of findings) {
        assert.ok(finding.interpretation.principles.length > 0, `${finding.rule.id} carries a principle`);
        assert.ok(finding.interpretation.dimensions.includes('robustness'), `${finding.rule.id} is tagged robustness`);
        assert.ok((finding.missingContext?.length ?? 0) > 0, `${finding.rule.id} states its remaining uncertainty`);
    }
});

test('a malformed contract file fails fast with a schema-validation error, not a silent empty result', () => {
    assert.throws(() => loadValidationContract(contractPath.replace('contract.json', 'contract.json.nope')));
});
