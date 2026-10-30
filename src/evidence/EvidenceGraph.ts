import type {SourceRange} from '../Types.js';

/**
 * How certain a single edge in an Evidence Graph (below) is. This is a finer
 * vocabulary than `Certainty` (src/Types.ts) — it classifies one RELATIONSHIP
 * in a traced dataflow chain, not a whole fact/finding. A `heuristic` edge
 * must never be reported as `verified`: callers building a graph decide the
 * status explicitly per edge, there is no default.
 *
 * - `verified`:   a direct, same-function AST relationship (e.g. the tracked
 *                 value is literally the argument of a call).
 * - `heuristic`:  the relationship crosses a boundary where identity is
 *                 inferred, not type-proven (e.g. a one-hop cross-function
 *                 trace via positional parameter matching).
 * - `unresolved`: Stoa found something relevant (e.g. a persistence-looking
 *                 call) but could not establish the relationship (the callee
 *                 is not resolvable to a declaration in the analyzed file,
 *                 a dynamic/computed call, …).
 * - `missing`:    the expected relationship was looked for and is simply not
 *                 there (e.g. no validator invocation found at all).
 */
export type EvidenceStatus = 'verified' | 'heuristic' | 'unresolved' | 'missing';

export type EvidenceNodeKind =
    | 'request-source'
    | 'input-value'
    | 'validation-schema'
    | 'validator-invocation'
    | 'validation-result'
    | 'validated-value'
    | 'function'
    | 'service'
    | 'repository'
    | 'persistence-sink';

export type EvidenceEdgeKind =
    | 'receives'
    | 'validates'
    | 'returns'
    | 'assigns'
    | 'passes-to'
    | 'transforms'
    | 'persists'
    | 'bypasses';

/** A node in a traced validation dataflow chain. `id` is unique within one graph only. */
export interface EvidenceNode {
    id: string;
    kind: EvidenceNodeKind;
    label: string;
    file: string;
    range: SourceRange;
}

/**
 * One traced relationship between two graph nodes. `basis` is a short,
 * human-readable statement of WHY Stoa believes this edge holds (the
 * concrete AST shape it matched) — every edge must be traceable back to a
 * specific piece of code, not just asserted.
 */
export interface EvidenceEdge {
    from: string;
    to: string;
    kind: EvidenceEdgeKind;
    file: string;
    range: SourceRange;
    basis: string;
    status: EvidenceStatus;
    /** Present when status is not `verified` — what, specifically, keeps this from being proven. */
    limits?: string[];
}

export interface EvidenceGraph {
    nodes: EvidenceNode[];
    edges: EvidenceEdge[];
}
