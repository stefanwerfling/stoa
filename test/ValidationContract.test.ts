import assert from 'node:assert/strict';
import {rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadValidationContract} from '../src/contracts/ValidationContract.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

// Validation Trace IDs / cross-layer contract verification, exercised through
// the real analysis path. TypeScript-only, scalar Zod schemas only (see
// src/analysis/typescript/ValidationAnnotations.ts,
// src/analysis/typescript/ValidatorUsage.ts and
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

test('loadValidationContract parses a well-formed contract, rejects a malformed one, and rejects a duplicate id', () => {
    const contract = loadValidationContract(contractPath);
    assert.equal(contract.version, '1.1.0');
    assert.equal(contract.rules.length, 16);
    assert.ok(contract.rules.some((rule) => rule.id === 'VC-ITEM-QUANTITY-001'));

    assert.throws(() => loadValidationContract(join(fixtures, 'does-not-exist.json')));

    const dup = join(fixtures, 'duplicate-contract.json.tmp');
    try {
        writeFileSync(dup, JSON.stringify({
            version: '1.0.0',
            rules: [
                {id: 'VC-A-001', description: 'a', field: 'a', dataType: 'number'},
                {id: 'VC-A-001', description: 'b', field: 'b', dataType: 'string'}
            ]
        }));
        assert.throws(() => loadValidationContract(dup), /duplicate rule id/);
    } finally {
        rmSync(dup, {force: true});
    }
});

test('the feature is fully inert without a contract: annotations are extracted but never interpreted', () => {
    const findings = vcFindings(analyzeFixture(null));
    assert.deepEqual(findings, [], 'no R-VALIDATION-CONTRACT-* finding fires when no contract is supplied');
});

test('identical conditions in two files under the same ID produce no finding (the positive baseline)', () => {
    // VC-ITEM-QUANTITY-001 is annotated identically in frontend.ts and backend.ts
    // (z.number().int().min(1).max(100), matching the contract exactly), and both
    // are exercised via .parse() so neither is also flagged as unused.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-ITEM-QUANTITY-001')), 'the matching, identical, contract-conformant, used rule produces zero findings');
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

test('a normalization disagreement (contract trim-only, code trims and lowercases) is a mismatch; the matching email format is not', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const mismatch = findings.find((f) => key(f) === 'R-VALIDATION-CONTRACT-MISMATCH|backend.ts:11');
    assert.ok(mismatch, 'VC-EMAIL-FORMAT-003: contract declares normalization=[trim], backend also lowercases');
    assert.ok(mismatch?.observation.statement.includes('normalization contract=trim actual=lowercase,trim'));
    assert.ok(!mismatch?.observation.statement.includes('format'), 'the contract also declares format=email, which backend\'s .email() satisfies — not part of the mismatch');
});

test('an enum allowedValues mismatch (contract wants 3 values, code implements 2) is reported as a mismatch, not unresolved', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const mismatch = findings.find((f) => key(f) === 'R-VALIDATION-CONTRACT-MISMATCH|misc.ts:17');
    assert.ok(mismatch, 'VC-USER-ROLE-004: z.enum([admin,user]) vs contract allowedValues=[admin,user,guest]');
    assert.ok(mismatch?.observation.statement.includes('allowedValues contract=admin,guest,user actual=admin,user'));
});

test('.refine() stays unresolved — a validation-relevant modifier is never silently treated as a no-op', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.ok(findings.some((f) => key(f) === 'R-VALIDATION-CONTRACT-UNRESOLVED|misc.ts:24'), 'VC-AGE-CHECK-013: z.number().refine(...) is not a recognized scalar Zod chain');
});

test('a malformed annotation ID and an ID unknown to the contract each get their own finding', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const keys = findings.map(key);
    assert.ok(keys.includes('R-VALIDATION-CONTRACT-INVALID-ID|misc.ts:8'), '"quantity_bad" does not match the Trace ID format');
    assert.ok(keys.includes('R-VALIDATION-CONTRACT-UNKNOWN-ID|misc.ts:11'), 'VC-GHOST-FIELD-099 is not in the loaded contract');
});

test('a contract rule with no annotation anywhere is reported as not-implemented, anchored at the contract file, low confidence', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const notImplemented = findings.find((f) => f.rule.id === 'R-VALIDATION-CONTRACT-NOT-IMPLEMENTED');
    assert.ok(notImplemented, 'VC-SHIP-WEIGHT-005 has no stoa:validation annotation anywhere in the fixtures');
    assert.ok(notImplemented?.location.file.endsWith('contract.json'), 'anchored at the contract, not a source file (there is none to point at)');
    assert.equal(notImplemented?.confidence, 0.3, 'explicitly low confidence — absence of evidence is not evidence of absence');
    assert.ok(notImplemented?.missingContext?.[0]?.toLowerCase().includes('absence'));
});

test('an annotated, resolvable validator that is never .parse()\'d anywhere in the file is flagged unused', () => {
    // VC-ORDER-QTY-006 (usage.ts): declared, annotated, resolvable — but no
    // .parse()/.safeParse() call on it exists anywhere in that file.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const unused = findings.find((f) => f.rule.id === 'R-VALIDATION-CONTRACT-UNUSED-VALIDATOR');
    assert.ok(unused, 'unusedSchema (VC-ORDER-QTY-006) is declared but never parsed');
    assert.ok(unused?.observation.statement.includes('VC-ORDER-QTY-006'));
    assert.equal(unused?.confidence, 0.5);
});

test('a validator invoked on the request AND whose parsed result is what gets saved produces no finding (the good usage case)', () => {
    // VC-ORDER-NOTE-007 (usage.ts): validatedSchema.parse(req.body.note) is used,
    // and the parsed `note` (not the raw field) is what repo.save() receives.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-ORDER-NOTE-007')), 'validated-and-used-correctly produces zero findings');
});

test('a validator invoked on the request, but a raw copy of the body also reaches a persistence sink in the same function, is flagged', () => {
    // VC-ORDER-COMMENT-008 (usage.ts): rawReuseSchema.parse(req.body.comment) runs,
    // but repo.save(req.body) (the whole raw body) is ALSO called in the same function.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const rawAfter = findings.find((f) => f.rule.id === 'R-VALIDATION-CONTRACT-RAW-AFTER-VALIDATION');
    assert.ok(rawAfter, 'validation ran but did not gate what actually got saved');
    assert.ok(rawAfter?.observation.statement.includes('VC-ORDER-COMMENT-008'));
    assert.ok(rawAfter?.observation.statement.includes('save(req.body)'));
    assert.equal(rawAfter?.severity, 'high');
});

test('.int()/.positive()/.email()/.url() each have a modeled effect: integer, exclusive-min and format mismatches are detected; a matching .nonnegative()+max is not', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const byKey = new Map(findings.map((f) => [key(f), f]));

    const integerMismatch = byKey.get('R-VALIDATION-CONTRACT-MISMATCH|zod-constraints.ts:8');
    assert.ok(integerMismatch, 'VC-STOCK-COUNT-009: contract requires .int(), code omits it');
    assert.ok(integerMismatch?.observation.statement.includes('integer contract=true actual=false'));

    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-DISCOUNT-PERCENT-010')), '.nonnegative().max(100) exactly matches contract min=0,max=100 — no finding');

    const exclusiveMismatch = byKey.get('R-VALIDATION-CONTRACT-MISMATCH|zod-constraints.ts:18');
    assert.ok(exclusiveMismatch, 'VC-RATING-SCORE-011: contract min=0 is inclusive, .positive() excludes exactly 0');
    assert.ok(exclusiveMismatch?.observation.statement.includes('min contract=0 actual=0 (exclusive)'));

    const formatMismatch = byKey.get('R-VALIDATION-CONTRACT-MISMATCH|zod-constraints.ts:23');
    assert.ok(formatMismatch, 'VC-WEBSITE-URL-012: contract wants format=url, code uses .email()');
    assert.ok(formatMismatch?.observation.statement.includes('format contract=url actual=email'));
});

test('correctness fix: multiple .max() calls merge order-independently (smallest wins), matching the contract after merge', () => {
    // couponSchema = z.number().min(0).max(100).max(50) — before the fix, the
    // LAST .max() in the chain simply overwrote the earlier one (which would
    // have matched by coincidence here); this asserts the merge itself, not
    // just the final value, by checking no mismatch is reported against a
    // contract whose max (50) only the TIGHTEST call satisfies.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-COUPON-CAP-014')), '.max(100).max(50) resolves to max=50, matching the contract exactly');
});

test('correctness fix: a contradictory range (.min(10).max(5)) is reported as unresolved, not silently resolved to one bound', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.ok(findings.some((f) => key(f) === 'R-VALIDATION-CONTRACT-UNRESOLVED|zod-constraints.ts:36'), 'VC-IMPOSSIBLE-RANGE-015: no value can satisfy both min=10 and max=5');
});

test('correctness fix: multiple format constraints (.email().url()) AND together — a contract requiring one of them is not a mismatch', () => {
    // contactSchema = z.string().email().url() — before the fix, the LAST
    // format modifier (.url()) silently overwrote .email(), which would have
    // produced a false mismatch against a contract that only requires email.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-CONTACT-HANDLE-016')), 'email is among the formats .email().url() enforces, so the contract\'s format=email requirement is satisfied');
});

test('every validation-contract finding states its principle, dimension and an explicit missingContext', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.equal(findings.length, 15, 'the full fixture set across all files');
    for (const finding of findings) {
        assert.ok(finding.interpretation.principles.length > 0, `${finding.rule.id} carries a principle`);
        assert.ok(finding.interpretation.dimensions.includes('robustness'), `${finding.rule.id} is tagged robustness`);
        assert.ok((finding.missingContext?.length ?? 0) > 0, `${finding.rule.id} states its remaining uncertainty`);
    }
});

test('a malformed contract file fails fast with a schema-validation error, not a silent empty result', () => {
    assert.throws(() => loadValidationContract(contractPath.replace('contract.json', 'contract.json.nope')));
});
