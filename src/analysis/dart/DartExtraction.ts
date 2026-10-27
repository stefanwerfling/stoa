import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {factBuilder, type AdapterInfo} from '../FactBuilder.js';

/**
 * Extracts the language-neutral fact set from a Dart (Flutter) source tree,
 * mirroring the TypeScript and PHP adapters: per-function complexity metrics
 * and per-catch error-handling signals. Parsing is tree-sitter (web-tree-sitter,
 * in-process WASM); only facts leave this module.
 */

const RATIONALE_MARKER = 'stoa:allow-complexity';

// Branching constructs that add an independent path (cyclomatic) and, where they
// nest, cognitive load. Mirrors the PHP/TS adapters' SonarSource approximation.
const DECISION_TYPES: ReadonlySet<string> = new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'catch_clause', 'conditional_expression', 'case_builtin']);
const NESTING_TYPES: ReadonlySet<string> = new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement', 'catch_clause', 'conditional_expression']);
const LOGICAL_TYPES: ReadonlySet<string> = new Set(['logical_and_expression', 'logical_or_expression', 'if_null_expression']);
// Nested functions/closures reset the metric scope for the enclosing function.
const FUNCTION_BOUNDARY: ReadonlySet<string> = new Set(['function_expression', 'function_body']);

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

    for (const signature of descendants(root, 'function_signature')) {
        const parent = signature.parent;
        const owner = parent !== null && parent.type === 'method_signature' ? parent : signature;
        const body = owner.nextNamedSibling;
        if (body === null || body.type !== 'function_body') {
            continue;
        }
        const kindOf: SubjectKind = owner.type === 'method_signature' ? 'method' : 'function';
        const symbol = functionName(signature);
        const range = spanRange(owner, body);
        const metrics = computeMetrics(body);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, range, value: metrics.maxNesting}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, range, value: parameterCount(signature)}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, range, value: range.endLine - range.startLine + 1}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, range, value: leadingHasMarker(lines, range.startLine)}));
        facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, range, value: usesNondeterminism(body)}));
    }

    descendants(root, 'catch_clause').forEach((clause, index) => {
        const sibling = clause.nextNamedSibling;
        const block = sibling !== null && sibling.type === 'block' ? sibling : null;
        const statements = block === null ? 0 : namedChildren(block).length;
        const hasThrow = block !== null && (descendants(block, 'throw_expression').length > 0 || /\brethrow\b/.test(block.text));
        const hasCall = block !== null && descendants(block, 'arguments').length > 0;
        const symbol = `catch#${index}`;
        const range = spanRange(clause, block ?? clause);

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', symbol, range, value: statements === 0}));
        facts.push(build({kind: 'ast.catchSwallowsError', kindOf: 'catch-clause', symbol, range, value: !hasThrow && !hasCall}));
    });

    return facts;
};

const descendants = (node: Node, types: string | string[]): Node[] => {
    return node.descendantsOfType(types).filter((candidate): candidate is Node => candidate !== null);
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

const functionName = (signature: Node): string => {
    const named = signature.childForFieldName('name');
    if (named !== null) {
        return named.text;
    }
    return namedChildren(signature).find((child) => child.type === 'identifier')?.text ?? '(anonymous)';
};

const parameterCount = (signature: Node): number => {
    const list = namedChildren(signature).find((child) => child.type === 'formal_parameter_list');
    return list === undefined ? 0 : descendants(list, 'formal_parameter').length;
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
        if (LOGICAL_TYPES.has(child.type)) {
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

// Dart clock/RNG use, detected by an actual call — not a mere name. Dart models
// a call as a primary identifier followed by `selector` siblings; a selector
// carrying an argument list is the call application. We only flag:
//   Random(...) / Random.<ctor>(...)   — the RNG receiver is actually invoked
//   DateTime.now(...)                  — the clock factory is actually invoked
// A parameter/variable/type merely named `Random`, `now` or `DateTime` has no
// such call chain and is not flagged. Known limitation: a call through an
// import prefix (e.g. math.Random()) or through a variable already typed Random
// (rng.nextInt()) is not resolved — conservative (false negative, not positive).
const usesNondeterminism = (body: Node): boolean => {
    return descendants(body, 'selector').some((selector) => {
        if (!isCallSelector(selector)) {
            return false;
        }
        const parent = selector.parent;
        if (parent === null) {
            return false;
        }
        const siblings = namedChildren(parent);
        const index = siblings.findIndex((sibling) => sibling.id === selector.id);
        if (index < 1) {
            return false;
        }
        // The receiver is the primary to the left of the contiguous selector run
        // (so in `final rng = Random()` the base is `Random`, not the var `rng`).
        let baseIndex = index - 1;
        while (baseIndex >= 0 && siblings[baseIndex]?.type === 'selector') {
            baseIndex -= 1;
        }
        const base = siblings[baseIndex];
        if (base === undefined || (base.type !== 'identifier' && base.type !== 'type_identifier')) {
            return false;
        }
        const preceding = siblings[index - 1];
        if (base.text === 'Random') {
            // Random() / Random.secure() — a call is applied to the Random receiver.
            return true;
        }
        if (base.text === 'DateTime') {
            // DateTime.now() — the selector immediately before the call is `.now`.
            return preceding !== undefined && preceding.type === 'selector' && selectorName(preceding) === 'now';
        }
        return false;
    });
};

const isCallSelector = (selector: Node): boolean => {
    return descendants(selector, 'arguments').length > 0;
};

const selectorName = (selector: Node): string | null => {
    return descendants(selector, 'identifier')[0]?.text ?? null;
};

const spanRange = (from: Node, to: Node): SourceRange => {
    return {
        startLine: from.startPosition.row + 1,
        startCol: from.startPosition.column,
        endLine: to.endPosition.row + 1,
        endCol: to.endPosition.column
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
