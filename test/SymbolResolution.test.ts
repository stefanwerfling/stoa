import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import type {EvidenceGraph} from '../src/evidence/EvidenceGraph.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Fact, Finding} from '../src/Types.js';

// Symbol-based (not identifier-TEXT-based) dataflow resolution
// (src/analysis/typescript/SymbolResolution.ts, wired into
// ValidationDataflow.ts and OneHopResolution.ts): two different variables
// that merely share a spelling must never be treated as the same value.
// Exercised through the real analysis path against
// test/fixtures/validation-contract/symbol-resolution.ts — every assertion
// below was checked against real analyze() output before being written.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixturePath = join(here, 'fixtures', 'symbol-resolution', 'symbol-resolution.ts');

interface DataflowFactValue {
    id: string;
    graph: EvidenceGraph;
}

const analyzeFixture = (): {facts: Fact[]; findings: Finding[]} => {
    const result = analyze({rootPath: fixturePath, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    return {facts: result.facts, findings: result.report.findings};
};

const graphFor = (facts: Fact[], traceId: string): EvidenceGraph => {
    const fact = facts.find((f) => f.kind === 'validation.dataflowGraph' && (f.value as unknown as DataflowFactValue).id === traceId);
    assert.ok(fact, `expected a validation.dataflowGraph fact for ${traceId}`);
    return (fact?.value as unknown as DataflowFactValue).graph;
};

// Edges leaving the validated-value node specifically — NOT the input-side
// `passes-to` edge (request-input -> validator-invocation), which exists in
// every graph regardless of what happens to the validated value afterwards.
const edgesFromValidatedValue = (graph: EvidenceGraph): EvidenceGraph['edges'] => {
    const validatedIds = new Set(graph.nodes.filter((n) => n.kind === 'validated-value').map((n) => n.id));
    return graph.edges.filter((e) => validatedIds.has(e.from));
};

test('case 1/2 — shadowing: a different, shadowed variable in a nested block is never mistaken for the validated one', () => {
    // shadowedScope: `const result = ShadowSchema.parse(req.body)`, then an
    // UNRELATED `const result = {...}` shadows it inside a block and is
    // passed to save() FIRST (in source order) — a text-based match would
    // have wrongly latched onto that inner call. The outer, real result
    // reaches its OWN save() call afterwards.
    const {facts} = analyzeFixture();
    const graph = graphFor(facts, 'VC-SYMBOL-SHADOW-101');
    const persists = graph.edges.filter((e) => e.kind === 'persists');
    assert.equal(persists.length, 1, 'exactly one persist edge — the shadowed inner save() must not also match');
    assert.equal(persists[0]?.status, 'verified');
    assert.ok(persists[0]?.basis.includes('repo.save(result)'), 'points at the OUTER save(result), not the inner shadowed one');
});

test('case 3 — alias: a plain `const alias = result` still resolves to the validated value', () => {
    const {facts} = analyzeFixture();
    const graph = graphFor(facts, 'VC-SYMBOL-ALIAS-102');
    const persists = graph.edges.filter((e) => e.kind === 'persists');
    assert.equal(persists.length, 1);
    assert.equal(persists[0]?.status, 'verified');
    assert.ok(persists[0]?.basis.includes('repo.save(alias)'));
});

test('case 4 — destructuring: `const { data } = result` after safeParse() resolves the same as result.data would', () => {
    const {facts} = analyzeFixture();
    const graph = graphFor(facts, 'VC-SYMBOL-DESTRUCTURE-103');
    const transforms = graph.edges.find((e) => e.kind === 'transforms');
    assert.ok(transforms, 'a transforms edge exists for the destructured { data }');
    assert.equal(transforms?.status, 'verified', 'the preceding `if (!result.success) return;` is a proven failure-path-rejected guard');
    const persists = graph.edges.filter((e) => e.kind === 'persists');
    assert.equal(persists.length, 1);
    assert.equal(persists[0]?.status, 'verified');
    assert.ok(persists[0]?.basis.includes('repo.save(data)'));
});

test('case 5 — reassignment: a reassigned binding is never claimed to still carry the validated value', () => {
    // reassignedResult: `let value = ReassignSchema.parse(req.body); value =
    // {tampered: true}; repo.save(value);` — the trace must stop at
    // validated-value with NO further edge, not wrongly claim the
    // OVERWRITTEN `value` still reaches persistence as the validated result.
    const {facts} = analyzeFixture();
    const graph = graphFor(facts, 'VC-SYMBOL-REASSIGN-104');
    assert.ok(graph.nodes.some((n) => n.kind === 'validated-value'), 'tracing still reaches the validated value itself');
    assert.deepEqual(edgesFromValidatedValue(graph), [], 'no edge leaves the validated-value node — reassignment breaks the provable chain');
});

test('case 6 — parameter passing: a validated value handed to a function resolves via its parameter\'s SYMBOL, not its spelling', () => {
    const {facts} = analyzeFixture();
    const graph = graphFor(facts, 'VC-SYMBOL-PARAM-105');
    const persists = graph.edges.filter((e) => e.kind === 'persists');
    assert.equal(persists.length, 1);
    assert.equal(persists[0]?.status, 'heuristic', 'a one-hop cross-function trace is heuristic, never verified');
    assert.ok(persists[0]?.basis.includes('this.repository.save(data)'));
    assert.ok(persists[0]?.basis.includes('OrderService.register'));
});

test('case 7 (negative) — an unrelated variable passed to a sink is never connected to a differently-named validated result', () => {
    // unrelatedVariable: `result` (validated) is never used except in a
    // `void` statement; `other = req.body` (never validated) reaches
    // save() instead — the two must stay unrelated: no persist edge for
    // VC-SYMBOL-WRONGVAR-106, and the raw `other` is flagged by the
    // existing, independent mass-assignment check.
    const {facts, findings} = analyzeFixture();
    const graph = graphFor(facts, 'VC-SYMBOL-WRONGVAR-106');
    assert.deepEqual(edgesFromValidatedValue(graph), [], 'the validated result is never connected to a sink it was never actually passed to');
    assert.ok(findings.some((f) => f.rule.id === 'R-VALIDATION-MASS-ASSIGNMENT' && f.observation.evidence[0]?.value === 'save(other)'), 'the UNRELATED raw req.body alias is still correctly flagged on its own');
});
