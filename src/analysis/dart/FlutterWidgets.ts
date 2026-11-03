import type {Node} from 'web-tree-sitter';
import {asConstructor, callSiteOf, type DartCallSite} from './DartCallSite.js';
import {decodeArgValue, encodeArgValue, WIDGET_VALUE, type ArgValue, type EncodedArgValue} from './DartValues.js';

/**
 * Flutter widget STRUCTURE (Phase 1): per function/method body, the widget
 * expressions as a parent/child table — extracted here, during the one AST
 * pass, and stored as a single `ui.flutterWidgetTree` fact per function, so
 * the project-wide FlutterWidgetGraph (src/model/FlutterWidgetGraph.ts) is
 * rebuilt from facts alone — identically on a FactCache hit, which never
 * re-parses. No AST node and no source text leaves this module: names,
 * argument labels and positions only.
 *
 * What is (and is not) a widget is decided syntactically and conservatively:
 * - a widget node is a constructor-like call site (`Text(...)`, `const X(...)`,
 *   `m.X.named(...)`; see DartCallSite.asConstructor — a naming convention,
 *   not a type proof; identity is graded later in the graph);
 * - child edges follow only WIDGET SLOTS: a curated set of argument names that
 *   hold widgets in the Flutter framework (`child`, `children`, `body`, …) and
 *   `*builder` closures. Without types an argument like `padding:` cannot be
 *   proven non-widget, so non-slot arguments produce no node (their NAMES are
 *   kept in `argNames`); a widget passed through an unknown slot is a
 *   documented false negative, never an invented edge;
 * - inside a slot, nothing is dropped silently: a variable or helper call is a
 *   `reference`, an expression the extractor does not model is `dynamic`, a
 *   region tree-sitter could not parse is `unparsed`;
 * - callbacks (`onTap: () => ...`) are NOT children — a dialog opened from a
 *   button is not part of the button's subtree; widgets built inside them
 *   become roots of their own;
 * - a ROOT is a constructor-like call outside any tree that has at least one
 *   widget slot or builder argument (`AlertDialog(title: …)`,
 *   `SnackBar(content: …)`), or an expression a `Widget`-returning function
 *   returns. A slot-less call outside a tree (`Navigator.of(context)`,
 *   `Paint()`, `Offset(1, 2)`, `final t = Text('x')`) is not structure:
 *   without types it cannot be told from a non-widget, and where such a value
 *   is placed into a tree, that slot already holds a `reference` placeholder.
 */

export type WidgetNodeKind = 'widget' | 'reference' | 'builder' | 'conditional' | 'repeat' | 'spread' | 'list' | 'dynamic' | 'unparsed';
export type WidgetNodeStatus = 'known' | 'dynamic' | 'unparsed';

/**
 * One encoded node: [parent, label, index, kind, name, prefix, constructor,
 * startLine, startCol, endLine, endCol, argNames, status, argValues]. Tuples
 * instead of objects keep a large build() method's fact small;
 * `decodeWidgetTree` is the single place that reads the layout. `argValues`
 * (encoding v2) is aligned with `argNames` for `widget` nodes (see
 * DartValues.ts) and empty for every other kind (a builder's `argNames` are
 * its parameter names, which have no values).
 */
export type EncodedWidgetNode = [
    number,
    string | null,
    number,
    WidgetNodeKind,
    string | null,
    string | null,
    string | null,
    number,
    number,
    number,
    number,
    string[],
    WidgetNodeStatus,
    EncodedArgValue[]
];

export interface WidgetTreeValue {
    [key: string]: unknown;
    /** Encoding version of `nodes` (2 = with argument values). */
    v: 2;
    nodes: EncodedWidgetNode[];
    /** True when the node cap was hit and the rest of this function's tree was dropped. */
    truncated: boolean;
}

export interface DecodedWidgetNode {
    parent: number;
    /** The edge label from the parent: the slot name (`child`, `children`, `body`), `then`/`else`, `body` (repeat), `return` (builder), `element` (spread); null for a root. */
    label: string | null;
    /** Position within a list-valued slot / among a builder's returns; -1 when not positional. */
    index: number;
    kind: WidgetNodeKind;
    name: string | null;
    prefix: string | null;
    constructorName: string | null;
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    argNames: string[];
    status: WidgetNodeStatus;
    /** Aligned with `argNames` for widget nodes; empty otherwise. */
    argValues: ArgValue[];
}

export const decodeWidgetTree = (value: WidgetTreeValue): DecodedWidgetNode[] =>
    value.nodes.map(([parent, label, index, kind, name, prefix, constructorName, startLine, startCol, endLine, endCol, argNames, status, argValues]) => ({
        parent,
        label,
        index,
        kind,
        name,
        prefix,
        constructorName,
        startLine,
        startCol,
        endLine,
        endCol,
        argNames,
        status,
        argValues: argValues.map(decodeArgValue)
    }));

// Argument names that hold a widget (or a list of widgets) in the Flutter
// framework. A curated, documented catalog — the only way to tell a widget
// slot from `padding:`/`style:` without type information.
const WIDGET_SLOTS: ReadonlySet<string> = new Set([
    'child',
    'children',
    'body',
    'appBar',
    'title',
    'subtitle',
    'leading',
    'trailing',
    'actions',
    'icon',
    'selectedIcon',
    'activeIcon',
    'label',
    'content',
    'header',
    'footer',
    'drawer',
    'endDrawer',
    'bottomNavigationBar',
    'bottomSheet',
    'floatingActionButton',
    'persistentFooterButtons',
    'flexibleSpace',
    'bottom',
    'background',
    'secondary',
    'avatar',
    'deleteIcon',
    'prefix',
    'suffix',
    'prefixIcon',
    'suffixIcon',
    'placeholder',
    'home',
    'tabs',
    'slivers',
    'destinations',
    'items',
    'hint',
    'helper',
    'error',
    'counter',
    'labelWidget',
    'titleWidget',
    'emptyWidget',
    'loadingWidget',
    'errorWidget'
]);

const isBuilderLabel = (label: string): boolean => /builder$/i.test(label);

// A single build() is rarely beyond a few hundred nodes; the cap only bounds a
// pathological generated file. Hitting it is recorded (`truncated`), never silent.
const MAX_NODES_PER_FUNCTION = 2000;

interface Draft {
    parent: number;
    label: string | null;
    index: number;
}

/**
 * The widget tree of one function body, or null when it contains no widget
 * expression. `returnsWidget` (the signature's return type is `Widget`/`…Widget`)
 * lets a returned helper call or variable become a `reference` root instead of
 * being ignored.
 */
export const extractWidgetTree = (body: Node, prefixes: ReadonlySet<string>, returnsWidget: boolean): WidgetTreeValue | null => {
    const builder = new TreeBuilder(prefixes);
    if (returnsWidget) {
        builder.addReturnedRoots(body);
    }
    builder.scan(body, body);
    return builder.result();
};

class TreeBuilder {
    private readonly nodes: EncodedWidgetNode[] = [];
    // Call-site heads (by node id) already placed in — or deliberately
    // excluded by — a tree, so the root scan does not report them again.
    private readonly claimed = new Set<number>();
    // ERROR nodes already represented by an `unparsed` slot node.
    private readonly coveredErrors = new Set<number>();
    private truncated = false;

    public constructor(private readonly prefixes: ReadonlySet<string>) {}

    public result(): WidgetTreeValue | null {
        if (this.nodes.length === 0) {
            return null;
        }
        return {v: 2, nodes: this.nodes, truncated: this.truncated};
    }

    // Pre-order walk for ROOTS: every unclaimed constructor-like call site
    // starts a tree (pre-order: an outer widget is met before its children,
    // which it claims). Local function declarations are their own functions
    // (DartExtraction visits them separately) and are skipped.
    public scan(node: Node, root: Node): void {
        if (node.type === 'function_body' && node.id !== root.id) {
            return;
        }
        if (node.type === 'ERROR' && !this.coveredErrors.has(node.id)) {
            // Outside any slot (e.g. the grammar did not recognise `Column(` as
            // a call at all): recorded as an unparsed root so the gap is
            // visible; widgets inside it are still found as roots below.
            this.push({parent: -1, label: null, index: -1}, 'unparsed', {from: node, to: node}, {status: 'unparsed'});
        }
        const site = this.siteAt(node);
        if (site !== null && !this.claimed.has(site.head.id) && hasStructuralArgument(site.arguments)) {
            this.addWidget(site, {parent: -1, label: null, index: -1});
        }
        for (const child of namedChildren(node)) {
            this.scan(child, root);
        }
    }

    // For a function declared to return a widget, every returned expression
    // is that function's widget — a construction (even a slot-less `Icon(…)`),
    // a helper call or variable (`return _header();`, `=> child;`) alike.
    // Runs before the root scan, which then skips what this claimed.
    public addReturnedRoots(body: Node): void {
        for (const expression of returnedExpressions(body)) {
            this.addExpression(expression, {parent: -1, label: null, index: -1});
        }
    }

    private siteAt(node: Node): DartCallSite | null {
        const site = callSiteOf(node, this.prefixes);
        return site !== null && asConstructor(site) !== null ? site : null;
    }

    private push(draft: Draft, kind: WidgetNodeKind, span: {from: Node; to: Node}, extra: {name?: string | null; prefix?: string | null; constructorName?: string | null; argNames?: string[]; argValues?: EncodedArgValue[]; status?: WidgetNodeStatus} = {}): number {
        if (this.nodes.length >= MAX_NODES_PER_FUNCTION) {
            this.truncated = true;
            return -1;
        }
        this.nodes.push([
            draft.parent,
            draft.label,
            draft.index,
            kind,
            extra.name ?? null,
            extra.prefix ?? null,
            extra.constructorName ?? null,
            span.from.startPosition.row + 1,
            span.from.startPosition.column,
            span.to.endPosition.row + 1,
            span.to.endPosition.column,
            extra.argNames ?? [],
            extra.status ?? 'known',
            extra.argValues ?? []
        ]);
        return this.nodes.length - 1;
    }

    private addWidget(site: DartCallSite, draft: Draft): number {
        this.claimed.add(site.head.id);
        const ref = asConstructor(site);
        const args = argumentsOf(site.arguments);
        const named = args.filter((arg) => arg.label !== null);
        const index = this.push(draft, 'widget', {from: site.head, to: site.arguments}, {
            name: ref?.typeName ?? null,
            prefix: site.prefix,
            constructorName: ref?.constructorName ?? null,
            argNames: named.map((arg) => arg.label as string),
            argValues: named.map((arg) => this.valueOf(arg))
        });
        if (index < 0) {
            return index;
        }
        for (const arg of args) {
            if (arg.label !== null && WIDGET_SLOTS.has(arg.label)) {
                this.addSlot(arg.value, index, arg.label);
            } else if (arg.label !== null && isBuilderLabel(arg.label) && isSingle(arg.value, 'function_expression')) {
                this.addBuilder(arg.value[0] as Node, {parent: index, label: arg.label, index: -1});
            } else {
                // Not a widget slot: its value is data (`padding: EdgeInsets…`,
                // `style: TextStyle(…)`), not a child — claim the constructor-
                // like calls in it so they do not surface as roots. Closures
                // (callbacks) stay unclaimed: widgets built in them are roots.
                this.claimWithin(arg.value);
            }
        }
        return index;
    }

    // A named argument's value (DartValues). A widget slot holding anything but
    // a literal is a child (a graph node of its own), recorded only as `widget`.
    private valueOf(arg: Argument): EncodedArgValue {
        const encoded = encodeArgValue(arg.value, this.prefixes);
        if (arg.label !== null && WIDGET_SLOTS.has(arg.label) && !['b', 'n', 'i', 'd', 's'].includes(encoded[0])) {
            return WIDGET_VALUE;
        }
        return encoded;
    }

    // A slot value: a list literal fans out into indexed children, anything
    // else is one child.
    private addSlot(value: Node[], parent: number, label: string): void {
        const single = unwrap(value);
        if (single.length === 1 && single[0]?.type === 'list_literal') {
            listElements(single[0]).forEach((element, index) => this.addExpression(element, {parent, label, index}));
            return;
        }
        this.addExpression(single, {parent, label, index: -1});
    }

    private addExpression(expression: Node[], draft: Draft): void {
        const nodes = unwrap(expression);
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (first === undefined || last === undefined) {
            return;
        }
        const span = {from: first, to: last};
        // An ERROR at this expression's own level means its shape is unknown.
        // An error deeper inside is localized instead: widgets, lists,
        // conditionals descend and mark only the affected slot/element.
        if (nodes.some((node) => node.type === 'ERROR')) {
            this.addUnparsed(nodes, draft, span);
            return;
        }
        if (nodes.length === 1 && first.type.endsWith('_literal') && first.type !== 'list_literal') {
            return; // `child: null`, `label: 'Home'`, `3` — provably not a widget: no node.
        }
        if (nodes.length === 1 && first.type === 'list_literal') {
            this.addList(first, draft);
            return;
        }

        const site = callSiteOf(first, this.prefixes);
        if (site !== null) {
            if (asConstructor(site) !== null && endsWithCall(site.arguments, last)) {
                this.addWidget(site, draft);
                return;
            }
            if (nodes.some((node) => node.hasError)) {
                this.addUnparsed(nodes, draft, span);
                return;
            }
            // A helper/method call (`_header()`, `items.map(...)`) or a chained
            // call on a widget (`Image.asset(..).copyWith(..)`): the result is
            // not statically known. Closures passed to it may build widgets.
            const reference = this.push(draft, 'reference', span, {name: [...site.names].join('.'), prefix: site.prefix, status: 'dynamic'});
            if (reference >= 0) {
                this.claimed.add(site.head.id);
                this.addClosureBuilders(site.arguments, reference);
            }
            return;
        }

        const descends = ['if_element', 'conditional_expression', 'for_element', 'spread_element', 'function_expression'].includes(first.type);
        if (!descends && nodes.some((node) => node.hasError)) {
            this.addUnparsed(nodes, draft, span);
            return;
        }
        switch (first.type) {
            case 'identifier':
                // A variable / field / property access (`child`, `widget.child`).
                this.push(draft, 'reference', span, {name: nodes.map((node) => node.text).join(''), status: 'dynamic'});
                return;
            case 'if_element':
            case 'conditional_expression':
                this.addConditional(first, draft);
                return;
            case 'for_element':
                this.addRepeat(first, draft);
                return;
            case 'spread_element':
                this.addSpread(first, draft);
                return;
            case 'function_expression':
                this.addBuilder(first, draft);
                return;
            default:
                // `a ?? b`, `await x`, cascades, `this.x`, … — present but not modelled.
                this.push(draft, 'dynamic', span, {name: first.type, status: 'dynamic'});
                this.claimWithin(nodes);
        }
    }

    // A list value outside a list-valued slot (`cond ? [a, b] : [c]`): its
    // elements, indexed.
    private addList(list: Node, draft: Draft): void {
        const index = this.push(draft, 'list', {from: list, to: list});
        if (index >= 0) {
            listElements(list).forEach((element, position) => this.addExpression(element, {parent: index, label: 'element', index: position}));
        }
    }

    private addUnparsed(nodes: readonly Node[], draft: Draft, span: {from: Node; to: Node}): void {
        this.push(draft, 'unparsed', span, {status: 'unparsed'});
        this.claimWithin(nodes);
        for (const node of nodes) {
            if (node.type === 'ERROR') {
                this.coveredErrors.add(node.id);
            }
            descendantsOf(node, 'ERROR').forEach((error) => this.coveredErrors.add(error.id));
        }
    }

    private addConditional(node: Node, draft: Draft): void {
        const index = this.push(draft, 'conditional', {from: node, to: node});
        if (index < 0) {
            return;
        }
        this.addExpression(fieldNodes(node, 'consequence'), {parent: index, label: 'then', index: -1});
        this.addExpression(fieldNodes(node, 'alternative'), {parent: index, label: 'else', index: -1});
    }

    private addRepeat(node: Node, draft: Draft): void {
        const index = this.push(draft, 'repeat', {from: node, to: node});
        if (index >= 0) {
            this.addExpression(fieldNodes(node, 'body'), {parent: index, label: 'body', index: -1});
        }
    }

    private addSpread(node: Node, draft: Draft): void {
        const inner = namedChildren(node);
        const literal = inner.length === 1 && inner[0]?.type === 'list_literal' ? inner[0] : null;
        const index = this.push(draft, 'spread', {from: node, to: node}, {status: literal === null ? 'dynamic' : 'known'});
        if (index < 0) {
            return;
        }
        if (literal !== null) {
            listElements(literal).forEach((element, position) => this.addExpression(element, {parent: index, label: 'element', index: position}));
        } else {
            this.addExpression(inner, {parent: index, label: 'element', index: -1});
        }
    }

    // A builder closure: its returned expressions are its children (a block
    // body may return different widgets on different paths — all are kept,
    // indexed). Anything else built inside the closure is found by the root scan.
    private addBuilder(closure: Node, draft: Draft): void {
        const parameters = closure.childForFieldName('parameters');
        const index = this.push(draft, 'builder', {from: closure, to: closure}, {
            argNames: parameters === null ? [] : descendantsOf(parameters, 'identifier').map((identifier) => identifier.text)
        });
        if (index < 0) {
            return;
        }
        const body = closure.childForFieldName('body');
        if (body === null) {
            return;
        }
        returnedExpressions(body).forEach((expression, position) => this.addExpression(expression, {parent: index, label: 'return', index: position}));
    }

    // Closures handed to a non-widget call (`items.map((e) => Text(e))`,
    // `showDialog(builder: …)`) — positional ones and `*builder` ones build
    // what the call returns; other named closures are callbacks.
    private addClosureBuilders(args: Node, parent: number): void {
        for (const arg of argumentsOf(args)) {
            if (isSingle(arg.value, 'function_expression') && (arg.label === null || isBuilderLabel(arg.label))) {
                this.addBuilder(arg.value[0] as Node, {parent, label: arg.label ?? 'builder', index: -1});
            }
        }
    }

    // Marks the constructor-like call sites inside `nodes` as handled (they
    // are data, not roots) — except inside closures, whose widgets are roots.
    private claimWithin(nodes: readonly Node[]): void {
        const visit = (node: Node): void => {
            if (node.type === 'function_expression') {
                return;
            }
            const site = this.siteAt(node);
            if (site !== null) {
                this.claimed.add(site.head.id);
            }
            for (const child of namedChildren(node)) {
                visit(child);
            }
        };
        nodes.forEach(visit);
    }
}

interface Argument {
    label: string | null;
    value: Node[];
}

const argumentsOf = (args: Node): Argument[] => {
    const result: Argument[] = [];
    for (const child of namedChildren(args)) {
        if (child.type === 'named_argument') {
            const parts = namedChildren(child);
            const label = parts.find((part) => part.type === 'label');
            const name = label === undefined ? undefined : namedChildren(label).find((part) => part.type === 'identifier')?.text;
            result.push({label: name ?? null, value: parts.filter((part) => part.type !== 'label' && part.type !== 'comment')});
        } else if (child.type === 'argument') {
            result.push({label: null, value: namedChildren(child).filter((part) => part.type !== 'comment')});
        }
    }
    return result;
};

// The elements of a list literal. tree-sitter-dart flattens a call inside the
// list into sibling nodes (`Text`, `selector`), so elements are recovered by
// splitting the children at the anonymous ',' tokens between '[' and ']'.
const listElements = (list: Node): Node[][] => {
    const elements: Node[][] = [];
    let current: Node[] = [];
    let open = false;
    for (const child of list.children) {
        if (child === null) {
            continue;
        }
        if (!open) {
            open = child.type === '[';
            continue;
        }
        if (child.type === ',' || child.type === ']') {
            if (current.length > 0) {
                elements.push(current);
            }
            current = [];
            continue;
        }
        if (child.isNamed && child.type !== 'comment') {
            current.push(child);
        }
    }
    return elements;
};

// The expressions a function body / closure body returns, without descending
// into nested closures or local functions (their returns are theirs).
const returnedExpressions = (body: Node): Node[][] => {
    const named = namedChildren(body);
    const block = named.find((child) => child.type === 'block');
    if (block === undefined) {
        // Expression body: `=> expr` — the expression is the body's children.
        const expression = named.filter((child) => child.type !== 'comment');
        return expression.length > 0 ? [expression] : [];
    }
    const found: Node[][] = [];
    const visit = (node: Node): void => {
        for (const child of namedChildren(node)) {
            if (child.type === 'function_expression' || child.type === 'function_body') {
                continue;
            }
            if (child.type === 'return_statement') {
                const expression = namedChildren(child).filter((part) => part.type !== 'comment');
                if (expression.length > 0) {
                    found.push(expression);
                }
                continue;
            }
            visit(child);
        }
    };
    visit(block);
    return found;
};

const fieldNodes = (node: Node, field: string): Node[] => node.childrenForFieldName(field).filter((child): child is Node => child !== null && child.isNamed);

const unwrap = (nodes: Node[]): Node[] => {
    let current = nodes;
    while (current.length === 1 && current[0]?.type === 'parenthesized_expression') {
        current = namedChildren(current[0]);
    }
    return current;
};

const isSingle = (nodes: Node[], type: string): boolean => nodes.length === 1 && nodes[0]?.type === type;

// Whether a call carries structure: at least one widget-slot or builder argument.
const hasStructuralArgument = (args: Node): boolean =>
    argumentsOf(args).some((arg) => arg.label !== null && (WIDGET_SLOTS.has(arg.label) || (isBuilderLabel(arg.label) && isSingle(arg.value, 'function_expression'))));

// Whether the call's argument list ends the expression — its last node (the
// call's selector, or the const/new expression itself) contains `args`, so no
// further selector (`.copyWith(...)`, `!`) is applied to the constructed value.
const endsWithCall = (args: Node, last: Node): boolean => last.startIndex <= args.startIndex && args.endIndex <= last.endIndex;

const descendantsOf = (node: Node, type: string): Node[] => node.descendantsOfType(type).filter((candidate): candidate is Node => candidate !== null);

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
