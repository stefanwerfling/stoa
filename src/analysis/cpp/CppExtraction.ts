import type {Node} from 'web-tree-sitter';
import {uniqueSymbols, variantBases, type IdentityScheme} from '../../FindingIdentity.js';
import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {factBuilder, identitySchemeOf, type AdapterInfo} from '../FactBuilder.js';

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
    const scheme = identitySchemeOf(info);
    const facts: Fact[] = [];
    const build = factBuilder(info, filePath);
    const lines = content.split('\n');

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(lines), value: lineCount(content)}));

    let allocIndex = 0;

    const functions = descendants(root, 'function_definition').flatMap((fn) => {
        const body = fn.childForFieldName('body');
        const declarator = descendants(fn, 'function_declarator')[0];
        return body === null || body.type !== 'compound_statement' || declarator === undefined ? [] : [{fn, body, declarator}];
    });
    const bases = functions.map(({fn, declarator}) => ({base: qualifiedFunctionName(fn, declarator, scheme), variant: parameterTypes(declarator)}));
    const symbols = uniqueSymbols(scheme === 1 ? bases.map(({base}) => base) : variantBases(bases));
    for (const [index, {fn, body, declarator}] of functions.entries()) {
        const kindOf: SubjectKind = hasAncestorType(fn, 'field_declaration_list') ? 'method' : 'function';
        const symbol = symbols[index] as string;
        const range = rangeOf(fn);
        const metrics = computeMetrics(body);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, range, value: metrics.maxNesting}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, range, value: parameterCount(declarator)}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, range, value: range.endLine - range.startLine + 1}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, range, value: leadingHasMarker(lines, range.startLine)}));
        facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, range, value: usesNondeterminism(body)}));

        // Every name ANY declaration in this function declares (not just
        // tracked allocations) — a declarator identifier is a declaration
        // SITE, never a USE of some other variable, even when it happens to
        // shadow one. Computed once per function and shared across every
        // allocation's classification below (see classifyAllocation()).
        const allDeclarators = ownDescendants(body, 'declaration').flatMap((decl) => declaredNamesOf(decl));

        for (const allocation of findAllocations(body)) {
            const outcome = classifyAllocation(allocation, body, allDeclarators);
            if (outcome === null) {
                continue;
            }
            const allocSymbol = `alloc#${allocIndex}`;
            allocIndex += 1;
            facts.push(build({kind: outcome, kindOf: 'statement', site: true, symbol: allocSymbol, range: rangeOf(allocation.declNode), value: true}));
        }
    }

    descendants(root, 'catch_clause').forEach((clause, index) => {
        const block = clause.childForFieldName('body');
        const statements = block === null ? 0 : namedChildren(block).length;
        const hasThrow = block !== null && ownDescendants(block, 'throw_statement').length > 0;
        const hasCall = block !== null && ownDescendants(block, 'call_expression').length > 0;
        const symbol = `catch#${index}`;
        const range = rangeOf(block ?? clause);

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', site: true, symbol, range, value: statements === 0}));
        facts.push(build({kind: 'ast.catchSwallowsError', kindOf: 'catch-clause', site: true, symbol, range, value: !hasThrow && !hasCall && !catchReadsError(clause, block)}));
        facts.push(build({kind: 'doc.catchHasRationale', kindOf: 'catch-clause', site: true, symbol, range, value: block !== null && descendants(block, 'comment').length > 0}));
    });

    descendants(root, 'preproc_include').forEach((include, index) => {
        const value = includeOf(include);
        if (value !== null) {
            facts.push(build({kind: 'cpp.include', kindOf: 'import', site: true, symbol: `import#${index}`, range: rangeOf(include), value: {...value}}));
        }
    });

    return facts;
};

/**
 * An `#include` as written (identity spec, phase 4):
 * - `form`: `quoted` (`"x.h"`), `system` (`<x>`) or `macro` (`#include NAME`
 *   — the header is the macro's expansion, unknown here; `module` is the
 *   macro text);
 * - `conditional`: inside a preprocessor conditional (`#if`/`#ifdef`/
 *   `#elif`/`#else`) other than the file's include guard — whether it is
 *   compiled depends on the configuration.
 */
export interface CppIncludeValue {
    module: string;
    form: 'quoted' | 'system' | 'macro';
    conditional: boolean;
}

const includeOf = (include: Node): CppIncludeValue | null => {
    const path = include.childForFieldName('path');
    if (path === null) {
        return null;
    }
    const conditional = isConditional(include);
    if (path.type === 'string_literal') {
        const content = namedChildren(path).find((child) => child.type === 'string_content');
        return {module: content?.text ?? '', form: 'quoted', conditional};
    }
    if (path.type === 'system_lib_string') {
        return {module: path.text.slice(1, -1), form: 'system', conditional};
    }
    return {module: path.text, form: 'macro', conditional};
};

const CONDITIONAL_TYPES: ReadonlySet<string> = new Set(['preproc_if', 'preproc_ifdef', 'preproc_elif', 'preproc_elifdef', 'preproc_else']);

const isConditional = (node: Node): boolean => {
    for (let current = node.parent; current !== null; current = current.parent) {
        if (CONDITIONAL_TYPES.has(current.type) && !isIncludeGuard(current)) {
            return true;
        }
    }
    return false;
};

/**
 * The classic include guard: a top-level `#ifndef NAME` whose first statement
 * is `#define NAME` and that is the only top-level node besides comments —
 * the whole file, compiled once per translation unit, never configuration.
 */
const isIncludeGuard = (node: Node): boolean => {
    if (node.type !== 'preproc_ifdef' || node.child(0)?.type !== '#ifndef' || node.parent?.type !== 'translation_unit') {
        return false;
    }
    const name = node.childForFieldName('name')?.text;
    const [, first] = namedChildren(node);
    const defined = first?.type === 'preproc_def' ? first.childForFieldName('name')?.text : undefined;
    const siblings = namedChildren(node.parent).filter((sibling) => sibling.type !== 'comment');
    return name !== undefined && name === defined && siblings.length === 1;
};

// A catch whose bound exception is READ in the body (`last = e;`, passed,
// returned) hands the error on rather than swallowing it; the left side of a
// plain assignment to the binding is a write. The parameter's type
// (`std::exception`) parses as type/namespace identifiers, so plain
// `identifier`s in the parameter list are exactly the bound names.
const catchReadsError = (clause: Node, block: Node | null): boolean => {
    const parameters = clause.childForFieldName('parameters');
    if (block === null || parameters === null) {
        return false;
    }
    const names = new Set(descendants(parameters, 'identifier').map((identifier) => identifier.text));
    return descendants(block, 'identifier').some((identifier) => {
        if (!names.has(identifier.text)) {
            return false;
        }
        const parent = identifier.parent;
        return !(parent !== null && parent.type === 'assignment_expression' && parent.childForFieldName('left')?.id === identifier.id);
    });
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

const TYPE_TYPES: ReadonlySet<string> = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);

/**
 * A function's identity base: an in-class definition is qualified by its
 * enclosing named classes (`Buffer::reset`), the way an out-of-class
 * definition already spells itself (`Buffer::reset`), so two classes'
 * `reset` in one file no longer share a symbol. Under identity scheme 2 the
 * enclosing namespaces lead (`io::Buffer::reset`, an unnamed one as
 * `(anonymous)`), for in-class and out-of-class definitions alike; scheme 1
 * left them out. Overloads are told apart by `parameterTypes`, remaining
 * duplicates get `#n` (`uniqueSymbols`).
 */
const qualifiedFunctionName = (fn: Node, declarator: Node, scheme: IdentityScheme): string => {
    const scopes: string[] = [];
    for (let node = fn.parent; node !== null; node = node.parent) {
        const name = TYPE_TYPES.has(node.type) ? node.childForFieldName('name')?.text : node.type === 'namespace_definition' && scheme !== 1 ? (node.childForFieldName('name')?.text ?? '(anonymous)') : undefined;
        if (name !== undefined && name.length > 0) {
            scopes.unshift(name);
        }
    }
    return [...scopes, functionName(declarator)].join('::');
};

/**
 * A definition's parameter types, the way C++ itself tells overloads apart:
 * each parameter without its name and default (`(const char*, int&)`).
 * Syntactic — typedefs are not resolved, so `size_t` and `unsigned long`
 * stay two spellings.
 */
const parameterTypes = (declarator: Node): string => {
    const list = declarator.childForFieldName('parameters');
    const types = list === null ? [] : namedChildren(list).filter((child) => child.type !== 'comment').map(parameterType);
    return `(${types.join(', ')})`;
};

const parameterType = (parameter: Node): string => {
    const type = parameter.childForFieldName('type');
    if (type === null) {
        return compact(parameter.text);
    }
    const qualifiers = namedChildren(parameter).filter((child) => child.type === 'type_qualifier').map((child) => child.text);
    const declarator = parameter.childForFieldName('declarator');
    // The declarator's shape without its name: `*p` → `*`, `&out` → `&`, `items[]` → `[]`.
    const shape = declarator === null ? '' : declarator.text.replace(/[A-Za-z_]\w*/g, '');
    return compact(`${[...qualifiers, type.text].join(' ')}${shape}`);
};

const compact = (text: string): string => text.replace(/\s+/g, ' ').replace(/\s*([*&,<>()[\]])\s*/g, '$1').trim();

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

// Follows a declarator chain (pointer_declarator -> identifier,
// array_declarator -> identifier, or a bare identifier) down to the
// identifier actually being declared.
const declaredIdentifier = (declaratorNode: Node | null): Node | null => {
    let current: Node | null = declaratorNode;
    while (current !== null) {
        if (current.type === 'identifier') {
            return current;
        }
        current = current.childForFieldName('declarator');
    }
    return null;
};

// Every name a `declaration` statement declares, regardless of whether it
// is itself a tracked allocation — needed to find shadowing boundaries
// correctly even when the shadow is a plain `int p;`, not a pointer.
const declaredNamesOf = (decl: Node): Node[] => {
    const names: Node[] = [];
    for (const child of namedChildren(decl)) {
        const declarator = child.type === 'init_declarator' ? child.childForFieldName('declarator') : child;
        const identifier = declaredIdentifier(declarator);
        if (identifier !== null) {
            names.push(identifier);
        }
    }
    return names;
};

// The nearest enclosing block of `node` — its own `compound_statement`, or
// `functionBody` if there is none closer. Used to walk outward through
// nested `{ }` scopes the same way C/C++ name lookup does.
const enclosingBlock = (node: Node, functionBody: Node): Node => {
    let current = node.parent;
    while (current !== null) {
        if (current.equals(functionBody) || current.type === 'compound_statement') {
            return current;
        }
        current = current.parent;
    }
    return functionBody;
};

// A preprocessor conditional does NOT introduce its own C++ scope — the
// compiler sees whichever branch is actually compiled as flat statements in
// the SAME enclosing block. tree-sitter-cpp nests `#ifdef`/`#else`/`#if`
// content one AST level deeper than a real nested block would, though, so
// without this, a declaration guarded by `#ifndef X … #else … #endif`
// would not be found as "directly in this block" at all (confirmed against
// real code — vllm's cumem_allocator.cpp wraps a `malloc`+matching `free`
// in exactly this shape; the false positive this caused is now a
// regression test).
const PREPROC_TRANSPARENT: ReadonlySet<string> = new Set(['preproc_ifdef', 'preproc_if', 'preproc_else', 'preproc_elif']);

// Every declaration effectively AT this block's own scope level — recurses
// through preprocessor-conditional wrappers (see PREPROC_TRANSPARENT), but
// stops at any REAL nested scope (a compound_statement, a loop/if body, …),
// which gets its own, separate scope level instead.
const directDeclarationsOf = (block: Node): Node[] => {
    const found: Node[] = [];
    const walk = (node: Node): void => {
        for (const child of namedChildren(node)) {
            if (child.type === 'declaration') {
                found.push(child);
            } else if (PREPROC_TRANSPARENT.has(child.type)) {
                walk(child);
            }
        }
    };
    walk(block);
    return found;
};

// Every same-named declaration directly in `block` (not a deeper nested
// block) that precedes `beforeIndex` — i.e. "does this exact scope level
// declare this name before this point", the question C/C++ name lookup
// answers at every enclosing scope on the way out. Usually at most one
// (real C++ forbids redeclaring a name twice in ONE block) — but mutually
// exclusive `#ifdef`/`#else` branches of the SAME block are a documented
// exception: tree-sitter parses both unconditionally, so a declaration that
// precedes `beforeIndex` can legitimately exist in more than one branch at
// once. Returning all of them (not just the first found) is what lets a
// later `free(p)`/`delete p` resolve against EITHER branch, instead of
// always binding to whichever branch happens to come first in source order
// and silently starving the other of any release at all (confirmed as a
// real false positive before this fix, now a regression test).
const shadowingDeclarationsIn = (block: Node, name: string, beforeIndex: number): Node[] => {
    const hits: Node[] = [];
    for (const decl of directDeclarationsOf(block)) {
        for (const identifier of declaredNamesOf(decl)) {
            if (identifier.text === name && identifier.startIndex < beforeIndex) {
                hits.push(identifier);
            }
        }
    }
    return hits;
};

/**
 * Which declaration (if any) an identifier OCCURRENCE actually binds to,
 * walking outward through enclosing `{ }` blocks the same way C/C++ scoping
 * does: the nearest enclosing block with an earlier same-named declaration
 * wins. This is what makes
 *
 *   int* p = new int(1);
 *   { int* p = new int(2); delete p; }
 *
 * resolve the inner `delete p` to the INNER `p` — never to the outer one,
 * even though both share the same identifier text (tree-sitter has no
 * symbol table, so this walk is the closest safe substitute; a bare
 * identifier-text match across the whole function, which is what this
 * analysis did before, would have the inner `delete` incorrectly silence
 * the outer leak — confirmed against exactly this snippet before this fix).
 */
const resolveBindingSite = (occurrence: Node, name: string, functionBody: Node): Node[] => {
    let block: Node | null = enclosingBlock(occurrence, functionBody);
    while (block !== null) {
        const hits = shadowingDeclarationsIn(block, name, occurrence.startIndex);
        if (hits.length > 0) {
            return hits;
        }
        if (block.equals(functionBody)) {
            return [];
        }
        block = enclosingBlock(block, functionBody);
    }
    return [];
};

const isNullptrLiteral = (node: Node): boolean => {
    // tree-sitter-cpp's own node type for the `nullptr` keyword is `null`
    // (confirmed against real parser output, not guessed from the keyword's
    // spelling).
    if (node.type === 'null') {
        return true;
    }
    if (node.type === 'identifier' && node.text === 'NULL') {
        return true;
    }
    return node.type === 'number_literal' && node.text === '0';
};

const isAllocationExpression = (node: Node): boolean => {
    if (node.type === 'new_expression') {
        return true;
    }
    return descendants(node, 'call_expression').some((call) => ALLOC_CALLS.has(calleeName(call) ?? ''));
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
        if (parent.type === 'return_statement' || parent.type === 'init_declarator') {
            return {kind: 'escape'};
        }
        if (parent.type === 'assignment_expression') {
            const isLeftSide = parent.childForFieldName('left')?.equals(current) === true;
            if (isLeftSide) {
                const rhs = parent.childForFieldName('right');
                // `p = nullptr;` / `p = new ...;` neither frees the ORIGINAL
                // object nor hands it to anyone else — the handle is simply
                // overwritten/lost. Treating this as an escape would wrongly
                // suppress a real leak (see test/Cpp.test.ts); anything else
                // on the right (another variable, a function's return value)
                // stays an escape — genuinely ambiguous without real
                // dataflow, so this engine's standing bias (false negative
                // over false positive) applies.
                if (rhs !== null && (isNullptrLiteral(rhs) || isAllocationExpression(rhs))) {
                    return {kind: 'ordinary'};
                }
                return {kind: 'escape'};
            }
            // The right-hand side: `other = p;` — another variable now also holds this pointer.
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
 * identifier in the (lambda-excluded) function body via classifyOccurrence()
 * — but ONLY occurrences that actually bind to THIS declaration once scope
 * is taken into account (resolveBindingSite()), not merely every identifier
 * that happens to share the same text anywhere in the function. Two
 * same-named pointers in different (possibly nested) scopes are tracked
 * completely independently, exactly like the compiler would see them:
 * - a RELEASE is a matching `delete`/`delete[]`/`free(name)` (possibly
 *   through a cast — `free((void*)p)`);
 * - an ESCAPE is anything handed elsewhere — a call argument, a return
 *   (directly or wrapped in a braced aggregate initializer), a reassignment
 *   TO another variable, or being read as another declaration's
 *   initializer. No leak claim is made at all once one occurs — ownership
 *   may have transferred, so bailing out favors a false negative over a
 *   false positive, consistent with this engine's standing bias (see docs).
 *   Reassigning THIS pointer itself to `nullptr` or a new allocation is
 *   deliberately NOT an escape (nothing receives the original object) — see
 *   classifyOccurrence().
 * - anything else (a dereference, `obj->field`, `arr[i]`, a null check, …)
 *   is an ordinary local use — it neither releases nor escapes the pointer.
 *
 * Returns the fact kind to emit, or null when nothing is reportable
 * (released cleanly, or an escape made the question unanswerable).
 */
const classifyAllocation = (allocation: Allocation, body: Node, allDeclarators: readonly Node[]): 'ast.unreleasedAllocation' | 'ast.newDeleteMismatch' | null => {
    let released = false;
    let escaped = false;
    let mismatched = false;

    for (const occurrence of ownDescendants(body, 'identifier')) {
        if (occurrence.text !== allocation.name) {
            continue;
        }
        // A declarator identifier is a declaration SITE, never a USE of
        // some other variable — skip every one of them (not just this
        // allocation's own), including a shadowing declaration's own name.
        // Without this, resolveBindingSite() below would resolve a
        // shadowing declaration's OWN identifier back to the OUTER
        // allocation (its own declaration cannot shadow itself AT its own
        // position), and classifyOccurrence() would then misread that
        // declarator position as the outer pointer being read as some
        // other declaration's initializer — a confirmed false positive
        // fixed before shipping, not a hypothetical.
        if (allDeclarators.some((identifier) => identifier.equals(occurrence))) {
            continue;
        }
        if (!resolveBindingSite(occurrence, allocation.name, body).some((candidate) => candidate.equals(allocation.nameNode))) {
            // This occurrence resolves ONLY to a DIFFERENT, shadowing
            // declaration of the same name — not a reference to this
            // allocation at all. (If this allocation IS among the
            // candidates — e.g. a mutually exclusive #ifdef/#else sibling —
            // the occurrence is still considered relevant below.)
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
