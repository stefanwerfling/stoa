import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import type {EvidenceEdge, EvidenceGraph} from '../src/evidence/EvidenceGraph.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Fact} from '../src/Types.js';

// The Evidence Graph (src/evidence/EvidenceGraph.ts) and its builder
// (src/analysis/typescript/ValidationDataflow.ts), exercised through the real
// analysis path and the `validation.dataflowGraph` facts it produces — one
// graph per validator invocation fed by request data. Deliberately checked
// directly at the fact level (not only through ValidationContractRule's
// findings), since the graph itself — its nodes, edges and status values —
// is the Phase 3 deliverable, independent of whether a contract is loaded.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixtures = join(here, 'fixtures', 'validation-contract');

const dataflowFactsFor = (traceId: string): Array<{fact: Fact; graph: EvidenceGraph}> => {
    const result = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    return result.facts
        .filter((fact) => fact.kind === 'validation.dataflowGraph')
        .map((fact) => ({fact, value: fact.value as unknown as {id: string; graph: EvidenceGraph}}))
        .filter((entry) => entry.value.id === traceId)
        .map((entry) => ({fact: entry.fact, graph: entry.value.graph}));
};

const edgesByKind = (graph: EvidenceGraph, kind: EvidenceEdge['kind']): EvidenceEdge[] => graph.edges.filter((edge) => edge.kind === kind);

test('the feature is always extracted (no contract needed): a graph fact exists for every request-fed validator invocation', () => {
    const entries = dataflowFactsFor('VC-DATAFLOW-SAME-FUNCTION-017');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.fact.kind, 'validation.dataflowGraph');
    assert.equal(entries[0]?.fact.certainty, 'semantic-heuristic');
});

test('same-function tracing: the validated value reaching a persistence-verb call in the same function is verified end-to-end', () => {
    const [entry] = dataflowFactsFor('VC-DATAFLOW-SAME-FUNCTION-017');
    const graph = entry?.graph;
    assert.ok(graph !== undefined);
    assert.ok(graph.edges.every((edge) => edge.status === 'verified'), 'every edge in this fully-traced same-function chain is verified, none silently heuristic');
    const persists = edgesByKind(graph, 'persists');
    assert.equal(persists.length, 1);
    assert.equal(persists[0]?.status, 'verified');
    assert.ok(persists[0]?.basis.includes('repo.save(data)'));
    const nodeKinds = graph.nodes.map((node) => node.kind).sort();
    assert.deepEqual(nodeKinds, ['input-value', 'persistence-sink', 'request-source', 'validated-value', 'validation-schema', 'validator-invocation'].sort());
});

test('one-hop cross-function tracing: a heuristic edge is never reported as verified', () => {
    const [entry] = dataflowFactsFor('VC-DATAFLOW-ONE-HOP-018');
    const graph = entry?.graph;
    assert.ok(graph !== undefined);
    // The chain up to and including the validated value is still directly
    // provable (verified); only the hop ACROSS the call boundary — where
    // identity is inferred by parameter position, not type-proven — is
    // downgraded to heuristic. The hard rule: nothing here claims `verified`
    // for that hop.
    const upToValidated = graph.edges.filter((edge) => edge.kind !== 'passes-to' || edge.to.startsWith('validator-invocation'));
    assert.ok(upToValidated.filter((edge) => edge.kind !== 'persists').every((edge) => edge.status === 'verified' || edge.kind === 'passes-to'));
    const crossFunctionEdges = graph.edges.filter((edge) => edge.basis.includes('orderService.register'));
    assert.ok(crossFunctionEdges.length > 0, 'the one-hop edge into OrderService.register exists');
    assert.ok(crossFunctionEdges.every((edge) => edge.status === 'heuristic'), 'the cross-function hop is heuristic, never verified');
    const persists = edgesByKind(graph, 'persists');
    assert.equal(persists.length, 1);
    assert.equal(persists[0]?.status, 'heuristic');
    assert.ok(persists[0]?.basis.includes('this.repository.save(data)'));
    assert.ok(persists[0]?.basis.includes('OrderService.register'));
    const serviceNode = graph.nodes.find((node) => node.kind === 'service');
    assert.ok(serviceNode, 'a service node represents the resolved one-hop callee');
});

test('unresolved destination: no persistence-sink node is fabricated when the callee cannot be resolved', () => {
    const [entry] = dataflowFactsFor('VC-DATAFLOW-UNRESOLVED-019');
    const graph = entry?.graph;
    assert.ok(graph !== undefined);
    const unresolvedEdges = graph.edges.filter((edge) => edge.status === 'unresolved');
    assert.equal(unresolvedEdges.length, 1);
    assert.equal(unresolvedEdges[0]?.kind, 'passes-to', 'an unconfirmed destination is "passes-to", never "persists" — Stoa does not claim it reaches a sink');
    assert.ok(unresolvedEdges[0]?.limits?.[0]?.includes('not declared in this file'));
    assert.ok(!graph.nodes.some((node) => node.kind === 'persistence-sink'), 'no persistence-sink node exists — nothing was proven to be a sink');
    const serviceNode = graph.nodes.find((node) => node.kind === 'service');
    assert.ok(serviceNode?.label.includes('externalRepository'));
});

test('a resolvable one-hop callee with no persistence call anywhere inside produces no further edge (not every helper function persists)', () => {
    const [entry] = dataflowFactsFor('VC-DATAFLOW-NO-SINK-020');
    const graph = entry?.graph;
    assert.ok(graph !== undefined);
    assert.ok(graph.nodes.some((node) => node.kind === 'validated-value'), 'tracing still reaches the validated value');
    assert.ok(!graph.nodes.some((node) => node.kind === 'service' || node.kind === 'persistence-sink'), 'OrderService.log resolves but does nothing persistence-related, so no further node is added');
    assert.ok(graph.edges.every((edge) => edge.kind !== 'persists' && edge.kind !== 'bypasses'));
});
