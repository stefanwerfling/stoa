import {Node, SyntaxKind} from 'ts-morph';
import type {ImportDeclaration, SourceFile} from 'ts-morph';
import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {factBuilder, type AdapterInfo} from '../FactBuilder.js';
import {isDeepImport} from '../ImportPath.js';

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
    const build = factBuilder(info, filePath);

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(sourceFile), value: lineCount(sourceFile)}));
    facts.push(build({kind: 'metric.exportCount', kindOf: 'file', range: fileRange(sourceFile), value: countExports(sourceFile)}));

    for (const fn of functionLikeNodes(sourceFile)) {
        const body = functionBody(fn);
        if (body === undefined) {
            continue;
        }

        const metrics = computeMetrics(fn, body);
        const symbol = functionName(fn);
        const kindOf = subjectKindOf(fn);
        const range = rangeOf(sourceFile, fn);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, range, value: metrics.nestingDepth}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, range, value: metrics.parameterCount}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, range, value: metrics.lineCount}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, range, value: hasComplexityRationale(fn)}));
        facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, range, value: usesNondeterminism(body)}));
    }

    sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause).forEach((clause, index) => {
        const block = clause.getBlock();
        const empty = block.getStatements().length === 0;
        const hasThrow = block.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0;
        const hasCall = block.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0;
        const range = rangeOf(sourceFile, clause);
        const symbol = `catch#${index}`;

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', symbol, range, value: empty}));
        facts.push(build({kind: 'ast.catchSwallowsError', kindOf: 'catch-clause', symbol, range, value: !hasThrow && !hasCall}));
    });

    const referenced = referencedIdentifiers(sourceFile);
    sourceFile.getImportDeclarations().forEach((decl, index) => {
        const module = decl.getModuleSpecifierValue();
        const range = rangeOf(sourceFile, decl);
        const symbol = `import#${index}`;
        facts.push(build({kind: 'deps.import', kindOf: 'import', symbol, range, value: {module, isTypeOnly: decl.isTypeOnly()}}));

        const names = importedNames(decl);
        if (names.length > 0 && names.every((name) => !referenced.has(name))) {
            facts.push(build({kind: 'deps.importUnused', kindOf: 'import', symbol, range, value: module}));
        }
        if (isDeepImport(module, '/')) {
            facts.push(build({kind: 'deps.importDeep', kindOf: 'import', symbol, range, value: module}));
        }
    });

    return facts;
};

// Non-deterministic APIs: their use makes a unit's output depend on wall-clock /
// RNG, which undermines reproducibility and testability (marcus.control).
const NONDETERMINISTIC_CALLS: ReadonlySet<string> = new Set(['Math.random', 'Date.now', 'performance.now']);

const usesNondeterminism = (body: Node): boolean => {
    let found = false;
    const walk = (node: Node): void => {
        node.forEachChild((child) => {
            if (FUNCTION_LIKE_KINDS.has(child.getKind())) {
                return;
            }
            if (Node.isCallExpression(child) && NONDETERMINISTIC_CALLS.has(child.getExpression().getText())) {
                found = true;
            }
            if (Node.isNewExpression(child) && child.getExpression().getText() === 'Date' && child.getArguments().length === 0) {
                found = true;
            }
            walk(child);
        });
    };
    walk(body);
    return found;
};

// Identifier texts referenced anywhere outside an import declaration.
const referencedIdentifiers = (sourceFile: SourceFile): Set<string> => {
    const names = new Set<string>();
    for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === undefined) {
            names.add(id.getText());
        }
    }
    return names;
};

const importedNames = (decl: ImportDeclaration): string[] => {
    const names: string[] = [];
    const def = decl.getDefaultImport();
    if (def !== undefined) {
        names.push(def.getText());
    }
    const ns = decl.getNamespaceImport();
    if (ns !== undefined) {
        names.push(ns.getText());
    }
    for (const named of decl.getNamedImports()) {
        names.push((named.getAliasNode() ?? named.getNameNode()).getText());
    }
    return names;
};

// Counts the module's public surface syntactically (no module resolution), so a
// file with unresolved re-exports is still counted safely.
const countExports = (sourceFile: SourceFile): number => {
    let count = 0;
    count += sourceFile.getFunctions().filter((declaration) => declaration.isExported()).length;
    count += sourceFile.getClasses().filter((declaration) => declaration.isExported()).length;
    count += sourceFile.getInterfaces().filter((declaration) => declaration.isExported()).length;
    count += sourceFile.getTypeAliases().filter((declaration) => declaration.isExported()).length;
    count += sourceFile.getEnums().filter((declaration) => declaration.isExported()).length;
    for (const statement of sourceFile.getVariableStatements()) {
        if (statement.isExported()) {
            count += statement.getDeclarations().length;
        }
    }
    for (const exportDeclaration of sourceFile.getExportDeclarations()) {
        count += exportDeclaration.getNamedExports().length; // `export {a, b}`; `export *` contributes 0
    }
    count += sourceFile.getExportAssignments().length; // `export default <expr>` / `export =`
    return count;
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

// An explicit, inline opt-out marker lets a team accept complexity it judges
// necessary — the "context beats threshold" rule in action (see docs rule-model).
const RATIONALE_MARKER = 'stoa:allow-complexity';

const hasComplexityRationale = (fn: Node): boolean => {
    return fn.getLeadingCommentRanges().some((comment) => comment.getText().includes(RATIONALE_MARKER));
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
