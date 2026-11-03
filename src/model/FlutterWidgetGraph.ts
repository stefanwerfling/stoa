import type {Fact, SourceRange} from '../Types.js';
import {decodeWidgetTree, type WidgetNodeKind, type WidgetNodeStatus, type WidgetTreeValue} from '../analysis/dart/FlutterWidgets.js';
import type {DartDirectiveValue, DartTypeDeclValue} from '../analysis/dart/DartDeclarations.js';

/**
 * The project-wide Flutter widget graph (Phase 1 of the Flutter analysis).
 * Same discipline as ModuleGraph/SymbolGraph: built ONCE per analysis, after
 * fact extraction, purely from facts — `ui.flutterWidgetTree` (structure, one
 * per function), `dart.classDecl` and `dart.importSpec` (identity). It holds
 * strings, numbers and fact ids only (no AST, no fact copy), is handed to
 * project rules via `ProjectRuleInput.flutterWidgetGraph`, and is not part of
 * `AnalysisResult`. No rule reads it yet.
 *
 * Uncertainty is explicit, never collapsed:
 * - `status` says how well the STRUCTURE at a node is known (`known`,
 *   `dynamic` for references/unmodelled expressions, `unparsed` where
 *   tree-sitter-dart could not parse — e.g. Dart 3 syntax);
 * - `identity` says how well a widget's TYPE is known (see WidgetIdentity).
 */

export type WidgetEdgeKind = 'child' | 'children' | 'slot' | 'branch' | 'repeat' | 'element' | 'builds' | 'return';

/**
 * What a widget name refers to, decided per file from `dart.classDecl` +
 * `dart.importSpec` facts — never from the name alone:
 * - `verified` / `local`: a class/mixin/enum of that name is declared in the
 *   same file (Dart: a local declaration shadows every import).
 * - `heuristic` / `import`: the name is not declared locally but at least one
 *   import could provide it (prefix matches, show/hide permit it);
 *   `candidates` lists those import URIs. Which one actually exports it is not
 *   resolved here (no cross-file library index yet), so a Flutter class is
 *   never `verified`.
 * - `unresolved`: no local declaration and no import that could provide it
 *   (e.g. an undeclared prefix, a `show` list excluding it, a `part` file).
 */
export interface WidgetIdentity {
    status: 'verified' | 'heuristic' | 'unresolved';
    source: 'local' | 'import' | null;
    candidates: string[];
}

export interface WidgetNode {
    /** Stable, position-independent within its function: `<file>#<function>@<line>/r<root>/<label>[<index>]/…`. */
    id: string;
    file: string;
    /** The function/method whose body contains this node. */
    owner: string;
    /** The `ui.flutterWidgetTree` fact this node came from (evidence). */
    factId: string;
    range: SourceRange;
    kind: WidgetNodeKind;
    name: string | null;
    prefix: string | null;
    constructorName: string | null;
    /** Named arguments written on a widget (or a builder's parameter names). */
    argNames: readonly string[];
    status: WidgetNodeStatus;
    /** Set for `widget` nodes only. */
    identity: WidgetIdentity | null;
}

export interface WidgetEdge {
    parent: string;
    child: string;
    kind: WidgetEdgeKind;
    /** The slot name (`child`, `appBar`, `itemBuilder`, …) or `then`/`else`/`body`/`element`/`return`. */
    label: string;
    /** Position within a list-valued slot or among a builder's returns; null when not positional. */
    index: number | null;
}

export interface FlutterWidgetGraph {
    nodes: readonly WidgetNode[];
    edges: readonly WidgetEdge[];
    /** Root node ids (widget expressions not nested in another widget's slot), sorted. */
    roots: readonly string[];
    /** Functions whose tree hit the per-function node cap (`truncated`) — incomplete, not silently cut. */
    truncatedOwners: readonly string[];
}

export const EMPTY_FLUTTER_WIDGET_GRAPH: FlutterWidgetGraph = {nodes: [], edges: [], roots: [], truncatedOwners: []};

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds the graph from the fact set. Deterministic: depends only on the facts
 * (not their order) — nodes, edges and roots are sorted by id.
 */
export const buildFlutterWidgetGraph = (facts: readonly Fact[]): FlutterWidgetGraph => {
    const declaredByFile = new Map<string, Set<string>>();
    const directivesByFile = new Map<string, DartDirectiveValue[]>();
    const trees: Fact[] = [];
    for (const fact of facts) {
        if (fact.kind === 'ui.flutterWidgetTree') {
            trees.push(fact);
        } else if (fact.kind === 'dart.classDecl') {
            const names = declaredByFile.get(fact.subject.file) ?? new Set<string>();
            names.add((fact.value as unknown as DartTypeDeclValue).name);
            declaredByFile.set(fact.subject.file, names);
        } else if (fact.kind === 'dart.importSpec') {
            const directives = directivesByFile.get(fact.subject.file) ?? [];
            directives.push(fact.value as unknown as DartDirectiveValue);
            directivesByFile.set(fact.subject.file, directives);
        }
    }
    if (trees.length === 0) {
        return EMPTY_FLUTTER_WIDGET_GRAPH;
    }

    const nodes: WidgetNode[] = [];
    const edges: WidgetEdge[] = [];
    const roots: string[] = [];
    const truncatedOwners: string[] = [];

    for (const fact of trees) {
        const file = fact.subject.file;
        const owner = `${fact.subject.symbol ?? '(anonymous)'}@${fact.subject.range.startLine}`;
        const value = fact.value as unknown as WidgetTreeValue;
        if (value.truncated) {
            truncatedOwners.push(`${file}#${owner}`);
        }
        const decoded = decodeWidgetTree(value);
        const ids: string[] = [];
        let rootIndex = 0;
        decoded.forEach((node, index) => {
            const parentId = node.parent >= 0 ? ids[node.parent] : undefined;
            const step = node.label === null ? `r${rootIndex}` : `${node.label}${node.index >= 0 ? `[${node.index}]` : ''}`;
            const id = parentId === undefined ? `${file}#${owner}/${step}` : `${parentId}/${step}`;
            ids[index] = id;
            if (parentId === undefined) {
                rootIndex += 1;
                roots.push(id);
            } else {
                edges.push({parent: parentId, child: id, kind: edgeKind(decoded[node.parent]?.kind, node.label ?? ''), label: node.label ?? '', index: node.index >= 0 ? node.index : null});
            }
            nodes.push({
                id,
                file,
                owner,
                factId: fact.id,
                range: {startLine: node.startLine, startCol: node.startCol, endLine: node.endLine, endCol: node.endCol},
                kind: node.kind,
                name: node.name,
                prefix: node.prefix,
                constructorName: node.constructorName,
                argNames: node.argNames,
                status: node.status,
                identity: node.kind === 'widget' && node.name !== null ? identityOf(node.name, node.prefix, declaredByFile.get(file), directivesByFile.get(file) ?? []) : null
            });
        });
    }

    return {
        nodes: nodes.sort((a, b) => compareText(a.id, b.id)),
        edges: edges.sort((a, b) => compareText(a.parent, b.parent) || compareText(a.child, b.child)),
        roots: roots.sort(compareText),
        truncatedOwners: truncatedOwners.sort(compareText)
    };
};

const edgeKind = (parentKind: WidgetNodeKind | undefined, label: string): WidgetEdgeKind => {
    switch (parentKind) {
        case 'conditional':
            return 'branch';
        case 'repeat':
            return 'repeat';
        case 'spread':
        case 'list':
            return 'element';
        case 'builder':
            return 'return';
        case 'reference':
            return 'builds';
        default:
            if (label === 'child' || label === 'children') {
                return label;
            }
            return /builder$/i.test(label) ? 'builds' : 'slot';
    }
};

const identityOf = (name: string, prefix: string | null, declared: ReadonlySet<string> | undefined, directives: readonly DartDirectiveValue[]): WidgetIdentity => {
    if (prefix === null && declared?.has(name) === true) {
        return {status: 'verified', source: 'local', candidates: []};
    }
    const candidates = directives
        .filter((directive) => directive.kind === 'import' && directive.uri !== null && directive.prefix === prefix)
        .filter((directive) => (directive.show.length === 0 || directive.show.includes(name)) && !directive.hide.includes(name))
        .map((directive) => directive.uri as string);
    const unique = [...new Set(candidates)].sort(compareText);
    return unique.length === 0 ? {status: 'unresolved', source: null, candidates: []} : {status: 'heuristic', source: 'import', candidates: unique};
};
