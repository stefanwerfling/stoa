import type {Node} from 'web-tree-sitter';
import {declarationIdentities, type DeclarationBase, type IdentityScheme} from '../../FindingIdentity.js';
import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {factBuilder, identitySchemeOf, type AdapterInfo} from '../FactBuilder.js';
import {importPrefixes, parseErrorCount} from './DartCallSite.js';
import {extractDartDeclarationFacts} from './DartDeclarations.js';
import {extractWidgetTree} from './FlutterWidgets.js';
import {extractFlutterA11yFacts, type FileResolution} from './FlutterA11y.js';
import {flutterAwareIndex} from './FlutterCatalog.js';
import {extractStateLifecycleFacts} from './FlutterLifecycle.js';
import {extractDartMemberFacts} from './DartMembers.js';

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
    const scheme = identitySchemeOf(info);
    const facts: Fact[] = [];
    const build = factBuilder(info, filePath);
    const lines = content.split('\n');

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(lines), value: lineCount(content)}));
    // Emitted only when tree-sitter had to recover (absent = a clean parse), so
    // the silent degradation on syntax the grammar lacks (Dart 3 records,
    // patterns, switch expressions, class modifiers) is visible as a fact. No
    // rule reads it; the parse itself still counts as successful, unchanged.
    const parseErrors = parseErrorCount(root);
    if (parseErrors > 0) {
        facts.push(build({kind: 'file.parseErrors', kindOf: 'file', range: fileRange(lines), value: parseErrors}));
    }

    const prefixes = importPrefixes(root);
    const functions = dartFunctions(root, scheme);
    const identities = declarationIdentities(functions.map(({base}) => base), scheme);
    for (const [index, {signature, owner, body, form}] of functions.entries()) {
        const kindOf: SubjectKind = owner.type === 'method_signature' ? 'method' : 'function';
        const identity = identities[index];
        if (identity === undefined) {
            continue;
        }
        const {symbol, kind: identityKind} = identity;
        const range = spanRange(owner, body);
        const metrics = computeMetrics(body);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, identityKind, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, identityKind, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, identityKind, range, value: metrics.maxNesting}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, identityKind, range, value: parameterCount(signature)}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, identityKind, range, value: range.endLine - range.startLine + 1}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, identityKind, range, value: leadingHasMarker(lines, range.startLine)}));
        // A closure inside a function is already part of that function's
        // nondeterminism fact (it reads its whole body); only a closure
        // outside every function (a field initializer) has its own.
        if (form !== 'closure' || !hasAncestor(owner, 'function_body')) {
            facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, identityKind, range, value: usesNondeterminism(body)}));
        }

        // Flutter widget structure of this body (Phase 1) — one compact fact
        // per function that builds widgets; the FlutterWidgetGraph is rebuilt
        // from these facts after extraction (and on a FactCache hit). Named
        // functions only: a closure's widgets (a `builder:`) are part of the
        // tree of the function it is written in.
        if (form === 'function') {
            const tree = extractWidgetTree(body, prefixes, returnsWidget(signature));
            if (tree !== null) {
                facts.push(build({kind: 'ui.flutterWidgetTree', kindOf, symbol, identityKind, range, value: tree}));
            }
        }
    }

    descendants(root, 'catch_clause').forEach((clause, index) => {
        const sibling = clause.nextNamedSibling;
        const block = sibling !== null && sibling.type === 'block' ? sibling : null;
        const statements = block === null ? 0 : namedChildren(block).length;
        const hasThrow = block !== null && (descendants(block, 'throw_expression').length > 0 || /\brethrow\b/.test(block.text));
        const hasCall = block !== null && descendants(block, 'arguments').length > 0;
        const symbol = `catch#${index}`;
        const range = spanRange(clause, block ?? clause);

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', site: true, symbol, range, value: statements === 0}));
        facts.push(build({kind: 'ast.catchSwallowsError', kindOf: 'catch-clause', site: true, symbol, range, value: !hasThrow && !hasCall && !catchReadsError(clause, block)}));
        facts.push(build({kind: 'doc.catchHasRationale', kindOf: 'catch-clause', site: true, symbol, range, value: block !== null && descendants(block, COMMENT_TYPES).length > 0}));
    });

    // Library directives and type declarations (inputs for widget identity).
    const declarations = extractDartDeclarationFacts(root, build);
    facts.push(...declarations);

    // Flutter widget-tree accessibility facts (Image/IconButton/TextField
    // labelling), graded against this file's own imports/declarations.
    facts.push(...extractFlutterA11yFacts(root, build, fileResolution(filePath, declarations), prefixes));

    // State lifecycle members (Phase 3): one neutral fact per `extends State<…>` class.
    facts.push(...extractStateLifecycleFacts(root, prefixes, build));

    // Class model (E3): neutral struct.typeDecl / struct.member facts.
    facts.push(...extractDartMemberFacts(root, prefixes, build));

    return facts;
};

// A comment inside the catch block documents a deliberately ignored error
// (R-ERR-SWALLOWED's own remediation); tree-sitter keeps comments as nodes.
const COMMENT_TYPES = ['comment', 'documentation_comment'];

// A catch whose bound error (or stack trace) is READ in the block — assigned
// elsewhere (`lastError = e`), passed, returned — hands the error on rather
// than swallowing it. The wildcard `_` binds nothing; a write to the binding
// itself, a member selector (`x.e`) or a named-argument label (`f(e: 1)`) is
// not a read. Mirrors the TypeScript adapter.
const catchReadsError = (clause: Node, block: Node | null): boolean => {
    if (block === null) {
        return false;
    }
    const names = new Set(namedChildren(clause).filter((child) => child.type === 'identifier' && !/^_+$/.test(child.text)).map((child) => child.text));
    if (names.size === 0) {
        return false;
    }
    return descendants(block, 'identifier').some((identifier) => names.has(identifier.text) && isIdentifierRead(identifier));
};

const isIdentifierRead = (identifier: Node): boolean => {
    const parent = identifier.parent;
    if (parent === null) {
        return false;
    }
    if (parent.type === 'label' || parent.type.includes('selector')) {
        return false;
    }
    if (parent.type === 'assignable_expression' && parent.namedChildCount === 1) {
        const assignment = parent.parent;
        return !(assignment !== null && assignment.type === 'assignment_expression' && assignment.childForFieldName('left')?.id === parent.id);
    }
    return true;
};

// The declared return type is `Widget` or a `…Widget` subtype name
// (`PreferredSizeWidget`) — the type written before the function's name.
const returnsWidget = (signature: Node): boolean => {
    const name = signature.childForFieldName('name');
    const type = namedChildren(signature).find((child) => child.type === 'type_identifier' && (name === null || child.endIndex <= name.startIndex));
    return type !== undefined && /Widget$/.test(type.text);
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

const SCOPE_TYPES: ReadonlySet<string> = new Set(['class_definition', 'mixin_declaration', 'extension_declaration', 'enum_declaration']);

/** The type an unnamed extension extends, as written (`List<String>`): its children before the body, without type parameters. */
const extendedType = (extension: Node): string => {
    const parts: string[] = [];
    for (const child of namedChildren(extension)) {
        if (child.type === 'extension_body') {
            break;
        }
        if (child.type !== 'type_parameters' && child.type !== 'comment') {
            parts.push(child.text);
        }
    }
    return parts.join('');
};

/**
 * The name of a class/mixin/extension/enum, or of the function whose body
 * `node` is; `undefined` for anything else. An unnamed extension is
 * `(extension on List<String>)` under identity scheme 2 (its methods were
 * unscoped under scheme 1, so they could share a symbol with a top-level
 * function).
 */
/** A named type's name; an unnamed extension is `(extension on T)` (scheme 2). */
const typeScopeName = (node: Node, scheme: IdentityScheme): string | undefined => {
    const name = (node.childForFieldName('name') ?? namedChildren(node).find((child) => child.type === 'identifier'))?.text;
    return name === undefined && node.type === 'extension_declaration' && scheme !== 1 ? `(extension on ${extendedType(node)})` : name;
};

const scopeName = (node: Node, scheme: IdentityScheme): string | undefined => {
    if (SCOPE_TYPES.has(node.type)) {
        return typeScopeName(node, scheme);
    }
    if (node.type === 'function_body') {
        return bodyScopeName(node, scheme);
    }
    // A closure bound to a variable or field names the closures inside it (scheme 2).
    if (node.type === 'function_expression' && scheme !== 1) {
        return closureBinding(node) ?? undefined;
    }
    return undefined;
};

/** The name of the function or accessor (scheme 2; scheme 1 knew no accessor functions) whose body `body` is. */
const bodyScopeName = (body: Node, scheme: IdentityScheme): string | undefined => {
    const previous = body.previousNamedSibling;
    const signature = previous?.type === 'method_signature' ? namedChildren(previous).find((child) => child.type === 'function_signature' || ACCESSOR_TYPES.has(child.type)) : previous;
    if (signature === undefined || signature === null || !(signature.type === 'function_signature' || (scheme !== 1 && ACCESSOR_TYPES.has(signature.type)))) {
        return undefined;
    }
    const name = functionName(signature);
    return name === '(anonymous)' ? undefined : name;
};

/**
 * A function's identity base: its name qualified by every enclosing named
 * type and function (`LoginState.build`, `outer.inner`), so two classes'
 * `build` in one file no longer share a symbol. Remaining duplicates get
 * `#n` (`declarationSymbols`).
 */
const qualifiedFunctionName = (signature: Node, scheme: IdentityScheme): string => [...enclosingScopes(signature, scheme), functionName(signature)].join('.');

/** The names of every named type and function enclosing `node`, outermost first. */
const enclosingScopes = (node: Node, scheme: IdentityScheme): string[] => {
    const scopes: string[] = [];
    for (let current = node.parent; current !== null; current = current.parent) {
        const name = scopeName(current, scheme);
        if (name !== undefined && name.length > 0) {
            scopes.unshift(name);
        }
    }
    return scopes;
};

/**
 * One measured Dart function (identity spec, phase 4):
 * - `function`: a named function, method, constructor or local function
 *   (`function_signature`);
 * - `accessor`: a getter or setter — `X.v`, told apart as `X.v:get` /
 *   `X.v:set` when both exist (scheme 2, as TypeScript's accessors);
 * - `closure`: a function expression — named by the variable or field it
 *   initializes (`A.m.f`), else `<scope>.(anonymous)#n`, numbered within
 *   its scope, as in TypeScript and PHP.
 * `signature` carries the parameter list (the function expression itself
 * for a closure); `owner` is where the declaration starts.
 */
interface DartFunction {
    signature: Node;
    owner: Node;
    body: Node;
    form: 'function' | 'accessor' | 'closure';
    base: DeclarationBase;
}

const ACCESSOR_TYPES: ReadonlySet<string> = new Set(['getter_signature', 'setter_signature']);

/** Every measured function of the file, in source order (`DartFunction`). */
const dartFunctions = (root: Node, scheme: IdentityScheme): DartFunction[] => {
    const found: DartFunction[] = [];
    const walk = (node: Node): void => {
        const entry = dartFunctionAt(node, scheme);
        // Scheme 1 reproduces the legacy identities, which knew named functions only.
        if (entry !== null && (scheme !== 1 || entry.form === 'function')) {
            found.push(entry);
        }
        for (const child of namedChildren(node)) {
            walk(child);
        }
    };
    walk(root);
    return found;
};

const dartFunctionAt = (node: Node, scheme: IdentityScheme): DartFunction | null => {
    if (node.type === 'function_expression') {
        const body = namedChildren(node).find((child) => child.type === 'function_expression_body' || child.type === 'function_body');
        // Inside a region tree-sitter had to recover (Dart 3 records, patterns,
        // switch expressions — see `file.parseErrors`), a "function expression"
        // is often a misread record or pattern: not measured.
        if (body === undefined || node.hasError || hasAncestor(node, 'ERROR')) {
            return null;
        }
        const binding = closureBinding(node);
        const scope = enclosingScopes(node, scheme);
        return {signature: node, owner: node, body, form: 'closure', base: {base: [...scope, binding ?? '(anonymous)'].join('.'), anonymous: binding === null}};
    }
    if (node.type !== 'function_signature' && !ACCESSOR_TYPES.has(node.type)) {
        return null;
    }
    const parent = node.parent;
    const owner = parent !== null && parent.type === 'method_signature' ? parent : node;
    const body = owner.nextNamedSibling;
    if (body === null || body.type !== 'function_body') {
        return null;
    }
    const base = qualifiedFunctionName(node, scheme);
    if (node.type === 'function_signature') {
        return {signature: node, owner, body, form: 'function', base: {base, anonymous: false}};
    }
    return {signature: node, owner, body, form: 'accessor', base: {base, anonymous: false, variant: node.type === 'getter_signature' ? ':get' : ':set'}};
};

/** The variable or field a function expression initializes (`final f = () {}`, `static final s = …`), or `null`. */
const closureBinding = (expression: Node): string | null => {
    const parent = expression.parent;
    if (parent === null || !['initialized_variable_definition', 'initialized_identifier', 'static_final_declaration'].includes(parent.type)) {
        return null;
    }
    const name = namedChildren(parent).filter((child) => child.type === 'identifier' && child.endIndex <= expression.startIndex).pop();
    return name?.text ?? null;
};

const hasAncestor = (node: Node, type: string): boolean => {
    for (let current = node.parent; current !== null; current = current.parent) {
        if (current.type === type) {
            return true;
        }
    }
    return false;
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

// The name resolution of one file, from the declaration facts just extracted
// for it — the same algorithm (DartLibraryIndex + Flutter catalog) the
// FlutterWidgetGraph uses after extraction, restricted to this one file.
const fileResolution = (file: string, declarations: readonly Fact[]): FileResolution => {
    const index = flutterAwareIndex(declarations);
    return (name, prefix) => index.resolve(file, name, prefix);
};
