import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import type {EvidenceGraph} from '../src/evidence/EvidenceGraph.js';
import {loadValidationContract} from '../src/contracts/ValidationContract.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Fact, Finding} from '../src/Types.js';

// safeParse() success/failure-path control-flow verification
// (src/analysis/typescript/SafeParseGuard.ts): accessing `.data` is not by
// itself proof the access is safe — `.safeParse()` returns a discriminated
// union, and `.data` is only sound once `result.success` is PROVEN true by
// the surrounding control flow, not merely because SOME condition exists
// nearby. Exercised through the real analysis path against
// test/fixtures/safeparse-guard/safeparse-guard.ts (Fall A-D from the spec,
// plus a negative control for "unresolved" vs "missing"); every assertion
// below was checked against real analyze() output before being written.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixturePath = join(here, 'fixtures', 'safeparse-guard', 'safeparse-guard.ts');
const contractPath = join(here, 'fixtures', 'safeparse-guard', 'contract.json');

interface DataflowFactValue {
    id: string;
    graph: EvidenceGraph;
}

const transformsEdgeFor = (traceId: string): EvidenceGraph['edges'][number] => {
    const result = analyze({rootPath: fixturePath, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    const fact = (result.facts as Fact[]).find((f) => f.kind === 'validation.dataflowGraph' && (f.value as unknown as DataflowFactValue).id === traceId);
    assert.ok(fact, `expected a validation.dataflowGraph fact for ${traceId}`);
    const graph = (fact?.value as unknown as DataflowFactValue).graph;
    const transforms = graph.edges.find((e) => e.kind === 'transforms');
    assert.ok(transforms, `expected a transforms edge for ${traceId}`);
    return transforms as EvidenceGraph['edges'][number];
};

test('Fall A — an early-exit guard (`if (!result.success) throw`) that unconditionally terminates is verified (failure-path-rejected)', () => {
    const edge = transformsEdgeFor('VC-GUARD-FALLA-101');
    assert.equal(edge.status, 'verified');
    assert.ok(edge.basis.includes('unconditionally terminates'));
    assert.equal(edge.limits, undefined, 'a verified edge carries no limits');
});

test('Fall B — the access nested inside a positive `if (result.success)` branch is verified (success-guard-verified)', () => {
    const edge = transformsEdgeFor('VC-GUARD-FALLB-102');
    assert.equal(edge.status, 'verified');
    assert.ok(edge.basis.includes('if (result.success)'));
});

test('Fall C — no check of result.success anywhere is unresolved (success-guard-missing), not silently verified', () => {
    const edge = transformsEdgeFor('VC-GUARD-FALLC-103');
    assert.equal(edge.status, 'unresolved');
    assert.ok(edge.limits?.includes('safeParse guard: success-guard-missing'));
});

test('Fall D — a throw exists, but its condition is entirely unrelated to result.success — still success-guard-missing, not a false sense of safety', () => {
    // Stoa must not assume safety just because SOME condition/throw happens
    // to precede the access; `someCondition` never mentions result.success.
    const edge = transformsEdgeFor('VC-GUARD-FALLD-104');
    assert.equal(edge.status, 'unresolved');
    assert.ok(edge.limits?.includes('safeParse guard: success-guard-missing'));
});

test('negative control — a condition that DOES mention result.success, but is AND-combined with an unrelated reject term, is success-guard-unresolved (not missing, not verified)', () => {
    // `if (!result.success && other) throw` only rejects when BOTH hold —
    // reaching the access does not prove success was true (it could be
    // false while `other` is also false) — genuinely ambiguous, distinct
    // from "nothing related exists at all".
    const edge = transformsEdgeFor('VC-GUARD-UNRESOLVED-105');
    assert.equal(edge.status, 'unresolved');
    assert.ok(edge.limits?.includes('safeParse guard: success-guard-unresolved'));
    assert.ok(edge.basis.includes('not in a provably sound shape'));
});

test('R-VALIDATION-CONTRACT-SAFEPARSE-UNGUARDED fires exactly once for each unguarded case, never for Fall A/B, and never duplicated with DATAFLOW-UNRESOLVED', () => {
    const contract = loadValidationContract(contractPath);
    const result = analyze({rootPath: fixturePath, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, validationContract: contract});
    const vcFindings = (result.report.findings as Finding[]).filter((f) => f.rule.id.startsWith('R-VALIDATION-CONTRACT'));

    assert.ok(!vcFindings.some((f) => f.observation.statement.includes('VC-GUARD-FALLA-101')), 'Fall A is a proven guard — no finding');
    assert.ok(!vcFindings.some((f) => f.observation.statement.includes('VC-GUARD-FALLB-102')), 'Fall B is a proven guard — no finding');

    for (const id of ['VC-GUARD-FALLC-103', 'VC-GUARD-FALLD-104', 'VC-GUARD-UNRESOLVED-105']) {
        const matching = vcFindings.filter((f) => f.observation.statement.includes(id));
        assert.equal(matching.length, 1, `exactly one finding for ${id}, not duplicated with DATAFLOW-UNRESOLVED`);
        assert.equal(matching[0]?.rule.id, 'R-VALIDATION-CONTRACT-SAFEPARSE-UNGUARDED');
        assert.equal(matching[0]?.confidence, 0.5);
    }
});
