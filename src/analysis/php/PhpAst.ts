import type {SourceRange} from '../../Types.js';

/**
 * Minimal structural view of a glayzzle php-parser node. We keep this local and
 * permissive rather than depending on the parser's full AST typings.
 */
export interface PhpNode {
    kind: string;
    loc?: {start: {line: number; column: number}; end: {line: number; column: number}};
    [key: string]: unknown;
}

/** The node kinds that are functions of their own: the boundary of an enclosing function's body. */
export const FUNCTION_LIKE: ReadonlySet<string> = new Set(['function', 'method', 'closure', 'arrowfunc']);

export const isPhpNode = (value: unknown): value is PhpNode => {
    return typeof value === 'object' && value !== null && typeof (value as PhpNode).kind === 'string';
};

export const childNodes = (node: PhpNode): PhpNode[] => {
    const children: PhpNode[] = [];
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') {
            continue;
        }
        if (isPhpNode(value)) {
            children.push(value);
        } else if (Array.isArray(value)) {
            for (const entry of value) {
                if (isPhpNode(entry)) {
                    children.push(entry);
                }
            }
        }
    }
    return children;
};

export const collect = (root: PhpNode, predicate: (node: PhpNode) => boolean): PhpNode[] => {
    const found: PhpNode[] = [];
    const walk = (node: PhpNode): void => {
        if (predicate(node)) {
            found.push(node);
        }
        for (const child of childNodes(node)) {
            walk(child);
        }
    };
    walk(root);
    return found;
};

export const rangeOf = (node: PhpNode): SourceRange => {
    const loc = node.loc;
    if (loc === undefined) {
        return {startLine: 1, startCol: 0, endLine: 1, endCol: 0};
    }
    return {startLine: loc.start.line, startCol: loc.start.column, endLine: loc.end.line, endCol: loc.end.column};
};
