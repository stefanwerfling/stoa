import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import {callSiteOf, type DartCallSite} from './DartCallSite.js';

type Build = (spec: FactSpec) => Fact;

/**
 * State lifecycle facts (Flutter analysis, Phase 3): for every class that
 * directly `extends State<…>`, ONE `dart.stateLifecycle` fact holding plain,
 * neutral data about its members — which fields are assigned the result of a
 * call (and which call), which fields `dispose()` mentions, which calls
 * `initState()` makes with `context`, and where `setState` follows an `await`.
 * No judgement here: whether a call creates a controller, whether a lookup is
 * an inherited-widget dependency, whether a missing mention is a leak — the
 * rules decide (rules/project/FlutterLifecycleRules.ts), together with the
 * identity facts (`dart.importSpec`/`dart.classDecl`).
 *
 * Deliberately syntactic and conservative:
 * - a CREATION is a field whose initializer, or an assignment `field = …`
 *   anywhere in the class, is exactly one call (optionally followed by cascade
 *   sections `..repeat()`); `widget.c ?? Foo()`, conditionals and other
 *   expressions are not creations (ownership is unclear);
 * - DISPOSE MENTIONS are the field names occurring as identifiers in
 *   `dispose()` or in any method of the same class it calls by name,
 *   transitively (`_disposeAll()`); any mention counts, not only `.dispose()`;
 * - a setState call's SCOPE is its nearest enclosing function body (method or
 *   closure); `afterAwait` means an `await` occurs earlier in that same scope,
 *   `mountedBetween` that an identifier `mounted` (incl. `context.mounted`)
 *   occurs between the last such `await` and the call.
 */

export interface LifecycleRange {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
}

export interface LifecycleCall {
    prefix: string | null;
    /** The name chain of the call (`['TextEditingController']`, `['Timer', 'periodic']`, `['stream', 'listen']`). */
    names: string[];
    range: LifecycleRange;
}

export interface LifecycleCreation extends LifecycleCall {
    field: string;
    /** The method containing the assignment; null for a field initializer. */
    method: string | null;
}

export interface LifecycleSetState {
    method: string;
    afterAwait: boolean;
    mountedBetween: boolean;
    range: LifecycleRange;
}

export interface StateLifecycleValue {
    [key: string]: unknown;
    v: 1;
    className: string;
    /** Prefix of the `State` superclass as written (`w.State<…>` → `w`). */
    statePrefix: string | null;
    mixins: string[];
    fields: string[];
    creations: LifecycleCreation[];
    hasDispose: boolean;
    /** Field names mentioned in dispose() and the same-class methods it calls (transitively), sorted. */
    disposeMentions: string[];
    /** Calls directly in initState() (not in closures) with an argument that is exactly `context`. */
    initStateContextCalls: LifecycleCall[];
    setStateCalls: LifecycleSetState[];
}

const SCOPE_TYPES: ReadonlySet<string> = new Set(['function_body', 'function_expression_body']);

interface Method {
    name: string;
    body: Node;
}

export const extractStateLifecycleFacts = (root: Node, prefixes: ReadonlySet<string>, build: Build): Fact[] => {
    const facts: Fact[] = [];
    for (const node of root.descendantsOfType('class_definition')) {
        if (node === null) {
            continue;
        }
        const value = lifecycleOf(node, prefixes);
        if (value !== null) {
            facts.push(build({kind: 'dart.stateLifecycle', kindOf: 'class', symbol: value.className, range: rangeOf(node), value}));
        }
    }
    return facts;
};

const lifecycleOf = (node: Node, prefixes: ReadonlySet<string>): StateLifecycleValue | null => {
    const name = namedChildren(node).find((child) => child.type === 'identifier');
    const superclass = namedChildren(node).find((child) => child.type === 'superclass');
    const body = namedChildren(node).find((child) => child.type === 'class_body');
    if (name === undefined || superclass === undefined || body === undefined) {
        return null;
    }
    const superTypes = namedChildren(superclass).filter((child) => child.type === 'type_identifier');
    // `State` or `prefix.State`: tree-sitter-dart spells a prefixed type as two type_identifiers.
    const statePrefix = superTypes.length === 2 && prefixes.has(superTypes[0]?.text ?? '') ? (superTypes[0]?.text ?? null) : null;
    const stateName = superTypes[statePrefix === null ? 0 : 1]?.text;
    if (stateName !== 'State' || superTypes.length > (statePrefix === null ? 1 : 2)) {
        return null;
    }
    const mixinsNode = namedChildren(superclass).find((child) => child.type === 'mixins');
    const mixins = mixinsNode === undefined ? [] : namedChildren(mixinsNode).filter((child) => child.type === 'type_identifier').map((child) => child.text);

    const methods = methodsOf(body);
    const fields: string[] = [];
    const creations: LifecycleCreation[] = [];
    for (const declaration of namedChildren(body).filter((child) => child.type === 'declaration')) {
        for (const initialized of declaration.descendantsOfType('initialized_identifier')) {
            if (initialized === null) {
                continue;
            }
            const [identifier, ...rest] = namedChildren(initialized);
            if (identifier === undefined || identifier.type !== 'identifier') {
                continue;
            }
            fields.push(identifier.text);
            const call = soleCall(rest, prefixes);
            if (call !== null) {
                creations.push({field: identifier.text, method: null, ...call});
            }
        }
    }
    const fieldSet = new Set(fields);
    for (const method of methods) {
        for (const assignment of method.body.descendantsOfType('assignment_expression')) {
            if (assignment === null) {
                continue;
            }
            const [target, ...rest] = namedChildren(assignment);
            const field = target === undefined ? null : assignedField(target);
            if (field === null || !fieldSet.has(field)) {
                continue;
            }
            const call = soleCall(rest, prefixes);
            if (call !== null) {
                creations.push({field, method: method.name, ...call});
            }
        }
    }

    const dispose = methods.find((method) => method.name === 'dispose');
    const initState = methods.find((method) => method.name === 'initState');
    return {
        v: 1,
        className: name.text,
        statePrefix,
        mixins,
        fields,
        creations,
        hasDispose: dispose !== undefined,
        disposeMentions: dispose === undefined ? [] : disposeMentions(dispose, methods, fieldSet),
        initStateContextCalls: initState === undefined ? [] : contextCalls(initState.body, prefixes),
        setStateCalls: methods.flatMap((method) => setStateCalls(method, prefixes))
    };
};

// `method_signature` followed by its `function_body` sibling (getters/setters/
// operators are skipped; their names are not lifecycle hooks).
const methodsOf = (classBody: Node): Method[] => {
    const methods: Method[] = [];
    for (const child of namedChildren(classBody)) {
        if (child.type !== 'method_signature') {
            continue;
        }
        const signature = namedChildren(child).find((part) => part.type === 'function_signature');
        const name = signature === undefined ? undefined : namedChildren(signature).find((part) => part.type === 'identifier');
        const body = child.nextNamedSibling;
        if (name !== undefined && body !== null && body.type === 'function_body') {
            methods.push({name: name.text, body});
        }
    }
    return methods;
};

// `_x = …` or `this._x = …`.
const assignedField = (target: Node): string | null => {
    if (target.type !== 'assignable_expression') {
        return null;
    }
    const parts = namedChildren(target);
    if (parts.length === 1 && parts[0]?.type === 'identifier') {
        return parts[0].text;
    }
    if (parts.length === 2 && parts[0]?.type === 'this') {
        const name = parts[1]?.type === 'unconditional_assignable_selector' ? namedChildren(parts[1]).find((part) => part.type === 'identifier') : undefined;
        return name?.text ?? null;
    }
    return null;
};

// The value nodes form exactly one call (plus optional cascade sections).
const soleCall = (value: readonly Node[], prefixes: ReadonlySet<string>): LifecycleCall | null => {
    const first = value[0];
    if (first === undefined) {
        return null;
    }
    const site = callSiteOf(first, prefixes);
    if (site === null) {
        return null;
    }
    // The last non-cascade node must end exactly where the call's argument
    // list ends (`Foo().bar` or `Foo() + x` are not a sole call).
    const last = value.filter((node) => node.type !== 'cascade_section').at(-1);
    if (last === undefined || last.endIndex !== site.arguments.endIndex) {
        return null;
    }
    return callOf(site);
};

const callOf = (site: DartCallSite): LifecycleCall => ({prefix: site.prefix, names: [...site.names], range: site.range});

const disposeMentions = (dispose: Method, methods: readonly Method[], fields: ReadonlySet<string>): string[] => {
    const byName = new Map(methods.map((method) => [method.name, method]));
    const mentioned = new Set<string>();
    const visited = new Set<string>();
    const queue: Method[] = [dispose];
    while (queue.length > 0) {
        const method = queue.shift() as Method;
        if (visited.has(method.name)) {
            continue;
        }
        visited.add(method.name);
        for (const identifier of method.body.descendantsOfType('identifier')) {
            if (identifier === null) {
                continue;
            }
            if (fields.has(identifier.text)) {
                mentioned.add(identifier.text);
            }
            const callee = byName.get(identifier.text);
            if (callee !== undefined && !visited.has(callee.name)) {
                queue.push(callee);
            }
        }
    }
    return [...mentioned].sort();
};

const contextCalls = (body: Node, prefixes: ReadonlySet<string>): LifecycleCall[] => {
    const calls: LifecycleCall[] = [];
    for (const node of body.descendantsOfType(['identifier'])) {
        if (node === null || scopeOf(node) !== body.id) {
            continue;
        }
        const site = callSiteOf(node, prefixes);
        if (site !== null && namedChildren(site.arguments).some((argument) => argument.type === 'argument' && argument.text === 'context')) {
            calls.push(callOf(site));
        }
    }
    return calls;
};

const setStateCalls = (method: Method, prefixes: ReadonlySet<string>): LifecycleSetState[] => {
    const result: LifecycleSetState[] = [];
    const awaits = method.body.descendantsOfType('await_expression').filter((node): node is Node => node !== null);
    const mounted = method.body.descendantsOfType('identifier').filter((node): node is Node => node !== null && node.text === 'mounted');
    for (const node of method.body.descendantsOfType('identifier')) {
        if (node === null || node.text !== 'setState') {
            continue;
        }
        const site = callSiteOf(node, prefixes);
        if (site === null || site.prefix !== null || site.names.length !== 1) {
            continue;
        }
        const scope = scopeOf(node);
        const earlier = awaits.filter((candidate) => candidate.endIndex <= node.startIndex && scopeOf(candidate) === scope);
        const lastAwait = earlier.at(-1);
        result.push({
            method: method.name,
            afterAwait: lastAwait !== undefined,
            mountedBetween: lastAwait !== undefined && mounted.some((guard) => guard.startIndex >= lastAwait.endIndex && guard.endIndex <= node.startIndex),
            range: site.range
        });
    }
    return result;
};

// The id of the nearest enclosing function body (a method's or a closure's).
// Ids, not Node objects: web-tree-sitter hands out a fresh wrapper per access.
const scopeOf = (node: Node): number | null => {
    let current = node.parent;
    while (current !== null && !SCOPE_TYPES.has(current.type)) {
        current = current.parent;
    }
    return current === null ? null : current.id;
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

const rangeOf = (node: Node): SourceRange => ({
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column
});
