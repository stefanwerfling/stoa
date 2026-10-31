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
const ALLOC_CALLS: ReadonlySet<string> = new Set(['malloc', 'calloc', 'realloc']);

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

    let allocIndex = 0;

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

        for (const allocation of findAllocations(body)) {
            const outcome = classifyAllocation(allocation, body);
            if (outcome === null) {
                continue;
            }
            const allocSymbol = `alloc#${allocIndex}`;
            allocIndex += 1;
            facts.push(build({kind: outcome, kindOf: 'statement', symbol: allocSymbol, range: rangeOf(allocation.declNode), value: true}));
        }
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
    return ownDescendants(body, 'call_expression').some((call) => NONDETERMINISTIC.has(calleeName(call) ?? ''));
};

// The trailing name only (so std::rand / ::malloc match the same as a bare call).
const calleeName = (call: Node): string | null => {
    const callee = call.childForFieldName('function');
    return callee === null ? null : callee.text.split('::').pop() ?? callee.text;
};

interface Allocation {
    name: string;
    /** 'new'/'new-array' track the C++ delete-form that must match; 'alloc' (malloc/calloc/realloc) always pairs with free(), which has no array distinction. */
    kind: 'new' | 'new-array' | 'alloc';
    /** The identifier node IN the declaration itself — excluded from classifyAllocation()'s scan so the declaring reference is never mistaken for a later use. */
    nameNode: Node;
    declNode: Node;
}

/**
 * Finds `Type* name = new ...;` / `Type* name = malloc(...);` (optionally
 * cast-wrapped) declarations directly inside this function body. Narrow by
 * design: a declaration with no initializer followed by a separate
 * assignment (`int* p; p = new int;`), multiple declarators in one
 * statement (`int *a, *b;`), or a non-pointer declarator form is not
 * tracked — each is a real but accepted gap, not silently guessed at.
 */
const findAllocations = (body: Node): Allocation[] => {
    const allocations: Allocation[] = [];
    for (const decl of ownDescendants(body, 'declaration')) {
        // A `static` local persists for the program's lifetime by design —
        // the classic (if controversial) "allocate once, never free" singleton
        // idiom, not a leak. Confirmed against real code (mimirmind's
        // bigBlockPool(), explicitly commented "// intentionally leaked") —
        // without this, that idiom would be flagged every time it is used.
        if (namedChildren(decl).some((child) => child.type === 'storage_class_specifier' && child.text === 'static')) {
            continue;
        }
        for (const initDeclarator of namedChildren(decl).filter((child) => child.type === 'init_declarator')) {
            const declarator = initDeclarator.childForFieldName('declarator');
            const value = initDeclarator.childForFieldName('value');
            if (declarator === null || value === null || declarator.type !== 'pointer_declarator') {
                continue;
            }
            const identifier = declarator.childForFieldName('declarator');
            if (identifier === null || identifier.type !== 'identifier') {
                continue;
            }
            if (value.type === 'new_expression') {
                // Placement new (`new (buf) Foo(...)`) constructs IN
                // caller-owned storage — it never allocates anything of its
                // own, so there is nothing for a `delete` to release here
                // (that would itself be undefined behavior). Confirmed
                // against real code (vllm's shm.cpp/cpu_attn_impl.hpp) where
                // this was flagging every placement-new call as a leak.
                if (value.childForFieldName('placement') !== null) {
                    continue;
                }
                const isArray = namedChildren(value).some((child) => child.type === 'new_declarator');
                allocations.push({name: identifier.text, kind: isArray ? 'new-array' : 'new', nameNode: identifier, declNode: decl});
                continue;
            }
            const allocCall = descendants(value, 'call_expression').find((call) => ALLOC_CALLS.has(calleeName(call) ?? ''));
            if (allocCall !== undefined) {
                allocations.push({name: identifier.text, kind: 'alloc', nameNode: identifier, declNode: decl});
            }
        }
    }
    return allocations;
};

const hasBracketChild = (node: Node): boolean => {
    for (let index = 0; index < node.childCount; index += 1) {
        if (node.child(index)?.type === '[') {
            return true;
        }
    }
    return false;
};

// Node types a pointer VALUE passes through unchanged on its way to wherever
// it ends up — climbed through when classifying an occurrence, so e.g.
// `return Buf{raw, size}` or `free((void*)p)` are recognized through the
// braced-initializer / cast wrapping around the identifier, not just a bare
// `return p;` / `free(p)`. Deliberately does NOT include a dereference
// (`pointer_expression`), member access (`field_expression`) or subscript
// (`subscript_expression`) — those consume the pointer value itself, so
// climbing through them would wrongly treat "write through the pointer" as
// "the pointer escaped" (see `usedThenLeaked` in test/Cpp.test.ts).
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set(['parenthesized_expression', 'cast_expression', 'initializer_list', 'compound_literal_expression', 'comma_expression', 'conditional_expression']);

type OccurrenceRole = {kind: 'release'; deleteNode?: Node} | {kind: 'escape'} | {kind: 'ordinary'};

/** Climbs from one identifier occurrence through transparent wrappers to classify its role — see TRANSPARENT_WRAPPERS. Stops at `body` (never climbs out of the function) or at the first non-transparent, non-matching ancestor (→ ordinary use). */
const classifyOccurrence = (occurrence: Node, body: Node): OccurrenceRole => {
    let current: Node = occurrence;
    while (!current.equals(body)) {
        const parent = current.parent;
        if (parent === null) {
            return {kind: 'ordinary'};
        }
        if (parent.type === 'delete_expression') {
            return {kind: 'release', deleteNode: parent};
        }
        if (parent.type === 'argument_list' && parent.parent?.type === 'call_expression') {
            return calleeName(parent.parent) === 'free' ? {kind: 'release'} : {kind: 'escape'};
        }
        if (parent.type === 'return_statement' || parent.type === 'assignment_expression' || parent.type === 'init_declarator') {
            return {kind: 'escape'};
        }
        if (!TRANSPARENT_WRAPPERS.has(parent.type)) {
            return {kind: 'ordinary'};
        }
        current = parent;
    }
    return {kind: 'ordinary'};
};

/**
 * Classifies ONE allocation by scanning every other reference to its
 * identifier in the (lambda-excluded) function body via classifyOccurrence():
 * - a RELEASE is a matching `delete`/`delete[]`/`free(name)` (possibly
 *   through a cast — `free((void*)p)`);
 * - an ESCAPE is anything handed elsewhere — a call argument, a return
 *   (directly or wrapped in a braced aggregate initializer), a reassignment
 *   on either side of `=`, or another declaration's initializer. No leak
 *   claim is made at all once one occurs — ownership may have transferred,
 *   so bailing out favors a false negative over a false positive,
 *   consistent with this engine's standing bias (see docs).
 * - anything else (a dereference, `obj->field`, `arr[i]`, a null check, …)
 *   is an ordinary local use — it neither releases nor escapes the pointer.
 *
 * Returns the fact kind to emit, or null when nothing is reportable
 * (released cleanly, or an escape made the question unanswerable).
 */
const classifyAllocation = (allocation: Allocation, body: Node): 'ast.unreleasedAllocation' | 'ast.newDeleteMismatch' | null => {
    let released = false;
    let escaped = false;
    let mismatched = false;

    for (const occurrence of ownDescendants(body, 'identifier')) {
        if (occurrence.text !== allocation.name || occurrence.equals(allocation.nameNode)) {
            continue;
        }
        const role = classifyOccurrence(occurrence, body);
        if (role.kind === 'escape') {
            escaped = true;
        } else if (role.kind === 'release') {
            released = true;
            if (role.deleteNode !== undefined && allocation.kind !== 'alloc') {
                const isArrayDelete = hasBracketChild(role.deleteNode);
                if (isArrayDelete !== (allocation.kind === 'new-array')) {
                    mismatched = true;
                }
            }
        }
    }

    if (mismatched) {
        return 'ast.newDeleteMismatch';
    }
    if (!released && !escaped) {
        return 'ast.unreleasedAllocation';
    }
    return null;
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
