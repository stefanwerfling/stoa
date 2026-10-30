import {Node, SyntaxKind} from 'ts-morph';
import type {CallExpression} from 'ts-morph';
import {tracksBinding} from './SymbolResolution.js';

const FUNCTION_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration
]);

// A small, standalone copy of BackendValidation.ts's `nearestFunction`, kept
// separate rather than imported: BOTH BackendValidation.ts and
// ValidationDataflow.ts need to import the resolver below FROM this module,
// so this module must not import anything back from either of them.
const nearestFunctionLocal = (node: Node): Node | undefined => {
    return node.getAncestors().find((ancestor) => FUNCTION_KINDS.has(ancestor.getKind()));
};

export interface OneHop {
    declaration: Node;
    label: string;
    /** The parameter's own name node — passed to `findInnerCall` for
     *  symbol-based matching, never compared by text (see SymbolResolution.ts). */
    paramNameNode: Node;
}

export const bodyOf = (decl: Node): Node | undefined => {
    if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
        return decl.getBody();
    }
    if (Node.isFunctionExpression(decl) || Node.isArrowFunction(decl)) {
        return decl.getBody();
    }
    return undefined;
};

const declarationLabelOf = (decl: Node): string => {
    if (Node.isMethodDeclaration(decl)) {
        const cls = decl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        return `${cls?.getName() ?? '(anonymous class)'}.${decl.getName()}`;
    }
    if (Node.isFunctionDeclaration(decl)) {
        return decl.getName() ?? '(anonymous function)';
    }
    return '(anonymous function)';
};

/**
 * Resolves `outer`'s callee to a function/method/arrow declared in THIS
 * file, with a plain (non-destructured) identifier parameter at the
 * position `argument` occupies — the one hop both callers of this module
 * support. Null on anything beyond that (cross-file, no declaration,
 * destructured/rest parameter, no body).
 *
 * Shared by ValidationDataflow.ts (tracing where a VALIDATED value goes)
 * and BackendValidation.ts (tracing where a RAW, unvalidated value goes) —
 * the resolution mechanics are identical; only what counts as "the tracked
 * value" and "a sink" differs per caller.
 */
export const resolveOneHop = (outer: CallExpression, argument: Node): OneHop | null => {
    const symbol = outer.getExpression().getSymbol();
    const argIndex = outer.getArguments().indexOf(argument);
    for (const decl of symbol?.getDeclarations() ?? []) {
        if (decl.getSourceFile().getFilePath() !== outer.getSourceFile().getFilePath()) {
            continue;
        }
        if (!Node.isMethodDeclaration(decl) && !Node.isFunctionDeclaration(decl) && !Node.isFunctionExpression(decl) && !Node.isArrowFunction(decl)) {
            continue;
        }
        const param = decl.getParameters()[argIndex];
        const nameNode = param?.getNameNode();
        if (nameNode === undefined || !Node.isIdentifier(nameNode)) {
            continue;
        }
        if (bodyOf(decl) === undefined) {
            continue;
        }
        return {declaration: decl, label: declarationLabelOf(decl), paramNameNode: nameNode};
    }
    return null;
};

/**
 * A call directly inside `declaration`'s own body (not a nested callback)
 * whose callee name satisfies `isSink`, fed the SAME BINDING as
 * `paramNameNode` (symbol identity via `tracksBinding` — see
 * SymbolResolution.ts, not text) as a bare identifier argument. Returns a
 * lookup function so `resolveOneHop`'s declaration can be probed for more
 * than one candidate parameter without re-walking the body each time (not
 * currently needed by either caller, but avoids an awkward two-argument
 * signature either way).
 */
export const findInnerCall = (declaration: Node, isSink: (calleeName: string) => boolean): ((paramNameNode: Node) => CallExpression | null) => {
    const body = bodyOf(declaration);
    return (paramNameNode: Node): CallExpression | null => {
        if (body === undefined) {
            return null;
        }
        for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (nearestFunctionLocal(call) !== declaration) {
                continue;
            }
            const callee = call.getExpression();
            const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : '';
            if (!isSink(name)) {
                continue;
            }
            if (call.getArguments().some((arg) => tracksBinding(arg, paramNameNode, declaration))) {
                return call;
            }
        }
        return null;
    };
};
