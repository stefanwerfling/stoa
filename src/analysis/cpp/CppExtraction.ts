import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {factBuilder, type AdapterInfo} from '../FactBuilder.js';

/**
 * Extracts the language-neutral fact set from a C or C++ source tree, mirroring
 * the other adapters: per-function complexity metrics and (C++ only) per-catch
 * error-handling signals. Parsing is tree-sitter (web-tree-sitter, in-process
 * WASM). The node types used are shared by the C and C++ grammars, so one
 * extraction serves both; C simply has no try/catch or classes.
 */

const RATIONALE_MARKER = 'stoa:allow-complexity';

const DECISION_TYPES: ReadonlySet<string> = new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'case_statement', 'catch_clause', 'conditional_expression']);
const NESTING_TYPES: ReadonlySet<string> = new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement', 'catch_clause', 'conditional_expression']);
// Nested functions and C++ lambdas reset the metric scope.
const FUNCTION_BOUNDARY: ReadonlySet<string> = new Set(['function_definition', 'lambda_expression']);
// C/C++ clock/RNG built-ins (compared by the trailing name, so std::rand matches).
const NONDETERMINISTIC: ReadonlySet<string> = new Set(['rand', 'srand', 'random', 'time', 'clock']);

interface MetricState {
    cyclomatic: number;
    cognitive: number;
    maxNesting: number;
}

export const extractFacts = (root: Node, content: string, filePath: string, info: AdapterInfo): Fact[] => {
    const facts: Fact[] = [];
    const build = factBuilder(info, filePath);
    const lines = content.split('\n');

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(lines), value: lineCount(content)}));

    for (const fn of descendants(root, 'function_definition')) {
        const body = fn.childForFieldName('body');
        if (body === null || body.type !== 'compound_statement') {
            continue;
        }
        const declarator = descendants(fn, 'function_declarator')[0];
        if (declarator === undefined) {
            continue;
        }
        const kindOf: SubjectKind = hasAncestorType(fn, 'field_declaration_list') ? 'method' : 'function';
        const symbol = functionName(declarator);
        const range = rangeOf(fn);
        const metrics = computeMetrics(body);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, range, value: metrics.maxNesting}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, range, value: parameterCount(declarator)}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, range, value: range.endLine - range.startLine + 1}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, range, value: leadingHasMarker(lines, range.startLine)}));
        facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, range, value: usesNondeterminism(body)}));
    }

    descendants(root, 'catch_clause').forEach((clause, index) => {
        const block = clause.childForFieldName('body');
        const statements = block === null ? 0 : namedChildren(block).length;
        const hasThrow = block !== null && ownDescendants(block, 'throw_statement').length > 0;
        const hasCall = block !== null && ownDescendants(block, 'call_expression').length > 0;
        const symbol = `catch#${index}`;
        const range = rangeOf(block ?? clause);

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', symbol, range, value: statements === 0}));
        facts.push(build({kind: 'ast.catchSwallowsError', kindOf: 'catch-clause', symbol, range, value: !hasThrow && !hasCall}));
    });

    return facts;
};

const descendants = (node: Node, types: string | string[]): Node[] => {
    return node.descendantsOfType(types).filter((candidate): candidate is Node => candidate !== null);
};

// Like descendants(), but does not cross into nested functions or lambdas, so a
// call/throw inside a lambda is not attributed to the enclosing function.
const ownDescendants = (root: Node, type: string): Node[] => {
    const found: Node[] = [];
    const walk = (node: Node): void => {
        for (const child of namedChildren(node)) {
            if (FUNCTION_BOUNDARY.has(child.type)) {
                continue;
            }
            if (child.type === type) {
                found.push(child);
            }
            walk(child);
        }
    };
    walk(root);
    return found;
};

const namedChildren = (node: Node): Node[] => {
    const children: Node[] = [];
    for (let index = 0; index < node.namedChildCount; index += 1) {
        const child = node.namedChild(index);
        if (child !== null) {
            children.push(child);
        }
    }
    return children;
};

const hasAncestorType = (node: Node, type: string): boolean => {
    let current = node.parent;
    while (current !== null) {
        if (current.type === type) {
            return true;
        }
        current = current.parent;
    }
    return false;
};

const functionName = (declarator: Node): string => {
    return declarator.childForFieldName('declarator')?.text ?? '(anonymous)';
};

const parameterCount = (declarator: Node): number => {
    const list = declarator.childForFieldName('parameters');
    return list === null ? 0 : descendants(list, 'parameter_declaration').length;
};

const computeMetrics = (body: Node): MetricState => {
    const state: MetricState = {cyclomatic: 1, cognitive: 0, maxNesting: 0};
    visit(body, 0, state);
    return state;
};

const visit = (node: Node, nesting: number, state: MetricState): void => {
    for (const child of namedChildren(node)) {
        if (FUNCTION_BOUNDARY.has(child.type)) {
            continue;
        }
        if (DECISION_TYPES.has(child.type)) {
            state.cyclomatic += 1;
        }
        if (isLogical(child)) {
            state.cyclomatic += 1;
            state.cognitive += 1;
        }
        const isNesting = NESTING_TYPES.has(child.type);
        if (isNesting) {
            state.cognitive += 1 + nesting;
        }
        const childNesting = isNesting ? nesting + 1 : nesting;
        if (childNesting > state.maxNesting) {
            state.maxNesting = childNesting;
        }
        visit(child, childNesting, state);
    }
};

const isLogical = (node: Node): boolean => {
    if (node.type !== 'binary_expression') {
        return false;
    }
    const operator = node.childForFieldName('operator')?.text;
    return operator === '&&' || operator === '||';
};

const usesNondeterminism = (body: Node): boolean => {
    // Only calls in THIS function body count — not calls nested in a lambda.
    return ownDescendants(body, 'call_expression').some((call) => {
        const callee = call.childForFieldName('function');
        if (callee === null) {
            return false;
        }
        const name = callee.text.split('::').pop() ?? callee.text;
        return NONDETERMINISTIC.has(name);
    });
};

const rangeOf = (node: Node): SourceRange => {
    return {
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column
    };
};

const fileRange = (lines: string[]): SourceRange => {
    return {startLine: 1, startCol: 0, endLine: Math.max(lines.length, 1), endCol: 0};
};

const lineCount = (content: string): number => {
    if (content.length === 0) {
        return 0;
    }
    return content.split('\n').length;
};

const leadingHasMarker = (lines: string[], startLine: number): boolean => {
    for (let index = startLine - 2; index >= 0; index -= 1) {
        const text = (lines[index] ?? '').trim();
        if (text.length === 0) {
            continue;
        }
        const isComment = text.startsWith('//') || text.startsWith('*') || text.startsWith('/*') || text.endsWith('*/');
        if (!isComment) {
            return false;
        }
        if (text.includes(RATIONALE_MARKER)) {
            return true;
        }
    }
    return false;
};
