import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EMPTY_PROJECT_CONFIG, loadProjectConfig} from '../src/config/ProjectConfig.js';
import {ModuleResolver} from '../src/analysis/ModuleResolution.js';
import {buildModuleGraph, cycleAdjacency} from '../src/model/ModuleGraph.js';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Fact} from '../src/Types.js';

// Phase 0 — the reusable ModuleGraph. These tests drive the builder with
// synthetic `deps.import` facts so the graph's determinism, de-duplication,
// unresolved-tracking and the D1-a `cycleAdjacency` view are covered directly,
// independent of any adapter.

const importFact = (from: string, module: string, isTypeOnly = false, line = 1): Fact => ({
    id: `fact:${from}:deps.import:${module}:${line}`,
    kind: 'deps.import',
    subject: {file: from, kindOf: 'import', range: {startLine: line, startCol: 0, endLine: line, endCol: 0}},
    value: {module, isTypeOnly},
    evidence: [{source: 'deps', detail: `import ${module}`}],
    certainty: 'syntactic',
    producedBy: {adapter: 'test', version: '0'}
});

const emptyResolver = new ModuleResolver(EMPTY_PROJECT_CONFIG);

test('builds relative edges and nodes; order of facts does not change the result (determinism)', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts', '/p/c.ts']);
    const factsA = [importFact('/p/a.ts', './b'), importFact('/p/b.ts', './c')];
    const factsB = [importFact('/p/b.ts', './c'), importFact('/p/a.ts', './b')];
    const graphA = buildModuleGraph(factsA, analyzed, emptyResolver);
    const graphB = buildModuleGraph(factsB, analyzed, emptyResolver);
    assert.deepEqual(JSON.stringify(graphA), JSON.stringify(graphB), 'byte-identical regardless of fact order');
    assert.deepEqual(graphA.nodes, ['/p/a.ts', '/p/b.ts', '/p/c.ts'], 'all analyzed files are nodes, sorted');
    assert.equal(graphA.edges.length, 2);
    assert.equal(graphA.edges[0]?.resolution, 'relative');
});

test('a duplicate identical import collapses to one edge; two different specifiers to the same target stay two edges', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts']);
    const facts = [
        importFact('/p/a.ts', './b', false, 1),
        importFact('/p/a.ts', './b', false, 5), // same relationship, different line → one edge
        importFact('/p/a.ts', '../p/b', false, 9) // different specifier, same target → distinct edge
    ];
    const graph = buildModuleGraph(facts, analyzed, emptyResolver);
    const aToB = graph.edges.filter((e) => e.from === '/p/a.ts' && e.to === '/p/b.ts');
    assert.equal(aToB.length, 2, 'distinct specifiers are distinct relationships; the exact duplicate collapsed');
    assert.deepEqual(aToB.map((e) => e.specifier).sort(), ['../p/b', './b']);
});

test('an unresolved import is recorded under `unresolved`, never as an edge, never guessed', () => {
    const analyzed = new Set(['/p/a.ts']);
    const facts = [importFact('/p/a.ts', './missing'), importFact('/p/a.ts', 'bare-external')];
    const graph = buildModuleGraph(facts, analyzed, emptyResolver);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.unresolved.length, 2);
    assert.deepEqual(graph.unresolved.map((u) => u.specifier).sort(), ['./missing', 'bare-external']);
});

test('cycleAdjacency: seeds all nodes, keeps only relative non-type-only edges, drops self-edges (D1-a parity)', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts', '/p/iso.ts']);
    const facts = [
        importFact('/p/a.ts', './b'),
        importFact('/p/b.ts', './a'),
        importFact('/p/a.ts', './a'), // self-import → must not become a self-edge
        importFact('/p/b.ts', './a', true) // type-only → excluded
    ];
    const adjacency = cycleAdjacency(buildModuleGraph(facts, analyzed, emptyResolver));
    assert.ok(adjacency.has('/p/iso.ts'), 'isolated node is present');
    assert.deepEqual([...(adjacency.get('/p/a.ts') ?? [])], ['/p/b.ts']);
    assert.deepEqual([...(adjacency.get('/p/b.ts') ?? [])], ['/p/a.ts'], 'the type-only a-import is excluded, so only the value edge remains');
    assert.ok(!(adjacency.get('/p/a.ts')?.has('/p/a.ts')), 'no self-edge');
});

// Correction P5 — node set comes from the EXPLICIT analyzed-file set the
// pipeline passes, not from "files that happen to have a fact". A file that was
// analyzed but contributed no `deps.import` (indeed no fact at all) is still a
// node, and remains a valid import TARGET.

test('an analyzed file with no facts of its own is still a node and a valid import target (node set = passed analyzedFiles)', () => {
    // `/p/leaf.ts` produces NO fact here, yet it is in the analyzed set and is
    // imported by a.ts — it must be a node AND the edge to it must resolve.
    const analyzed = new Set(['/p/a.ts', '/p/leaf.ts']);
    const graph = buildModuleGraph([importFact('/p/a.ts', './leaf')], analyzed, emptyResolver);
    assert.deepEqual(graph.nodes, ['/p/a.ts', '/p/leaf.ts'], 'leaf.ts is a node despite contributing no fact');
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0]?.to, '/p/leaf.ts', 'the import to the fact-less file resolves, not falsely unresolved');
    assert.equal(graph.unresolved.length, 0);
});

test('an empty project yields empty nodes/edges/unresolved, not an error', () => {
    const graph = buildModuleGraph([], new Set(), emptyResolver);
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.edges, []);
    assert.deepEqual(graph.unresolved, []);
    assert.equal(cycleAdjacency(graph).size, 0);
});

// Point 1 — Evidence. Every edge must trace back to the exact `deps.import`
// fact it came from: its id and its source range, never mixed with another
// fact's, never a fabricated reference.

test('each edge\'s evidence points to its OWN underlying fact (id + range); two facts are never mixed', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts', '/p/c.ts']);
    const factAtoB = importFact('/p/a.ts', './b', false, 7);
    const factAtoC = importFact('/p/a.ts', './c', false, 19);
    const graph = buildModuleGraph([factAtoB, factAtoC], analyzed, emptyResolver);

    const edgeAB = graph.edges.find((e) => e.from === '/p/a.ts' && e.to === '/p/b.ts');
    const edgeAC = graph.edges.find((e) => e.from === '/p/a.ts' && e.to === '/p/c.ts');
    assert.ok(edgeAB !== undefined && edgeAC !== undefined);

    // Each edge has exactly its own one source site here.
    assert.equal(edgeAB.evidence.length, 1);
    assert.equal(edgeAC.evidence.length, 1);

    // factId is the id of the actual fact behind this edge — not the other one.
    assert.equal(edgeAB.evidence[0]?.factId, factAtoB.id);
    assert.equal(edgeAC.evidence[0]?.factId, factAtoC.id);
    assert.notEqual(edgeAB.evidence[0]?.factId, edgeAC.evidence[0]?.factId, 'evidence of the two edges is not conflated');

    // range is that fact's own source range (deep-equal, distinct per fact).
    assert.deepEqual(edgeAB.evidence[0]?.range, factAtoB.subject.range);
    assert.deepEqual(edgeAC.evidence[0]?.range, factAtoC.subject.range);
    assert.equal(edgeAB.evidence[0]?.range.startLine, 7);
    assert.equal(edgeAC.evidence[0]?.range.startLine, 19);
});

test('no edge or unresolved import carries invalid evidence — every factId resolves to a real input fact, every range is that fact\'s range', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts']);
    const facts = [importFact('/p/a.ts', './b', false, 3), importFact('/p/a.ts', './missing', false, 4)];
    const factById = new Map(facts.map((f) => [f.id, f]));
    const graph = buildModuleGraph(facts, analyzed, emptyResolver);

    for (const edge of graph.edges) {
        assert.ok(edge.evidence.length >= 1, 'an edge always has at least one source site');
        for (const site of edge.evidence) {
            const origin = factById.get(site.factId);
            assert.ok(origin !== undefined, `edge evidence factId ${site.factId} must be a real input fact, not fabricated`);
            assert.ok(typeof site.factId === 'string' && site.factId.length > 0);
            assert.deepEqual(site.range, origin.subject.range);
        }
    }
    for (const unresolved of graph.unresolved) {
        assert.ok(unresolved.evidence.length >= 1);
        for (const site of unresolved.evidence) {
            const origin = factById.get(site.factId);
            assert.ok(origin !== undefined, 'an unresolved import still cites a real fact, never a fabricated one');
            assert.deepEqual(site.range, origin.subject.range);
        }
    }
});

// Correction P4 — multiple source sites of the SAME relationship must all be
// kept (as deterministically-ordered evidence), never silently dropped.

test('the same import relationship on two lines becomes ONE edge carrying BOTH source sites (deterministically ordered)', () => {
    const analyzed = new Set(['/p/a.ts', '/p/b.ts']);
    const line3 = importFact('/p/a.ts', './b', false, 3);
    const line9 = importFact('/p/a.ts', './b', false, 9);
    // Build in both orders; the resulting edge + its evidence order must be identical.
    const g1 = buildModuleGraph([line3, line9], analyzed, emptyResolver);
    const g2 = buildModuleGraph([line9, line3], analyzed, emptyResolver);
    assert.equal(JSON.stringify(g1), JSON.stringify(g2), 'evidence order is deterministic regardless of fact order');

    const edge = g1.edges.filter((e) => e.from === '/p/a.ts' && e.to === '/p/b.ts');
    assert.equal(edge.length, 1, 'still one edge for the one relationship');
    assert.equal(edge[0]?.evidence.length, 2, 'BOTH source sites are preserved, not just the first');
    assert.deepEqual(edge[0]?.evidence.map((s) => s.factId), [line3.id, line9.id].sort(), 'both facts cited, deterministically ordered');
    assert.deepEqual(edge[0]?.evidence.map((s) => s.range.startLine).sort((a, b) => a - b), [3, 9]);
});

test('unresolved imports also accumulate all their source sites', () => {
    const analyzed = new Set(['/p/a.ts']);
    const graph = buildModuleGraph([importFact('/p/a.ts', './gone', false, 2), importFact('/p/a.ts', './gone', false, 8)], analyzed, emptyResolver);
    assert.equal(graph.unresolved.length, 1, 'one unresolved relationship');
    assert.equal(graph.unresolved[0]?.evidence.length, 2, 'both unresolved source sites kept');
});

// Point 4 — determinism must not depend on the insertion order of
// `analyzedFiles` (a Set iterates in insertion order), nor on fact order.

test('the same graph is produced byte-for-byte regardless of analyzedFiles insertion order (and fact order)', () => {
    const forward = new Set(['/p/a.ts', '/p/b.ts', '/p/c.ts']);
    const reverse = new Set(['/p/c.ts', '/p/b.ts', '/p/a.ts']);
    const factsA = [importFact('/p/a.ts', './b'), importFact('/p/b.ts', './c'), importFact('/p/c.ts', './a')];
    const factsB = [...factsA].reverse();
    const graph1 = buildModuleGraph(factsA, forward, emptyResolver);
    const graph2 = buildModuleGraph(factsB, reverse, emptyResolver);
    assert.equal(JSON.stringify(graph1), JSON.stringify(graph2), 'serialized graph is byte-identical across both orderings');
});

test('alias edges are recorded with resolution "alias" but are NOT in the Phase-0 cycle view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-mg-'));
    try {
        mkdirSync(join(dir, 'src'), {recursive: true});
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@app/*': ['src/*']}}}));
        const importer = join(dir, 'src', 'importer.ts');
        const target = join(dir, 'src', 'thing.ts');
        const analyzed = new Set([importer, target]);
        const resolver = new ModuleResolver(loadProjectConfig(dir));
        const facts = [importFact(importer, '@app/thing')];
        const graph = buildModuleGraph(facts, analyzed, resolver);
        assert.equal(graph.edges.length, 1);
        assert.equal(graph.edges[0]?.resolution, 'alias');
        const adjacency = cycleAdjacency(graph);
        assert.equal(adjacency.get(importer)?.size, 0, 'an alias edge does not feed the Phase-0 cycle view');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
