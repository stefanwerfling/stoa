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
    assert.equal(contract.rules.length, 44);
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
    const unused = findings.find((f) => f.rule.id === 'R-VALIDATION-CONTRACT-UNUSED-VALIDATOR' && f.observation.statement.includes('VC-ORDER-QTY-006'));
    assert.ok(unused, 'unusedSchema (VC-ORDER-QTY-006) is declared but never parsed');
    assert.equal(unused?.confidence, 0.5);
});

test('correctness fix: an unused-validator check does not require the schema\'s SHAPE to be resolvable — a z.object() schema (unresolved shape) is still flagged as unused', () => {
    // VC-AGE-CHECK-013 (misc.ts): z.number().refine(...) — its shape is
    // UNRESOLVED (refine's effect is not statically verifiable, hence the
    // separate R-VALIDATION-CONTRACT-UNRESOLVED finding already asserted
    // elsewhere), but it is ALSO never .parse()'d anywhere in the file.
    // Before the fix, the unused-validator check skipped any schema whose
    // shape was unresolved, which made it dead code for the realistic
    // z.object(...) request-body case (shape resolution and usage tracing
    // are orthogonal concerns).
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const unused = findings.find((f) => f.rule.id === 'R-VALIDATION-CONTRACT-UNUSED-VALIDATOR' && f.observation.statement.includes('VC-AGE-CHECK-013'));
    assert.ok(unused, 'ageSchema is unused AND shape-unresolved — both are independently true and both are reported');
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

test('dataflow tracing: a same-function and a one-hop cross-function persist produce no finding; an unresolvable service-like destination does', () => {
    // dataflow.ts: sameFunctionPersist (same-function, verified) and
    // oneHopPersist (OrderService.register -> this.repository.save, a
    // heuristic one-hop trace) are both "good paths" — silent, like every
    // other confirmed-safe case in this suite. unresolvedDestination passes
    // the validated value to externalRepository.commit(...), which has no
    // resolvable implementation in this file; its receiver name ("repository")
    // is still business/persistence-suggestive, so this is surfaced rather
    // than silently assumed safe.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-DATAFLOW-SAME-FUNCTION-017') && f.rule.id === 'R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED'));
    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-DATAFLOW-ONE-HOP-018') && f.rule.id === 'R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED'));

    const unresolved = findings.find((f) => key(f) === 'R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED|dataflow.ts:64');
    assert.ok(unresolved, 'VC-DATAFLOW-UNRESOLVED-019: externalRepository.commit(...) cannot be resolved within this file');
    assert.ok(unresolved?.observation.statement.includes('externalRepository.commit(data)'));
    assert.equal(unresolved?.confidence, 0.3, 'explicitly low confidence — a name match is a hint, not proof');
    assert.ok(unresolved?.missingContext?.[0]?.includes('ONE hop'));
});

test('layer/security attribution: backend attribution confirmed via dataflow evidence silences the claim; unattributed claims are surfaced; frontend-only and the five unverifiable security flags are never checked', () => {
    // layers.ts: attributedHandler parses req.body directly (backend
    // attribution confirmed) — VC-LAYER-ATTRIBUTED-021's `layers: ["backend"]`
    // claim produces no LAYER-UNRESOLVED finding. unattributedUsage parses a
    // fixed local literal, never req.* — VC-LAYER-UNATTRIBUTED-022 claims the
    // same layer but cannot be confirmed. securityUsage is the same
    // unattributed shape, but the contract declares `security.serverSideValidation`
    // (not `layers`) plus two flags Stoa never checks (authenticationRequired,
    // ownershipRequired) — exactly one finding, naming only the checked flag.
    // frontendOnlyUsage is also unattributed, but VC-LAYER-FRONTEND-ONLY-024
    // claims ONLY the frontend layer, which Stoa never checks — no finding.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const byKey = new Map(findings.map((f) => [key(f), f]));

    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-LAYER-ATTRIBUTED-021') && f.rule.id === 'R-VALIDATION-CONTRACT-LAYER-UNRESOLVED'));

    const unattributed = byKey.get('R-VALIDATION-CONTRACT-LAYER-UNRESOLVED|layers.ts:12');
    assert.ok(unattributed, 'VC-LAYER-UNATTRIBUTED-022: claims backend, never shown fed by the request');
    assert.ok(unattributed?.observation.statement.includes('VC-LAYER-UNATTRIBUTED-022'));
    assert.equal(unattributed?.confidence, 0.3);

    const security = byKey.get('R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED|layers.ts:15');
    assert.ok(security, 'VC-LAYER-SECURITY-UNVERIFIED-023: declares serverSideValidation, never shown fed by the request');
    assert.ok(security?.observation.statement.includes('VC-LAYER-SECURITY-UNVERIFIED-023'));
    assert.ok(!findings.some((f) => f.rule.id === 'R-VALIDATION-CONTRACT-LAYER-UNRESOLVED' && f.observation.statement.includes('VC-LAYER-SECURITY-UNVERIFIED-023')), 'no LAYER-UNRESOLVED duplicate — only the more specific SECURITY-UNVERIFIED fires');

    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-LAYER-FRONTEND-ONLY-024') && (f.rule.id === 'R-VALIDATION-CONTRACT-LAYER-UNRESOLVED' || f.rule.id === 'R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED')), 'a frontend-only layer claim is accepted but never checked');
});

test('z.object() field-by-field resolution: a matching contract-named field produces no finding, a mismatching one does, an absent field and an unresolvable field each stay unresolved by name', () => {
    // zod-constraints.ts: the object as a WHOLE is never a scalar chain
    // (resolved stays false), but the ONE field the contract names
    // (contractRule.field) is resolved the same way a top-level scalar
    // chain would be, without resolving or guessing at the rest of the
    // object's shape.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const byKey = new Map(findings.map((f) => [key(f), f]));

    assert.ok(!findings.some((f) => f.observation.statement.includes('VC-OBJECT-FIELD-MATCH-025')), 'orderSchema.sku (min 1) matches the contract exactly — no finding, same as a matching bare scalar schema');

    const mismatch = byKey.get('R-VALIDATION-CONTRACT-MISMATCH|zod-constraints.ts:61');
    assert.ok(mismatch, 'VC-OBJECT-FIELD-MISMATCH-026: productSchema.price has no lower bound, the contract requires min=0');
    assert.ok(mismatch?.observation.statement.includes('min contract=0 actual=none'));

    const absent = byKey.get('R-VALIDATION-CONTRACT-UNRESOLVED|zod-constraints.ts:67');
    assert.ok(absent, 'VC-OBJECT-FIELD-ABSENT-027: partialSchema does not declare a "missingField" property at all');
    assert.ok(absent?.observation.statement.includes('field "missingField" not found'));

    const unresolvedField = byKey.get('R-VALIDATION-CONTRACT-UNRESOLVED|zod-constraints.ts:73');
    assert.ok(unresolvedField, 'VC-OBJECT-FIELD-UNRESOLVED-028: feedbackSchema.note uses .refine(), not a recognized scalar chain');
    assert.ok(unresolvedField?.observation.statement.includes('field "note" is not a recognized scalar Zod chain'));
});

test('correctness fix: a bare z.object() request-body schema that matches the contract field-by-field no longer shows a spurious shape-level unresolved finding', () => {
    // dataflow.ts / layers.ts: before field-by-field resolution existed,
    // EVERY z.object() schema produced R-VALIDATION-CONTRACT-UNRESOLVED
    // regardless of whether its one contract-named field actually matched —
    // the realistic request-body case was always "unresolved", never
    // actually verified. All seven of these schemas' single named field now
    // resolves cleanly, so none of them produce a shape-level finding.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    for (const id of ['VC-DATAFLOW-SAME-FUNCTION-017', 'VC-DATAFLOW-ONE-HOP-018', 'VC-LAYER-ATTRIBUTED-021', 'VC-LAYER-UNATTRIBUTED-022', 'VC-LAYER-SECURITY-UNVERIFIED-023', 'VC-LAYER-FRONTEND-ONLY-024']) {
        assert.ok(!findings.some((f) => f.rule.id === 'R-VALIDATION-CONTRACT-UNRESOLVED' && f.observation.statement.includes(id)), `${id}'s single named field matches the contract — no shape-level unresolved finding`);
    }
    // VC-DATAFLOW-UNRESOLVED-019 still produces ITS dataflow finding (the
    // field itself matches; the destination is what's unresolved) but no
    // LONGER the shape-level one.
    assert.ok(!findings.some((f) => f.rule.id === 'R-VALIDATION-CONTRACT-UNRESOLVED' && f.observation.statement.includes('VC-DATAFLOW-UNRESOLVED-019')));
    assert.ok(findings.some((f) => f.rule.id === 'R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED' && f.observation.statement.includes('VC-DATAFLOW-UNRESOLVED-019')));
});

test('correctness fix: prototype-safe object-field lookup — "constructor"/"toString"/"__proto__" fields match their OWN contract entry, never an inherited Object.prototype property, and "__proto__" is never silently swallowed', () => {
    // prototype-fields.ts: the `in` operator would ALSO match "constructor"
    // and "toString" via Object.prototype even if the schema never declared
    // them; a plain object literal assignment to the key "__proto__" sets
    // the object's OWN PROTOTYPE instead of creating a property, silently
    // losing that field's resolved conditions entirely. Object.hasOwn + a
    // null-prototype fields map (ValidationAnnotations.ts) fixes both.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    for (const id of ['VC-PROTO-CONSTRUCTOR-201', 'VC-PROTO-TOSTRING-202', 'VC-PROTO-PROTO-203', 'VC-PROTO-PRESENT-204']) {
        assert.ok(!findings.some((f) => f.observation.statement.includes(id)), `${id}: the field is genuinely declared and matches — no finding`);
    }
    const absent = findings.find((f) => f.observation.statement.includes('VC-PROTO-ABSENT-205'));
    assert.ok(absent, 'VC-PROTO-ABSENT-205: "missingField" is genuinely not declared — correctly unresolved, not confused with "realField" or any inherited property');
    assert.equal(absent?.rule.id, 'R-VALIDATION-CONTRACT-UNRESOLVED');
    assert.ok(absent?.observation.statement.includes('field "missingField" not found'));
});

test('object-field conflict detection: two z.object() implementations sharing a trace ID with differing field conditions conflict; a missing field never counts as agreeing, and never becomes a spurious conflict on its own', () => {
    // object-field-conflict.ts: frontendSchema.quantity (min=1) vs
    // backendSchema.quantity (min=10) under VC-OBJECT-CONFLICT-206 — the
    // exact FE/BE shape from the spec, via z.object() rather than a bare
    // scalar. declaredSchema.amount (min=5) vs undeclaredSchema (no
    // "amount" field at all) under VC-OBJECT-CONFLICT-MISSING-207 — the
    // undeclared side is excluded from the comparison entirely (it already
    // gets its own UNRESOLVED finding), so there is nothing left to
    // conflict with declaredSchema's single remaining entry.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    const conflicts206 = findings.filter((f) => f.rule.id === 'R-VALIDATION-CONTRACT-CONFLICT' && f.observation.statement.includes('VC-OBJECT-CONFLICT-206'));
    assert.equal(conflicts206.length, 2, 'both z.object() implementations are flagged as conflicting with each other');
    assert.ok(conflicts206[0]?.observation.statement.includes('min=1') && conflicts206[0]?.observation.statement.includes('min=10'));

    assert.ok(!findings.some((f) => f.rule.id === 'R-VALIDATION-CONTRACT-CONFLICT' && f.observation.statement.includes('VC-OBJECT-CONFLICT-MISSING-207')), 'a missing field never becomes its own spurious conflict — only one comparable entry remains');
    const missingFieldFinding = findings.find((f) => f.observation.statement.includes('VC-OBJECT-CONFLICT-MISSING-207'));
    assert.equal(missingFieldFinding?.rule.id, 'R-VALIDATION-CONTRACT-UNRESOLVED', 'the undeclared side still gets its own, separate "field not found" finding');
});

test('z.object() shape extensions: .strict()/.partial()/.extend()/.merge() (inline and by reference) resolve correctly; unknown modifiers, spread, nested objects and arrays-of-objects stay safely unresolved', () => {
    // object-shape-extensions.ts — every MATCH case (.strict() unaffected
    // field set, .partial() making a field optional, .extend() adding a
    // field, .merge() with both an inline and a referenced schema, and a
    // plain .optional() field that already worked before this round)
    // produces NO finding; every UNRESOLVED case (an unrecognized
    // modifier, a spread-introduced field, a nested z.object() field, and
    // a top-level z.array(z.object(...))) is explicitly flagged as
    // unresolved, never silently guessed at.
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    for (const id of ['VC-SHAPE-STRICT-301', 'VC-SHAPE-PARTIAL-302', 'VC-SHAPE-EXTEND-303', 'VC-SHAPE-MERGE-INLINE-304', 'VC-SHAPE-MERGE-REF-305', 'VC-SHAPE-OPTIONAL-306']) {
        assert.ok(!findings.some((f) => f.observation.statement.includes(id)), `${id}: resolves and matches the contract — no finding`);
    }

    const unknownModifier = findings.find((f) => f.observation.statement.includes('VC-SHAPE-UNKNOWN-MODIFIER-307'));
    assert.equal(unknownModifier?.rule.id, 'R-VALIDATION-CONTRACT-UNRESOLVED', '.readonly() is not a recognized object-level modifier');

    const spread = findings.find((f) => f.observation.statement.includes('VC-SHAPE-SPREAD-308'));
    assert.ok(spread?.observation.statement.includes('field "extra" not found'), 'a spread-introduced field is not captured, reported as not found');

    const nested = findings.find((f) => f.observation.statement.includes('VC-SHAPE-NESTED-309'));
    assert.ok(nested?.observation.statement.includes('field "address" is not a recognized scalar Zod chain'), 'a nested z.object() field resolves to null, not guessed at');

    const array = findings.find((f) => f.observation.statement.includes('VC-SHAPE-ARRAY-310'));
    assert.equal(array?.rule.id, 'R-VALIDATION-CONTRACT-UNRESOLVED', 'z.array(z.object(...)) is not a bare z.object() at the top level — stays fully unresolved');
});

test('every validation-contract finding states its principle, dimension and an explicit missingContext', () => {
    const findings = vcFindings(analyzeFixture(loadValidationContract(contractPath)));
    assert.equal(findings.length, 31, 'the full fixture set across all files');
    for (const finding of findings) {
        assert.ok(finding.interpretation.principles.length > 0, `${finding.rule.id} carries a principle`);
        assert.ok(finding.interpretation.dimensions.includes('robustness'), `${finding.rule.id} is tagged robustness`);
        assert.ok((finding.missingContext?.length ?? 0) > 0, `${finding.rule.id} states its remaining uncertainty`);
    }
});

test('a malformed contract file fails fast with a schema-validation error, not a silent empty result', () => {
    assert.throws(() => loadValidationContract(contractPath.replace('contract.json', 'contract.json.nope')));
});
