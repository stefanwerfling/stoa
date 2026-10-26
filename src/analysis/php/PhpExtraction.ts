import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {factBuilder, type AdapterInfo} from '../FactBuilder.js';

/**
 * Minimal structural view of a glayzzle php-parser node. We keep this local and
 * permissive rather than depending on the parser's full AST typings.
 */
export interface PhpNode {
    kind: string;
    loc?: {start: {line: number; column: number}; end: {line: number; column: number}};
    [key: string]: unknown;
}

interface FunctionMetrics {
    cyclomatic: number;
    cognitive: number;
    nestingDepth: number;
    parameterCount: number;
    lineCount: number;
}

interface MetricState {
    cyclomatic: number;
    cognitive: number;
    maxNesting: number;
}

const FUNCTION_LIKE: ReadonlySet<string> = new Set(['function', 'method', 'closure', 'arrowfunc']);
const NESTING_KINDS: ReadonlySet<string> = new Set(['if', 'for', 'foreach', 'while', 'do', 'switch', 'catch', 'retif']);
const CYCLOMATIC_KINDS: ReadonlySet<string> = new Set(['if', 'for', 'foreach', 'while', 'do', 'case', 'catch', 'retif']);
const LOGICAL_TYPES: ReadonlySet<string> = new Set(['&&', '||', '??', 'and', 'or']);
const RATIONALE_MARKER = 'stoa:allow-complexity';

/**
 * Extracts the same fact set as the TypeScript adapter from a PHP program:
 * per-function complexity metrics, per-catch error-handling signals, per-use
 * dependency facts and the file line count. This is what makes the fact schema
 * sprachneutral — the rule engine cannot tell PHP from TypeScript. The cognitive
 * figure is the same documented approximation as the TS adapter.
 */
export const extractFacts = (program: PhpNode, content: string, filePath: string, info: AdapterInfo): Fact[] => {
    const facts: Fact[] = [];
    const build = factBuilder(info, filePath);
    const lines = content.split('\n');

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(lines), value: lineCount(content)}));

    for (const fn of collect(program, (node) => FUNCTION_LIKE.has(node.kind))) {
        const body = fn.body as PhpNode | undefined;
        if (body === undefined) {
            continue;
        }

        const metrics = computeMetrics(fn, body);
        const symbol = functionName(fn);
        const kindOf: SubjectKind = fn.kind === 'method' ? 'method' : 'function';
        const range = rangeOf(fn);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, range, value: metrics.nestingDepth}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, range, value: metrics.parameterCount}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, range, value: metrics.lineCount}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, range, value: leadingHasMarker(lines, range.startLine)}));
        facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, range, value: usesNondeterminism(body)}));
    }

    collect(program, (node) => node.kind === 'catch').forEach((clause, index) => {
        const body = clause.body as PhpNode | undefined;
        const children = (body?.children as PhpNode[] | undefined) ?? [];
        const empty = children.length === 0;
        const hasThrow = children.length > 0 && exists(body as PhpNode, (node) => node.kind === 'throw');
        const hasCall = children.length > 0 && exists(body as PhpNode, (node) => node.kind === 'call');
        const symbol = `catch#${index}`;

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', symbol, range: rangeOf(clause), value: empty}));
        facts.push(
            build({
                kind: 'ast.catchSwallowsError',
                kindOf: 'catch-clause',
                symbol,
                range: rangeOf(clause),
                value: !hasThrow && !hasCall
            })
        );
    });

    const referenced = referencedShortNames(program);
    let importIndex = 0;
    for (const group of collect(program, (node) => node.kind === 'usegroup')) {
        for (const item of (group.items as PhpNode[] | undefined) ?? []) {
            const module = String(item.name ?? '');
            const symbol = `import#${importIndex}`;
            facts.push(build({kind: 'deps.import', kindOf: 'import', symbol, range: rangeOf(group), value: {module, isTypeOnly: false}}));

            const local = aliasName(item) ?? lastSegment(module);
            if (local.length > 0 && !referenced.has(local)) {
                facts.push(build({kind: 'deps.importUnused', kindOf: 'import', symbol, range: rangeOf(group), value: module}));
            }
            importIndex += 1;
        }
    }

    return facts;
};

// PHP non-deterministic built-ins (clock / RNG / unique ids).
const NONDETERMINISTIC_PHP: ReadonlySet<string> = new Set([
    'time',
    'microtime',
    'date',
    'rand',
    'mt_rand',
    'random_int',
    'random_bytes',
    'uniqid'
]);

const usesNondeterminism = (body: PhpNode): boolean => {
    let found = false;
    const walk = (node: PhpNode): void => {
        for (const child of childNodes(node)) {
            if (FUNCTION_LIKE.has(child.kind)) {
                continue;
            }
            if (child.kind === 'call') {
                const what = child.what;
                if (isPhpNode(what) && what.kind === 'name' && typeof what.name === 'string') {
                    if (NONDETERMINISTIC_PHP.has(lastSegment(what.name))) {
                        found = true;
                    }
                }
            }
            walk(child);
        }
    };
    walk(body);
    return found;
};

const referencedShortNames = (program: PhpNode): Set<string> => {
    const names = new Set<string>();
    for (const node of collect(program, (candidate) => candidate.kind === 'name')) {
        if (typeof node.name === 'string') {
            names.add(lastSegment(node.name));
        }
    }
    return names;
};

const aliasName = (item: PhpNode): string | null => {
    const alias = item.alias;
    if (typeof alias === 'string') {
        return alias;
    }
    if (isPhpNode(alias) && typeof alias.name === 'string') {
        return alias.name;
    }
    return null;
};

const lastSegment = (fqn: string): string => {
    const parts = fqn.split('\\');
    return parts[parts.length - 1] ?? fqn;
};

const computeMetrics = (fn: PhpNode, body: PhpNode): FunctionMetrics => {
    const state: MetricState = {cyclomatic: 1, cognitive: 0, maxNesting: 0};
    visit(body, 0, state);

    const loc = fn.loc;
    const lineCountForFn = loc === undefined ? 1 : loc.end.line - loc.start.line + 1;
    const args = fn.arguments as unknown[] | undefined;

    return {
        cyclomatic: state.cyclomatic,
        cognitive: state.cognitive,
        nestingDepth: state.maxNesting,
        parameterCount: args?.length ?? 0,
        lineCount: lineCountForFn
    };
};

const visit = (node: PhpNode, nesting: number, state: MetricState): void => {
    for (const child of childNodes(node)) {
        if (FUNCTION_LIKE.has(child.kind)) {
            continue;
        }

        if (CYCLOMATIC_KINDS.has(child.kind)) {
            state.cyclomatic += 1;
        }
        if (child.kind === 'bin' && typeof child.type === 'string' && LOGICAL_TYPES.has(child.type)) {
            state.cyclomatic += 1;
            state.cognitive += 1;
        }

        const isNesting = NESTING_KINDS.has(child.kind);
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

const isPhpNode = (value: unknown): value is PhpNode => {
    return typeof value === 'object' && value !== null && typeof (value as PhpNode).kind === 'string';
};

const childNodes = (node: PhpNode): PhpNode[] => {
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

const collect = (root: PhpNode, predicate: (node: PhpNode) => boolean): PhpNode[] => {
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

const exists = (root: PhpNode, predicate: (node: PhpNode) => boolean): boolean => {
    return collect(root, predicate).length > 0;
};

const functionName = (fn: PhpNode): string => {
    const name = fn.name;
    if (typeof name === 'string' && name.length > 0) {
        return name;
    }
    if (isPhpNode(name) && typeof name.name === 'string') {
        return name.name;
    }
    return `anonymous@${fn.loc?.start.line ?? 0}`;
};

const rangeOf = (node: PhpNode): SourceRange => {
    const loc = node.loc;
    if (loc === undefined) {
        return {startLine: 1, startCol: 0, endLine: 1, endCol: 0};
    }
    return {startLine: loc.start.line, startCol: loc.start.column, endLine: loc.end.line, endCol: loc.end.column};
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

// Scans the comment block immediately above a function for the opt-out marker.
const leadingHasMarker = (lines: string[], startLine: number): boolean => {
    for (let index = startLine - 2; index >= 0; index -= 1) {
        const text = (lines[index] ?? '').trim();
        if (text.length === 0) {
            continue;
        }
        const isComment =
            text.startsWith('//') || text.startsWith('#') || text.startsWith('*') || text.startsWith('/*') || text.endsWith('*/');
        if (!isComment) {
            return false;
        }
        if (text.includes(RATIONALE_MARKER)) {
            return true;
        }
    }
    return false;
};
