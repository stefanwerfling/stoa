import {Node, SyntaxKind} from 'ts-morph';
import {isSameBinding, tracksBinding} from './SymbolResolution.js';

/**
 * Whether a `const result = schema.safeParse(...)` result is PROVABLY
 * checked before its `.data` is used — not just that `.data` is ACCESSED
 * somewhere. `.safeParse()` returns `{success: true, data} | {success:
 * false, error}`; accessing `.data` without a proven `result.success`
 * check is a real defect (`data` may not exist on the failure variant).
 *
 * Four states, named after the distinct facts a caller might want
 * (`est Validierung wurde ausgeführt` vs `Erfolgspfad wurde geprüft` vs
 * `Fehlerpfad wird sicher abgewiesen` vs `kann nicht entschieden
 * werden`) — intentionally only FOUR flat states, not a second parallel
 * status system: each maps directly onto the existing `EvidenceStatus`
 * (`verified` for the first two, `unresolved` for the last two) when a
 * caller builds an Evidence Graph edge from this result; the finer label
 * stays in the human-readable evidence, not as a second enum callers must
 * also branch on.
 *
 * - `success-guard-verified`: the access is lexically INSIDE a positive
 *   `if (result.success) { … }` branch (possibly ANDed with other
 *   conditions — an AND only narrows when the branch is entered, it never
 *   widens it).
 * - `failure-path-rejected`: an earlier `if (!result.success) { throw/return/… }`
 *   (possibly ORed with other reject conditions — an OR only widens when
 *   the throw triggers, it never narrows it) unconditionally terminates,
 *   so code reachable afterward in the same block is proven to run only
 *   when `result.success` was true.
 * - `success-guard-missing`: nothing in `scope` references
 *   `result`/`result.success` at all before the access — Stoa must not
 *   assume safety just because SOME unrelated condition happens to exist
 *   nearby.
 * - `success-guard-unresolved`: something DOES reference `result.success`
 *   (an AND-combined reject condition, an OR-combined accept condition, a
 *   non-terminating "reject" branch, …) but not in a shape Stoa can prove
 *   sound — reported as unresolved rather than guessed at either way.
 */
export type SafeParseGuardStatus = 'success-guard-verified' | 'failure-path-rejected' | 'success-guard-missing' | 'success-guard-unresolved';

export interface SafeParseGuardResult {
    status: SafeParseGuardStatus;
    /** 'verified' for the two positive guard shapes, 'unresolved' for the
     *  other two — the mapping onto the Evidence Graph's existing status
     *  vocabulary (src/evidence/EvidenceGraph.ts), so callers never need a
     *  second status system to branch on. */
    evidenceStatus: 'verified' | 'unresolved';
    basis: string;
}

const TERMINATING_KINDS: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.ThrowStatement, SyntaxKind.ReturnStatement, SyntaxKind.BreakStatement, SyntaxKind.ContinueStatement]);

// Whether `statement` (an if-branch's body, braced or not) unconditionally
// terminates the enclosing control flow at its TOP level — a throw/return/
// break/continue as the branch's own last statement. A terminator nested
// inside a further conditional (`if (x) { if (y) throw; }`) is NOT counted:
// that throw does not always fire, so it does not prove the outer branch
// always terminates.
const terminatesUnconditionally = (statement: Node): boolean => {
    if (TERMINATING_KINDS.has(statement.getKind())) {
        return true;
    }
    if (Node.isBlock(statement)) {
        const last = statement.getStatements().at(-1);
        return last !== undefined && TERMINATING_KINDS.has(last.getKind());
    }
    return false;
};

// Whether `success` is the whole of `condition`, a direct `result.success`
// property access tracking `resultDeclaration`'s binding (negated when
// `negate` is true, matching `!result.success`), possibly combined with
// OTHER terms via `combinator` ('&&' narrows the branch further — still
// sound to treat the named check as decisive; '||' widens it — also still
// sound, since ANY disjunct being true already guarantees the outcome).
const referencesSuccess = (condition: Node, resultDeclaration: Node, negate: boolean, combinator: '&&' | '||'): boolean => {
    if (negate && Node.isPrefixUnaryExpression(condition) && condition.getOperatorToken() === SyntaxKind.ExclamationToken) {
        return referencesSuccess(condition.getOperand(), resultDeclaration, false, combinator);
    }
    if (!negate && Node.isPropertyAccessExpression(condition) && condition.getName() === 'success') {
        return tracksBinding(condition.getExpression(), resultDeclaration, resultDeclaration.getSourceFile());
    }
    if (Node.isBinaryExpression(condition) && condition.getOperatorToken().getText() === combinator) {
        return referencesSuccess(condition.getLeft(), resultDeclaration, negate, combinator) || referencesSuccess(condition.getRight(), resultDeclaration, negate, combinator);
    }
    if (Node.isParenthesizedExpression(condition)) {
        return referencesSuccess(condition.getExpression(), resultDeclaration, negate, combinator);
    }
    return false;
};

// Whether `result.success`/`!result.success` is MENTIONED anywhere in
// `condition` at all (regardless of combinator soundness) — used only to
// distinguish "missing" (nothing related exists) from "unresolved"
// (something related exists, just not in a provably sound shape).
const mentionsSuccess = (condition: Node, resultDeclaration: Node): boolean => {
    for (const access of condition.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (access.getName() === 'success' && isSameBinding(access.getExpression(), resultDeclaration)) {
            return true;
        }
    }
    return Node.isPropertyAccessExpression(condition) && condition.getName() === 'success' && isSameBinding(condition.getExpression(), resultDeclaration);
};

/**
 * Determines whether `accessSite` (a `.data` property access, or the
 * destructured name node for `const { data } = result`) is provably
 * reached only after `resultDeclaration`'s `.success` was checked,
 * scanning every `IfStatement` in `scope`.
 */
export const verifySafeParseGuard = (resultDeclaration: Node, accessSite: Node, scope: Node): SafeParseGuardResult => {
    let mentionedButUnsound = false;

    for (const ifStatement of scope.getDescendantsOfKind(SyntaxKind.IfStatement)) {
        const condition = ifStatement.getExpression();

        // Nested-if idiom: `if (result.success) { …accessSite… }` (success,
        // ANDed with anything else) — the access must be a descendant of
        // the THEN branch specifically.
        const thenStatement = ifStatement.getThenStatement();
        if (isDescendantOf(accessSite, thenStatement) && referencesSuccess(condition, resultDeclaration, false, '&&')) {
            return {status: 'success-guard-verified', evidenceStatus: 'verified', basis: `reached only inside \`if (${condition.getText()})\``};
        }

        // Early-exit idiom: `if (!result.success) { throw/return/…; }`
        // (negated success, ORed with anything else) terminating
        // unconditionally, with accessSite positioned AFTER this statement
        // in an enclosing block (so it is only reached once the branch was
        // NOT taken, i.e. success was true).
        if (referencesSuccess(condition, resultDeclaration, true, '||') && terminatesUnconditionally(thenStatement) && isAfterInEnclosingBlock(accessSite, ifStatement)) {
            return {status: 'failure-path-rejected', evidenceStatus: 'verified', basis: `\`if (${condition.getText()})\` unconditionally ${thenStatement.getKindName() === 'Block' ? 'terminates' : thenStatement.getText()}`};
        }

        if (mentionsSuccess(condition, resultDeclaration)) {
            mentionedButUnsound = true;
        }
    }

    if (mentionedButUnsound) {
        return {status: 'success-guard-unresolved', evidenceStatus: 'unresolved', basis: `a condition references \`${resultDeclaration.getText()}.success\`, but not in a provably sound shape (e.g. AND-combined with a reject, OR-combined with an accept, or a branch that does not unconditionally terminate)`};
    }
    return {status: 'success-guard-missing', evidenceStatus: 'unresolved', basis: `no condition anywhere in scope checks \`${resultDeclaration.getText()}.success\` before this access`};
};

const isDescendantOf = (node: Node, ancestor: Node): boolean => {
    let current: Node | undefined = node;
    while (current !== undefined) {
        if (current === ancestor) {
            return true;
        }
        current = current.getParent();
    }
    return false;
};

// Whether `node` is positioned after `ifStatement` within a statement list
// the two share (the same block, or `node` is nested in a block that is
// itself textually after `ifStatement` at some enclosing level) — the
// simple, common "guard clause" shape; anything else (loops, gotos, `node`
// inside the if's OWN branches) is not claimed.
const isAfterInEnclosingBlock = (node: Node, ifStatement: Node): boolean => {
    if (isDescendantOf(node, ifStatement)) {
        return false;
    }
    let current: Node | undefined = node;
    while (current !== undefined) {
        const parent = current.getParent();
        if (parent !== undefined && Node.isBlock(parent) && parent === ifStatement.getParent()) {
            return current.getStart() > ifStatement.getEnd();
        }
        current = parent;
    }
    return false;
};
