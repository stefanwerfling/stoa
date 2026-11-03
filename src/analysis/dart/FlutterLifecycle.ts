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
 *
 * Fact v2 (Flutter quality track, Phase C) adds, without removing anything:
 * - `fieldTypes`: the declared type of each field as written (`[prefix, name]`,
 *   null for `var`/`final` without a type) — what a `.listen(…)` result is
 *   stored as decides whether it is a StreamSubscription;
 * - `externalFields`: fields that are ALSO initialized/assigned from something
 *   other than one call or `null` (`widget.controller`, a parameter, `a ?? b`) —
 *   their ownership cannot be judged;
 * - `releaseCalls`: fields on which the dispose() chain calls `.dispose()`,
 *   `.cancel()` or `.close()` (also `?.`, `this.`, cascade) — the subset of
 *   `disposeMentions` that is a certain release;
 * - per setState call, `guard`: whether a `mounted` check after the last await
 *   DOMINATES the call — see `guardOf` — plus the await's range and the
 *   deciding `mounted` mention.
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

/**
 * How a `mounted` check between the last await and a setState relates to it:
 * - `dominating`: on every path to the call the State is known to be mounted —
 *   `if (!mounted) return;`/`throw` (incl. `!a.mounted`, `|| …`) in a block
 *   enclosing the call, the call inside `if (mounted) {…}` (incl. `&& …`) or
 *   in the `else` of `if (!mounted)`, or `mounted ? setState(…) : …`;
 * - `non-dominating`: every mention is an `if` condition that does not guard
 *   the call (`if (mounted) {…}` beside it, `if (!mounted) {…}` without an
 *   unconditional exit, a guard in a sibling branch);
 * - `unknown`: a mention the analysis does not model (`final ok = mounted;`,
 *   `while (mounted)`, `mounted == true`, a mention in another closure) — the
 *   rule stays silent;
 * - `none`: no `mounted` between the await and the call.
 */
export type MountedGuard = 'dominating' | 'non-dominating' | 'unknown' | 'none';

export interface LifecycleSetState {
    method: string;
    afterAwait: boolean;
    mountedBetween: boolean;
    range: LifecycleRange;
    /** Phase C. Meaningful only when `afterAwait`; `none` otherwise. */
    guard: MountedGuard;
    /** Phase C: the last await before the call in its scope, or null. */
    awaitRange: LifecycleRange | null;
    /** Phase C: the `mounted` mention that decided `guard` (null for `none`). */
    mountedRange: LifecycleRange | null;
}

export interface StateLifecycleValue {
    [key: string]: unknown;
    v: 2;
    className: string;
    /** Prefix of the `State` superclass as written (`w.State<…>` → `w`). */
    statePrefix: string | null;
    mixins: string[];
    fields: string[];
    /** Phase C: declared type per field (aligned with `fields`): `[prefix, name]`, null when not written. */
    fieldTypes: ([string | null, string] | null)[];
    /** Phase C: fields also initialized/assigned from something other than one call or `null` (ownership unclear), sorted. */
    externalFields: string[];
    creations: LifecycleCreation[];
    hasDispose: boolean;
    /** Field names mentioned in dispose() and the same-class methods it calls (transitively), sorted. */
    disposeMentions: string[];
    /** Phase C: fields on which the dispose() chain calls `.dispose()`/`.cancel()`/`.close()`, sorted. */
    releaseCalls: string[];
    /** Calls directly in initState() (not in closures) with an argument that is exactly `context`. */
    initStateContextCalls: LifecycleCall[];
    setStateCalls: LifecycleSetState[];
}

const SCOPE_TYPES: ReadonlySet<string> = new Set(['function_body', 'function_expression_body']);
const RELEASE_METHODS: ReadonlySet<string> = new Set(['dispose', 'cancel', 'close']);

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
    const fieldTypes: ([string | null, string] | null)[] = [];
    const external = new Set<string>();
    const creations: LifecycleCreation[] = [];
    for (const declaration of namedChildren(body).filter((child) => child.type === 'declaration')) {
        const type = declaredType(declaration, prefixes);
        for (const initialized of declaration.descendantsOfType('initialized_identifier')) {
            if (initialized === null) {
                continue;
            }
            const [identifier, ...rest] = namedChildren(initialized);
            if (identifier === undefined || identifier.type !== 'identifier') {
                continue;
            }
            fields.push(identifier.text);
            fieldTypes.push(type);
            const call = soleCall(rest, prefixes);
            if (call !== null) {
                creations.push({field: identifier.text, method: null, ...call});
            } else if (!isNullOrAbsent(rest)) {
                external.add(identifier.text);
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
            } else if (!isNullOrAbsent(rest)) {
                external.add(field);
            }
        }
    }

    const dispose = methods.find((method) => method.name === 'dispose');
    const initState = methods.find((method) => method.name === 'initState');
    const released = dispose === undefined ? {mentioned: [], released: []} : disposeMentions(dispose, methods, fieldSet);
    return {
        v: 2,
        className: name.text,
        statePrefix,
        mixins,
        fields,
        fieldTypes,
        externalFields: [...external].sort(),
        creations,
        hasDispose: dispose !== undefined,
        disposeMentions: released.mentioned,
        releaseCalls: released.released,
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

// `Type`, `Type<…>`, `Type?` or `prefix.Type` written before the declared names; null for `var`/untyped.
const declaredType = (declaration: Node, prefixes: ReadonlySet<string>): [string | null, string] | null => {
    const types = namedChildren(declaration).filter((child) => child.type === 'type_identifier');
    if (types.length === 1) {
        return [null, (types[0] as Node).text];
    }
    if (types.length === 2 && prefixes.has((types[0] as Node).text)) {
        return [(types[0] as Node).text, (types[1] as Node).text];
    }
    return null;
};

// No value (`T? _x;`) or the literal `null` (`_sub = null;` after cancelling).
const isNullOrAbsent = (value: readonly Node[]): boolean => {
    const nodes = value.filter((node) => node.type !== 'comment');
    return nodes.length === 0 || (nodes.length === 1 && nodes[0]?.type === 'null_literal');
};

// `x.dispose()`, `x?.cancel()`, `this.x.close()`, `x..dispose()` — a release
// call directly on the identifier (or on the `this.x` selector holding it).
const isReleaseCall = (identifier: Node): boolean => {
    const viaThis = identifier.parent?.type === 'unconditional_assignable_selector' && identifier.parent.parent?.type === 'selector';
    const anchor = viaThis ? (identifier.parent?.parent as Node) : identifier;
    // The field must head the chain: `x.…` or `this.x.…`, not `other.x.…`.
    if (viaThis ? anchor.previousNamedSibling?.type !== 'this' || anchor.previousNamedSibling.previousNamedSibling !== null : identifier.previousNamedSibling !== null) {
        return false;
    }
    let next = anchor.nextNamedSibling;
    if (next?.type === 'selector') {
        const access = namedChildren(next)[0];
        const name = access === undefined ? undefined : namedChildren(access).find((child) => child.type === 'identifier');
        const call = next.nextNamedSibling;
        return (
            (access?.type === 'unconditional_assignable_selector' || access?.type === 'conditional_assignable_selector') &&
            name !== undefined &&
            RELEASE_METHODS.has(name.text) &&
            call?.type === 'selector' &&
            namedChildren(call)[0]?.type === 'argument_part'
        );
    }
    while (next?.type === 'cascade_section') {
        const selector = namedChildren(next).find((child) => child.type === 'cascade_selector');
        const name = selector === undefined ? undefined : namedChildren(selector).find((child) => child.type === 'identifier');
        if (name !== undefined && RELEASE_METHODS.has(name.text) && namedChildren(next).some((child) => child.type === 'argument_part')) {
            return true;
        }
        next = next.nextNamedSibling;
    }
    return false;
};

const disposeMentions = (dispose: Method, methods: readonly Method[], fields: ReadonlySet<string>): {mentioned: string[]; released: string[]} => {
    const byName = new Map(methods.map((method) => [method.name, method]));
    const mentioned = new Set<string>();
    const released = new Set<string>();
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
                if (isReleaseCall(identifier)) {
                    released.add(identifier.text);
                }
            }
            const callee = byName.get(identifier.text);
            if (callee !== undefined && !visited.has(callee.name)) {
                queue.push(callee);
            }
        }
    }
    return {mentioned: [...mentioned].sort(), released: [...released].sort()};
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
        const earlier = awaits.filter((candidate) => candidate.endIndex <= node.startIndex && scopeOf(candidate) === scope && !exclusiveBranches(candidate, node));
        const lastAwait = earlier.at(-1);
        const between = lastAwait === undefined ? [] : mounted.filter((guard) => guard.startIndex >= lastAwait.endIndex && guard.endIndex <= node.startIndex);
        const guard = guardOf(node, scope, between);
        result.push({
            method: method.name,
            afterAwait: lastAwait !== undefined,
            mountedBetween: between.length > 0,
            range: site.range,
            guard: guard.guard,
            awaitRange: lastAwait === undefined ? null : rangeOf(lastAwait),
            mountedRange: guard.mention === null ? null : rangeOf(guard.mention)
        });
    }
    return result;
};

type Polarity = 'mounted-if-true' | 'mounted-if-false';

// Operands of an expression node: tree-sitter-dart spells a chain
// (`context.mounted`) as sibling nodes, so a `selector` continues the operand
// before it.
const operands = (node: Node): Node[][] => {
    const groups: Node[][] = [];
    for (const child of namedChildren(node)) {
        const current = groups.at(-1);
        if (child.type === 'selector' && current !== undefined) {
            current.push(child);
        } else if (child.type !== 'comment') {
            groups.push([child]);
        }
    }
    return groups;
};

// What a condition says about `mounted`: true ⇒ mounted (`mounted`,
// `a.mounted`, `mounted && x`), false ⇒ mounted (`!mounted`, `!m || x`), or
// nothing provable (null — `mounted == true`, `x || mounted`, calls, …).
const polarityOf = (operand: readonly Node[]): Polarity | null => {
    const first = operand[0];
    if (first === undefined) {
        return null;
    }
    if (operand.length > 1) {
        return isMountedChain(operand) ? 'mounted-if-true' : null;
    }
    switch (first.type) {
        case 'parenthesized_expression': {
            const inner = operands(first);
            return inner.length === 1 ? polarityOf(inner[0] as Node[]) : null;
        }
        case 'identifier':
            return first.text === 'mounted' ? 'mounted-if-true' : null;
        case 'unary_expression': {
            const [operator, ...rest] = namedChildren(first);
            if (operator?.type !== 'prefix_operator' || operator.text !== '!') {
                return null;
            }
            const inner = polarityOf(rest);
            return inner === 'mounted-if-true' ? 'mounted-if-false' : inner === 'mounted-if-false' ? 'mounted-if-true' : null;
        }
        case 'logical_and_expression':
            return operands(first).some((part) => polarityOf(part) === 'mounted-if-true') ? 'mounted-if-true' : null;
        case 'logical_or_expression':
            return operands(first).some((part) => polarityOf(part) === 'mounted-if-false') ? 'mounted-if-false' : null;
        default:
            return null;
    }
};

// `context.mounted`, `this.mounted`, `widget.x.mounted` spelled as sibling nodes.
const isMountedChain = (nodes: readonly Node[]): boolean => {
    const first = nodes[0];
    const last = nodes.at(-1);
    if (first === undefined || last === undefined || nodes.length < 2 || (first.type !== 'identifier' && first.type !== 'this')) {
        return false;
    }
    const access = namedChildren(last)[0];
    return last.type === 'selector' && access?.type === 'unconditional_assignable_selector' && namedChildren(access).find((child) => child.type === 'identifier')?.text === 'mounted' && nodes.slice(1).every((node) => node.type === 'selector');
};

// A statement that leaves the function on every path: `return`, `throw`,
// `rethrow`, or a block whose top-level statements reach one — with no
// `break`/`continue` anywhere inside (they could jump past the call).
const exitsUnconditionally = (statement: Node | undefined): boolean => {
    if (statement === undefined) {
        return false;
    }
    const isExit = (node: Node): boolean =>
        node.type === 'return_statement' || node.type === 'rethrow_statement' || (node.type === 'expression_statement' && namedChildren(node)[0]?.type === 'throw_expression');
    if (isExit(statement)) {
        return true;
    }
    if (statement.type !== 'block' || statement.descendantsOfType(['break_statement', 'continue_statement']).some((node) => node !== null)) {
        return false;
    }
    return namedChildren(statement).some(isExit);
};

const BRANCHING: ReadonlySet<string> = new Set(['if_statement', 'conditional_expression', 'switch_block']);

// True when `a` and `b` lie in DIFFERENT branches of the same `if`/`?:`/
// `switch` (Phase C): no path runs both, so an await there cannot precede
// the call (`if (x) { await a(); } else { setState(…); }`).
const exclusiveBranches = (a: Node, b: Node): boolean => {
    let common = a.parent;
    while (common !== null && !contains(common, b)) {
        common = common.parent;
    }
    if (common === null || !BRANCHING.has(common.type)) {
        return false;
    }
    const branches = common.type === 'switch_block' ? namedChildren(common).map((child) => [child]) : operands(common);
    const indexOf = (node: Node): number => branches.findIndex((group) => group.some((part) => contains(part, node)));
    const first = indexOf(a);
    const second = indexOf(b);
    // Index 0 of an if/?: is the condition: it precedes both branches.
    const isCondition = (index: number): boolean => common.type !== 'switch_block' && index === 0;
    return first >= 0 && second >= 0 && first !== second && !isCondition(first) && !isCondition(second);
};

const contains = (outer: Node, inner: Node): boolean => outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;

/**
 * Classifies the `mounted` mentions between the last await and a setState call
 * (see MountedGuard). Structural, within ONE function body: a mention counts
 * only as the condition of an `if` (or `?:`) in the call's own scope.
 */
const guardOf = (call: Node, scope: number | null, mentions: readonly Node[]): {guard: MountedGuard; mention: Node | null} => {
    if (mentions.length === 0) {
        return {guard: 'none', mention: null};
    }
    let unknown: Node | null = null;
    for (const mention of mentions) {
        const verdict = scopeOf(mention) === scope ? mentionGuards(mention, call) : null;
        if (verdict === true) {
            return {guard: 'dominating', mention};
        }
        if (verdict === null && unknown === null) {
            unknown = mention;
        }
    }
    return unknown !== null ? {guard: 'unknown', mention: unknown} : {guard: 'non-dominating', mention: mentions[0] as Node};
};

// true: this mention's condition guards `call`; false: it is an `if`/`?:`
// condition that provably does not; null: a shape not modelled.
const mentionGuards = (mention: Node, call: Node): boolean | null => {
    // Climb to the direct child of the `if`/`?:` holding the mention.
    let current: Node = mention;
    let parent = mention.parent;
    while (parent !== null && parent.type !== 'if_statement' && parent.type !== 'conditional_expression') {
        if (!CONDITION_PARTS.has(parent.type)) {
            return null;
        }
        current = parent;
        parent = parent.parent;
    }
    if (parent === null) {
        return null;
    }
    const groups = operands(parent);
    const test = groups[0];
    if (test === undefined || !test.some((node) => contains(node, current))) {
        return null; // the mention is in a branch, not the condition
    }
    const polarity = polarityOf(test);
    if (polarity === null) {
        return null;
    }
    const branch = (group: Node[] | undefined): Node | undefined => (group === undefined || group.length !== 1 ? undefined : group[0]);
    const whenTrue = parent.type === 'if_statement' ? branch(groups[1]) : groups[1]?.[0];
    const whenFalse = parent.type === 'if_statement' ? branch(groups[2]) : groups[2]?.[0];
    const whenMounted = polarity === 'mounted-if-true' ? whenTrue : whenFalse;
    const whenUnmounted = polarity === 'mounted-if-true' ? whenFalse : whenTrue;
    if (parent.type === 'conditional_expression') {
        const mountedGroup = polarity === 'mounted-if-true' ? groups[1] : groups[2];
        return mountedGroup !== undefined && mountedGroup.some((node) => contains(node, call));
    }
    if (whenMounted !== undefined && contains(whenMounted, call)) {
        return true;
    }
    // An early exit: the unmounted branch always leaves, and the call follows
    // the `if` in a block that encloses both.
    const block = parent.parent;
    return exitsUnconditionally(whenUnmounted) && parent.endIndex <= call.startIndex && block !== null && block.type === 'block' && contains(block, call);
};

const CONDITION_PARTS: ReadonlySet<string> = new Set([
    'parenthesized_expression',
    'unary_expression',
    'prefix_operator',
    'logical_and_expression',
    'logical_or_expression',
    'selector',
    'unconditional_assignable_selector'
]);

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
