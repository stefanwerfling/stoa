import type {Fact, SourceRange} from '../Types.js';
import type {ModuleResolver, ResolutionMethod} from '../analysis/ModuleResolution.js';

/**
 * A reusable, project-wide module dependency graph (Phase 0 of the
 * architecture-evolution work). It is built ONCE per analysis, after fact
 * extraction, from the existing `deps.import` facts plus the config-aware
 * `ModuleResolver` -- it holds only strings and small records (file paths,
 * specifiers, fact ids, ranges), never AST nodes and never a copy of the fact
 * array, so it adds no unbounded memory growth on top of the facts that
 * already exist.
 *
 * The graph records EVERY resolved import edge with its resolution method
 * (`relative`/`alias`/`exports`/`imports`), plus the imports that stayed
 * `unresolved`. In Phase 0 only `relative` value edges feed the existing
 * `DependencyCycleRule` (see `cycleAdjacency`); alias/exports/imports edges are
 * carried for a later phase to consume deliberately, without changing any
 * current finding (decision D1-a).
 */

/** The one piece of provenance every edge/unresolved import keeps: which fact it came from and where. Never the fact itself. */
export interface ImportEvidence {
    factId: string;
    range: SourceRange;
}

export interface ModuleEdge {
    /** Absolute path of the importing module (an analyzed file). */
    from: string;
    /** Absolute path of the resolved target module (an analyzed file). */
    to: string;
    /** The raw import specifier as written in source (e.g. `./b`, `@app/x`). */
    specifier: string;
    /** From the `deps.import` fact: a type-only import (erased at compile time, no runtime dependency). */
    isTypeOnly: boolean;
    /** How `specifier` was resolved to `to` -- always a resolved method here (never `unresolved`). */
    resolution: Exclude<ResolutionMethod, 'unresolved'>;
    /** ALL source sites of this one relationship (one per contributing `deps.import` fact), deduplicated by factId and sorted deterministically — so a finding can cite every place the edge occurs, never just the first. */
    evidence: ImportEvidence[];
}

export interface UnresolvedImport {
    from: string;
    specifier: string;
    isTypeOnly: boolean;
    /** ALL source sites of this unresolved import, deduplicated by factId and sorted deterministically. */
    evidence: ImportEvidence[];
}

export interface ModuleGraph {
    /** Every analyzed module, sorted -- including ones with no imports (isolated nodes), so the graph is a complete picture. */
    nodes: readonly string[];
    /** Resolved import edges, sorted deterministically. */
    edges: readonly ModuleEdge[];
    /** Imports that no configured mechanism could map to an analyzed file -- surfaced, never hidden or guessed. */
    unresolved: readonly UnresolvedImport[];
}

interface ImportValue {
    module: string;
    isTypeOnly: boolean;
}

const compareEdges = (a: ModuleEdge, b: ModuleEdge): number =>
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.specifier.localeCompare(b.specifier) || a.resolution.localeCompare(b.resolution);

const compareUnresolved = (a: UnresolvedImport, b: UnresolvedImport): number =>
    a.from.localeCompare(b.from) || a.specifier.localeCompare(b.specifier);

// Deterministic order for the evidence sites of one edge/unresolved import:
// by factId, then by source position — independent of the order facts arrived.
const compareEvidence = (a: ImportEvidence, b: ImportEvidence): number =>
    a.factId.localeCompare(b.factId) || a.range.startLine - b.range.startLine || a.range.startCol - b.range.startCol;

// Appends a source site to an accumulator, deduplicated by factId (the same
// fact can only be one site; distinct facts for the same relationship are the
// extra sites we must NOT lose).
const addEvidence = (sites: ImportEvidence[], evidence: ImportEvidence): void => {
    if (!sites.some((site) => site.factId === evidence.factId)) {
        sites.push(evidence);
    }
};

/**
 * Builds the module graph from `deps.import` facts. Deterministic: the result
 * depends only on the set of facts and the resolver, never on the order facts
 * arrive in (nodes and edges are sorted; edges are de-duplicated by their full
 * identity before sorting). Duplicate identical imports collapse to one edge;
 * two DIFFERENT specifiers reaching the same target stay two distinct edges, so
 * no genuine relationship is lost.
 */
export const buildModuleGraph = (facts: readonly Fact[], analyzedFiles: ReadonlySet<string>, resolver: ModuleResolver): ModuleGraph => {
    const edgeByKey = new Map<string, ModuleEdge>();
    const unresolvedByKey = new Map<string, UnresolvedImport>();

    for (const fact of facts) {
        if (fact.kind !== 'deps.import') {
            continue;
        }
        const value = fact.value as unknown as ImportValue;
        const from = fact.subject.file;
        const specifier = value.module;
        const isTypeOnly = value.isTypeOnly === true;
        const evidence: ImportEvidence = {factId: fact.id, range: fact.subject.range};

        const resolved = resolver.resolve(from, specifier, analyzedFiles);
        if (resolved.target === null || resolved.resolution === 'unresolved') {
            const key = `${from} ${specifier} ${isTypeOnly}`;
            const existing = unresolvedByKey.get(key);
            if (existing === undefined) {
                unresolvedByKey.set(key, {from, specifier, isTypeOnly, evidence: [evidence]});
            } else {
                addEvidence(existing.evidence, evidence);
            }
            continue;
        }
        const key = `${from} ${resolved.target} ${specifier} ${isTypeOnly} ${resolved.resolution}`;
        const existing = edgeByKey.get(key);
        if (existing === undefined) {
            edgeByKey.set(key, {from, to: resolved.target, specifier, isTypeOnly, resolution: resolved.resolution, evidence: [evidence]});
        } else {
            addEvidence(existing.evidence, evidence);
        }
    }

    const edges = [...edgeByKey.values()];
    for (const edge of edges) {
        edge.evidence.sort(compareEvidence);
    }
    const unresolved = [...unresolvedByKey.values()];
    for (const entry of unresolved) {
        entry.evidence.sort(compareEvidence);
    }

    return {
        nodes: [...analyzedFiles].sort((a, b) => a.localeCompare(b)),
        edges: edges.sort(compareEdges),
        unresolved: unresolved.sort(compareUnresolved)
    };
};

/**
 * The Phase-0 view the existing `DependencyCycleRule` consumes: a plain
 * adjacency map seeded with EVERY node (so isolated files are present, exactly
 * as the rule's own former graph was), containing only `relative`, NON-type-only
 * edges, with self-edges excluded. This encodes decision D1-a in one place -- it
 * reproduces precisely the edge set the rule computed before (relative-resolved,
 * type-only skipped, self-import ignored), so cycle findings are byte-identical.
 */
export const cycleAdjacency = (graph: ModuleGraph): Map<string, Set<string>> => {
    const adjacency = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
        adjacency.set(node, new Set<string>());
    }
    for (const edge of graph.edges) {
        if (edge.resolution !== 'relative' || edge.isTypeOnly || edge.from === edge.to) {
            continue;
        }
        adjacency.get(edge.from)?.add(edge.to);
    }
    return adjacency;
};
