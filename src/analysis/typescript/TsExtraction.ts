import {Node, SyntaxKind} from 'ts-morph';
import type {SourceFile} from 'ts-morph';
import type {Fact, FactValue, SourceRange, SubjectKind} from '../../Types.js';

export interface AdapterInfo {
    id: string;
    version: string;
}

interface FunctionMetrics {
    cyclomatic: number;
    cognitive: number;
    nestingDepth: number;
    parameterCount: number;
    lineCount: number;
}

const FUNCTION_LIKE_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration,
    SyntaxKind.Constructor,
    SyntaxKind.GetAccessor,
    SyntaxKind.SetAccessor
]);

// Structures that add cognitive load and increase nesting depth.
const NESTING_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.IfStatement,
    SyntaxKind.ForStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
    SyntaxKind.SwitchStatement,
    SyntaxKind.CatchClause,
    SyntaxKind.ConditionalExpression
]);

// Decision points for cyclomatic complexity (switch counts its case clauses).
const CYCLOMATIC_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.IfStatement,
    SyntaxKind.ForStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
    SyntaxKind.CaseClause,
    SyntaxKind.CatchClause,
    SyntaxKind.ConditionalExpression
]);

const LOGICAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.AmpersandAmpersandToken,
    SyntaxKind.BarBarToken,
    SyntaxKind.QuestionQuestionToken
]);

/**
 * Extracts the M2 fact set from a parsed source file: per-function complexity
 * metrics, per-catch error-handling signals, per-import dependency facts and the
 * file line count. Facts are emitted in source order, so the output is
 * deterministic. The cognitive-complexity figure is a documented approximation
 * of the SonarSource metric (nesting-weighted structures plus flat increments
 * for logical-operator occurrences), intended as a signal, not a verdict.
 */
export const extractFacts = (sourceFile: SourceFile, info: AdapterInfo): Fact[] => {
    const facts: Fact[] = [];
    const filePath = sourceFile.getFilePath();

    facts.push(buildFact(info, filePath, 'file.lineCount', 'file', undefined, fileRange(sourceFile), lineCount(sourceFile)));

    for (const fn of functionLikeNodes(sourceFile)) {
        const body = functionBody(fn);
        if (body === undefined) {
            continue;
        }

        const metrics = computeMetrics(fn, body);
        const name = functionName(fn);
        const kindOf = subjectKindOf(fn);
        const range = rangeOf(sourceFile, fn);

        facts.push(buildFact(info, filePath, 'metric.cyclomaticComplexity', kindOf, name, range, metrics.cyclomatic));
        facts.push(buildFact(info, filePath, 'metric.cognitiveComplexity', kindOf, name, range, metrics.cognitive));
        facts.push(buildFact(info, filePath, 'metric.nestingDepth', kindOf, name, range, metrics.nestingDepth));
        facts.push(buildFact(info, filePath, 'metric.parameterCount', kindOf, name, range, metrics.parameterCount));
        facts.push(buildFact(info, filePath, 'metric.functionLength', kindOf, name, range, metrics.lineCount));
    }

    sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause).forEach((clause, index) => {
        const block = clause.getBlock();
        const statements = block.getStatements();
        const empty = statements.length === 0;
        const hasThrow = block.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0;
        const hasCall = block.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0;
        const range = rangeOf(sourceFile, clause);

        facts.push(buildFact(info, filePath, 'ast.emptyCatch', 'catch-clause', `catch#${index}`, range, empty));
        facts.push(
            buildFact(info, filePath, 'ast.catchSwallowsError', 'catch-clause', `catch#${index}`, range, !hasThrow && !hasCall)
        );
    });

    sourceFile.getImportDeclarations().forEach((decl, index) => {
        const value: FactValue = {
            module: decl.getModuleSpecifierValue(),
            isTypeOnly: decl.isTypeOnly()
        };
        facts.push(buildFact(info, filePath, 'deps.import', 'import', `import#${index}`, rangeOf(sourceFile, decl), value));
    });

    return facts;
};

const functionLikeNodes = (sourceFile: SourceFile): Node[] => {
    const nodes: Node[] = [];
    sourceFile.forEachDescendant((node) => {
        if (FUNCTION_LIKE_KINDS.has(node.getKind())) {
            nodes.push(node);
        }
    });
    return nodes;
};

const computeMetrics = (fn: Node, body: Node): FunctionMetrics => {
    const state = {cyclomatic: 1, cognitive: 0, maxNesting: 0};
    visit(body, 0, state);

    return {
        cyclomatic: state.cyclomatic,
        cognitive: state.cognitive,
        nestingDepth: state.maxNesting,
        parameterCount: parameterCount(fn),
        lineCount: fn.getEndLineNumber() - fn.getStartLineNumber() + 1
    };
};

interface MetricState {
    cyclomatic: number;
    cognitive: number;
    maxNesting: number;
}

const visit = (node: Node, nesting: number, state: MetricState): void => {
    node.forEachChild((child) => {
        if (FUNCTION_LIKE_KINDS.has(child.getKind())) {
            // Nested functions are measured as their own units; skip them here.
            return;
        }

        const kind = child.getKind();

        if (CYCLOMATIC_KINDS.has(kind)) {
            state.cyclomatic += 1;
        }
        if (Node.isBinaryExpression(child) && LOGICAL_OPERATORS.has(child.getOperatorToken().getKind())) {
            state.cyclomatic += 1;
            state.cognitive += 1;
        }

        const isNesting = NESTING_KINDS.has(kind);
        if (isNesting) {
            state.cognitive += 1 + nesting;
        }

        const childNesting = isNesting ? nesting + 1 : nesting;
        if (childNesting > state.maxNesting) {
            state.maxNesting = childNesting;
        }

        visit(child, childNesting, state);
    });
};

const buildFact = (
    info: AdapterInfo,
    filePath: string,
    kind: string,
    kindOf: SubjectKind,
    symbol: string | undefined,
    range: SourceRange,
    value: FactValue
): Fact => {
    const subject = symbol === undefined ? {file: filePath, kindOf, range} : {file: filePath, symbol, kindOf, range};
    return {
        id: `fact:${filePath}:${kind}:${symbol ?? 'file'}:${range.startLine}`,
        kind,
        subject,
        value,
        evidence: [{source: 'ast', detail: kind}],
        certainty: 'syntactic',
        producedBy: {adapter: info.id, version: info.version}
    };
};

const functionBody = (fn: Node): Node | undefined => {
    const holder = fn as unknown as {getBody?: () => Node | undefined};
    return holder.getBody?.();
};

const parameterCount = (fn: Node): number => {
    const holder = fn as unknown as {getParameters?: () => unknown[]};
    return holder.getParameters?.().length ?? 0;
};

const functionName = (fn: Node): string => {
    const holder = fn as unknown as {getName?: () => string | undefined};
    const name = holder.getName?.();
    if (name !== undefined && name.length > 0) {
        return name;
    }
    if (fn.getKind() === SyntaxKind.Constructor) {
        return 'constructor';
    }
    return `anonymous@${fn.getStartLineNumber()}`;
};

const subjectKindOf = (fn: Node): SubjectKind => {
    return fn.getKind() === SyntaxKind.MethodDeclaration ? 'method' : 'function';
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};

const fileRange = (sourceFile: SourceFile): SourceRange => {
    const lines = Math.max(lineCount(sourceFile), 1);
    return {startLine: 1, startCol: 0, endLine: lines, endCol: 0};
};

const lineCount = (sourceFile: SourceFile): number => {
    const text = sourceFile.getFullText();
    if (text.length === 0) {
        return 0;
    }
    return text.split('\n').length;
};
