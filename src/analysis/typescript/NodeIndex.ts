import {SyntaxKind, ts} from 'ts-morph';
import type {KindToNodeMappings, Node} from 'ts-morph';

/**
 * One file's syntax nodes indexed by kind, so the fact families no longer walk
 * the whole tree (or a function's subtree) once per question. `descendantsOfKind`
 * returns exactly what ts-morph's `node.getDescendantsOfKind(kind)` returns —
 * the same wrappers, in the same order — from one walk per file:
 *
 * - one raw compiler walk (`ts.forEachChild`, preorder) numbers every node,
 *   records where its subtree ends and lists the node numbers per kind;
 * - one `sourceFile.forEachDescendant` (the same preorder) collects the
 *   wrappers, checked node for node against the raw numbering. The
 *   descendants of any node of one kind are then a contiguous slice of that
 *   kind's numbers, found by binary search.
 *
 * Only node kinds take the index: for a token kind (Identifier, StringLiteral)
 * ts-morph walks `getChildren` (JSDoc included), which neither walk mirrors, so
 * those queries go to ts-morph unchanged — as does every query of a file whose
 * wrappers do not line up with the raw walk.
 *
 * Keyed by the compiler SourceFile: a re-parse of a path can hand back the same
 * ts-morph wrapper, but never the same compiler node.
 */
interface FileIndex {
    order: Map<ts.Node, number>;
    subtreeEnd: number[];
    numbersByKind: Map<SyntaxKind, number[]>;
    /** Wrapper per node number, or null when the walks did not line up (every query then falls back). */
    wrappers: Node[] | null;
}

const indexes = new WeakMap<ts.SourceFile, FileIndex>();

const isNodeKind = (kind: SyntaxKind): boolean => kind >= SyntaxKind.FirstNode && kind < SyntaxKind.FirstJSDocNode;

const buildIndex = (sourceFile: Node): FileIndex => {
    const order = new Map<ts.Node, number>();
    const subtreeEnd: number[] = [];
    const numbersByKind = new Map<SyntaxKind, number[]>();
    let next = 0;
    const visit = (node: ts.Node): undefined => {
        const number = next;
        next += 1;
        order.set(node, number);
        const numbers = numbersByKind.get(node.kind);
        if (numbers === undefined) {
            numbersByKind.set(node.kind, [number]);
        } else {
            numbers.push(number);
        }
        ts.forEachChild(node, visit);
        subtreeEnd[number] = next - 1;
        return undefined;
    };
    visit(sourceFile.compilerNode);
    const wrappers: Node[] = [sourceFile];
    sourceFile.forEachDescendant((node) => {
        wrappers.push(node);
    });
    const aligned = wrappers.length === next && wrappers.every((wrapper, number) => order.get(wrapper.compilerNode) === number);
    return {order, subtreeEnd, numbersByKind, wrappers: aligned ? wrappers : null};
};

const fileIndex = (node: Node): FileIndex => {
    const sourceFile = node.getSourceFile();
    const cached = indexes.get(sourceFile.compilerNode);
    if (cached !== undefined) {
        return cached;
    }
    const index = buildIndex(sourceFile);
    indexes.set(sourceFile.compilerNode, index);
    return index;
};

/** The first position in the ascending `numbers` whose value exceeds `value`. */
const upperBound = (numbers: readonly number[], value: number): number => {
    let low = 0;
    let high = numbers.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if ((numbers[middle] as number) <= value) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
};

/** The wrappers of `kind` in `node`'s subtree (the node itself excluded), or null when the index cannot answer. */
const indexedOfKind = (index: FileIndex, node: Node, kind: SyntaxKind): Array<{number: number; node: Node}> | null => {
    const number = index.order.get(node.compilerNode);
    const wrappers = index.wrappers;
    if (number === undefined || wrappers === null || !isNodeKind(kind)) {
        return null;
    }
    const numbers = index.numbersByKind.get(kind) ?? [];
    const hits: Array<{number: number; node: Node}> = [];
    const to = upperBound(numbers, index.subtreeEnd[number] as number);
    for (let at = upperBound(numbers, number); at < to; at += 1) {
        const hit = numbers[at] as number;
        hits.push({number: hit, node: wrappers[hit] as Node});
    }
    return hits;
};

/** The wrapper of a compiler node of `node`'s file, as the index holds it — undefined when the index has none for it. */
export const indexedWrapper = (node: Node, compilerNode: ts.Node): Node | undefined => {
    const index = fileIndex(node);
    const number = index.order.get(compilerNode);
    return number === undefined ? undefined : index.wrappers?.[number];
};

/** Same result as `node.getDescendantsOfKind(kind)`, from the per-file index. */
export const descendantsOfKind = <K extends SyntaxKind>(node: Node, kind: K): Array<KindToNodeMappings[K]> => {
    const hits = indexedOfKind(fileIndex(node), node, kind);
    if (hits === null) {
        return node.getDescendantsOfKind(kind);
    }
    return hits.map((hit) => hit.node) as Array<KindToNodeMappings[K]>;
};

/**
 * The descendants of `node` whose kind is in `kinds`, in preorder — the same
 * nodes, in the same order, as filtering `node.forEachDescendant` by kind.
 */
export const descendantsOfKinds = (node: Node, kinds: ReadonlySet<SyntaxKind>): Node[] => {
    const index = fileIndex(node);
    const hits: Array<{number: number; node: Node}> = [];
    for (const kind of kinds) {
        const ofKind = indexedOfKind(index, node, kind);
        if (ofKind === null) {
            return walkOfKinds(node, kinds);
        }
        for (const hit of ofKind) {
            hits.push(hit);
        }
    }
    return hits.sort((a, b) => a.number - b.number).map((hit) => hit.node);
};

const walkOfKinds = (node: Node, kinds: ReadonlySet<SyntaxKind>): Node[] => {
    const found: Node[] = [];
    node.forEachDescendant((descendant) => {
        if (kinds.has(descendant.getKind())) {
            found.push(descendant);
        }
    });
    return found;
};
