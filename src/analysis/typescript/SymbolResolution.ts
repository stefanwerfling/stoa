import {Node, SyntaxKind} from 'ts-morph';

/**
 * Symbol-identity helpers shared by the dataflow tracers (`ValidationDataflow.ts`,
 * `OneHopResolution.ts`) so a traced relationship is anchored to the ts-morph
 * binder's own notion of "this identifier names THIS declaration" — never to
 * matching identifier TEXT. Two different variables that merely share a
 * spelling (shadowing in a nested block, an unrelated same-named local
 * elsewhere in the function, a different parameter in a different function)
 * must never be treated as the same value just because `.getText()` agrees.
 *
 * `verified`/`heuristic` status in the Evidence Graph depends on this: a
 * same-function "verified" claim is only honest when the AST actually
 * proves identity, not when a name merely happens to recur.
 */

const symbolOf = (node: Node) => (Node.isIdentifier(node) ? node.getSymbol() : undefined);

/** Whether `a` and `b` are identifier references to the EXACT SAME declared
 *  binding (ts-morph `Symbol` identity) — immune to shadowing. */
export const isSameBinding = (a: Node, b: Node): boolean => {
    const symbolA = symbolOf(a);
    return symbolA !== undefined && symbolA === symbolOf(b);
};

const ASSIGNMENT_OPERATORS: ReadonlySet<string> = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '??=', '||=', '&&=']);

/**
 * Whether `declared`'s binding is reassigned (`=` or a compound assignment
 * operator) ANYWHERE in `scope`. Deliberately over-inclusive — a textual
 * scan of the whole scope, not a control-flow-ordered one, because
 * accurately ordering assignments against branches/loops would need a real
 * CFG this slice does not build. The safe direction: a false "maybe
 * reassigned" only costs a missed `verified`/`heuristic` match (degrades to
 * "nothing found" — no edge), it can never manufacture a false `verified`.
 */
export const isReassignedAnywhere = (declared: Node, scope: Node): boolean => {
    if (symbolOf(declared) === undefined) {
        return false;
    }
    for (const assignment of scope.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (!ASSIGNMENT_OPERATORS.has(assignment.getOperatorToken().getText())) {
            continue;
        }
        if (isSameBinding(assignment.getLeft(), declared)) {
            return true;
        }
    }
    return false;
};

/**
 * If `node` is an identifier whose OWN declaration is a plain, un-reassigned
 * `const alias = <otherIdentifier>` — a direct one-hop copy, not a
 * destructure/computation — returns that other identifier (recursively, up
 * to `depth` hops, so a short alias chain resolves too). A `let` alias is
 * never followed: it could itself be reassigned away from the tracked value
 * before `node` is reached, which `isReassignedAnywhere` would then need to
 * re-check anyway — simpler and equally safe to just not chase mutable
 * aliases at all. Returns `node` unchanged when no such alias applies.
 */
export const resolveSimpleAlias = (node: Node, depth = 5): Node => {
    if (depth <= 0 || !Node.isIdentifier(node)) {
        return node;
    }
    const symbol = symbolOf(node);
    const declaration = symbol?.getDeclarations().find((d) => Node.isVariableDeclaration(d));
    if (declaration === undefined || !Node.isVariableDeclaration(declaration)) {
        return node;
    }
    if (declaration.getVariableStatement()?.getDeclarationKind() !== 'const') {
        return node;
    }
    const initializer = declaration.getInitializer();
    if (initializer === undefined || !Node.isIdentifier(initializer)) {
        return node;
    }
    return resolveSimpleAlias(initializer, depth - 1);
};

/**
 * Whether `node` genuinely still carries the value `declared` names: either
 * the same binding directly, or reached through a bounded chain of plain
 * `const` aliases (`resolveSimpleAlias`) — in both cases ONLY if `declared`
 * is never reassigned anywhere in `scope` (a `let` that might have been
 * overwritten by code this function does not trace is not "still the
 * validated value", so this returns `false` rather than guess).
 */
export const tracksBinding = (node: Node, declared: Node, scope: Node): boolean => {
    if (isReassignedAnywhere(declared, scope)) {
        return false;
    }
    return isSameBinding(resolveSimpleAlias(node), declared);
};

/**
 * A plain object-destructuring binding for one property of `declared`
 * (`const { data } = result` / `const { data: renamed } = result`) found
 * anywhere in `scope` — the destructuring counterpart of a `.data` property
 * access. Returns the bound name's own Identifier node (`data`, or
 * `renamed`) so callers can track IT onward the same way they track any
 * other local variable. Null if no such destructuring exists, or if
 * `declared` is reassigned anywhere (same reasoning as `tracksBinding`).
 */
export const destructuredProperty = (declared: Node, propertyName: string, scope: Node): Node | null => {
    if (isReassignedAnywhere(declared, scope)) {
        return null;
    }
    for (const decl of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const nameNode = decl.getNameNode();
        const initializer = decl.getInitializer();
        if (!Node.isObjectBindingPattern(nameNode) || initializer === undefined) {
            continue;
        }
        if (!isSameBinding(initializer, declared)) {
            continue;
        }
        for (const element of nameNode.getElements()) {
            const sourceName = element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText();
            if (sourceName === propertyName) {
                const boundName = element.getNameNode();
                return Node.isIdentifier(boundName) ? boundName : null;
            }
        }
    }
    return null;
};
