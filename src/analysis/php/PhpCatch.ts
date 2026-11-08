import {childNodes, collect, FUNCTION_LIKE, isPhpNode, type PhpNode} from './PhpAst.js';

/**
 * Each catch clause's scope: the innermost function, method, closure or arrow
 * function around it, or the program for script-level code.
 */
export const catchScopes = (program: PhpNode): Map<PhpNode, PhpNode> => {
    const scopes = new Map<PhpNode, PhpNode>();
    const walk = (node: PhpNode, scope: PhpNode): void => {
        for (const child of childNodes(node)) {
            if (child.kind === 'catch') {
                scopes.set(child, scope);
            }
            walk(child, FUNCTION_LIKE.has(child.kind) ? child : scope);
        }
    };
    walk(program, program);
    return scopes;
};

/**
 * Whether a catch clause swallows its error (`ast.catchSwallowsError`): it
 * neither throws, calls anything, nor reads the bound `$e`. A read hands the
 * error on — inside the catch (`$last = $e`, passed, returned), or after it
 * in the same scope: a PHP catch variable outlives the catch, so a retry loop
 * with `catch (\Exception $error) {}` and a `throw $error;` after the last
 * attempt does not swallow it. The target of a plain `$e = …` is a write, not
 * a read. A fallback without a read (`return null;`, `$x = false;`) still
 * swallows — a comment in the catch documents such a case. Mirrors the
 * TypeScript adapter (where the binding ends with the catch). `scope` is the
 * clause's scope (`catchScopes`).
 */
export const catchSwallowsError = (clause: PhpNode, scope: PhpNode): boolean => {
    const body = clause.body;
    if (!isPhpNode(body)) {
        return true;
    }
    const children = (body.children as unknown[] | undefined) ?? [];
    if (children.length > 0 && exists(body, (node) => node.kind === 'throw' || node.kind === 'call')) {
        return false;
    }
    const bound = variableName(clause.variable);
    if (bound === null) {
        return true;
    }
    const bodyWrites = writeTargets(body);
    return !exists(body, (node) => variableName(node) === bound && !bodyWrites.has(node)) && !readAfter(clause, scope, bound);
};

/** Whether `scope` reads `$name` after `clause` ends. */
const readAfter = (clause: PhpNode, scope: PhpNode, name: string): boolean => {
    if (clause.loc === undefined) {
        return false;
    }
    const end = clause.loc.end;
    const writes = writeTargets(scope);
    return exists(scope, (node) => {
        const start = node.loc?.start;
        return variableName(node) === name && start !== undefined && (start.line > end.line || (start.line === end.line && start.column >= end.column)) && !writes.has(node);
    });
};

/** A plain variable's name (`$x` → `x`); `$this` and variable variables are none. */
const variableName = (node: unknown): string | null => {
    if (!isPhpNode(node) || node.kind !== 'variable' || typeof node.name !== 'string' || node.name === 'this') {
        return null;
    }
    return node.name;
};

/** The targets of plain `=` assignments within `root` — writes, not reads. */
const writeTargets = (root: PhpNode): Set<unknown> => new Set(collect(root, (node) => node.kind === 'assign' && node.operator === '=').map((assign) => assign.left));

const exists = (root: PhpNode, predicate: (node: PhpNode) => boolean): boolean => collect(root, predicate).length > 0;
