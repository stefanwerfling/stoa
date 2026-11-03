import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import {asConstructor, callSiteOf, callSites, type DartCallSite} from './DartCallSite.js';
import {identityFrom, type WidgetIdentity} from './DartIdentity.js';

type Build = (spec: FactSpec) => Fact;

/** Grades `prefix.name` in the file being extracted (see DartIdentity.identityOf). */
export type FileIdentity = (name: string, prefix: string | null) => WidgetIdentity;

const FLUTTER_PACKAGE = 'package:flutter/';
const A11Y_WIDGETS: ReadonlySet<string> = new Set(['Image', 'IconButton', 'TextField', 'TextFormField']);

/**
 * Widget-aware accessibility facts for Flutter (Dart). Flutter has no HTML/ARIA;
 * accessibility is carried by widget properties (`semanticLabel`, `tooltip`,
 * `InputDecoration.labelText`) and the `Semantics` widget. This emits only the
 * cleanest, low-false-positive static checks: an `Image*` built with neither
 * `semanticLabel:` nor `excludeFromSemantics: true`, an `IconButton` built without
 * `tooltip:`, and a `TextField`/`TextFormField` whose `InputDecoration` carries no
 * label/hint (or which has no `decoration:` at all).
 *
 * Candidates (Phase 4 hardening, rule version 1.1.0):
 * - every call-site form counts — `Image(…)`, `const Image(…)`, `new Image(…)`,
 *   `m.Image(…)` (DartCallSite) — and only when the name is Flutter's: graded
 *   per file from its own imports/declarations, a `package:flutter/` import
 *   candidate is required (a same-file class of that name shadows it);
 * - the search stays over the WHOLE file, not the widget graph: a widget in an
 *   argument that is not a graph slot (`suffixIcon:`) or in a method the grammar
 *   cannot structure (Dart 3 syntax) is still found.
 *
 * Ancestors that name or hide the widget (walked up the AST, stopping at a
 * callback closure — a widget built in `onTap:` is not inside its caller's
 * semantics; a `*builder:` closure is passed through):
 * - `Semantics(label: <non-empty>)` names the subtree (all three checks);
 * - `ExcludeSemantics(…)` removes it from the semantics tree (all three checks;
 *   `excluding: false` keeps it);
 * - `Tooltip(message:/richMessage: …)` names an IconButton inside it.
 * Not resolved (documented in missingContext): a label on a child widget, a
 * decoration built elsewhere (variable, `copyWith`), `Semantics(value:/hint:)`
 * and `MergeSemantics` (still reported — a sibling may or may not name it).
 */
export const extractFlutterA11yFacts = (root: Node, build: Build, identity: FileIdentity, prefixes: ReadonlySet<string>): Fact[] => {
    const facts: Fact[] = [];
    let imageIndex = 0;
    let iconButtonIndex = 0;
    let textFieldIndex = 0;

    for (const site of callSites(root)) {
        const ctor = asConstructor(site);
        if (ctor === null || !A11Y_WIDGETS.has(ctor.typeName)) {
            continue;
        }
        // `IconButton.styleFrom(...)` and friends are static ButtonStyle factories,
        // not widget constructors — they carry no tooltip/label and must not be
        // flagged (e.g. inside an IconButtonThemeData).
        if (ctor.constructorName !== null && NON_WIDGET_FACTORIES.has(ctor.constructorName)) {
            continue;
        }
        if (!identityFrom(identity(ctor.typeName, site.prefix), FLUTTER_PACKAGE)) {
            continue;
        }
        const widget = ctor.typeName;
        if (namedOrHiddenByAncestor(site.head, widget, prefixes)) {
            continue;
        }
        const named = directNamedArguments(site.arguments);
        const anchor = anchorOf(site, widget);

        if (widget === 'Image' && !named.has('semanticLabel') && !isExcludedFromSemantics(named)) {
            facts.push(build({kind: 'ui.flutterImageNoSemanticLabel', kindOf: 'statement', symbol: `image#${imageIndex}`, range: rangeOf(anchor), value: evidence(site)}));
            imageIndex += 1;
        }
        if (widget === 'IconButton' && !named.has('tooltip')) {
            facts.push(build({kind: 'ui.flutterIconButtonNoTooltip', kindOf: 'statement', symbol: `iconButton#${iconButtonIndex}`, range: rangeOf(anchor), value: evidence(site)}));
            iconButtonIndex += 1;
        }
        if ((widget === 'TextField' || widget === 'TextFormField') && isTextFieldUnlabelled(named, prefixes)) {
            facts.push(build({kind: 'ui.flutterTextFieldNoLabel', kindOf: 'statement', symbol: `textField#${textFieldIndex}`, range: rangeOf(anchor), value: evidence(site)}));
            textFieldIndex += 1;
        }
    }

    return facts;
};

// Static helper methods on the widget classes that return a value (a ButtonStyle),
// not a widget — so a call like IconButton.styleFrom(...) must not be treated as a
// widget constructor. Shared by the button widgets (ElevatedButton.styleFrom, …);
// only IconButton is in our widget set, but the name is the same across them.
const NON_WIDGET_FACTORIES: ReadonlySet<string> = new Set(['styleFrom']);

// The node a finding points at: the type name. For the bare unprefixed form that
// is the head identifier (unchanged from rule version 1.0.0, so existing findings
// keep their position); for `const`/`new` the type identifier inside the
// expression; for `m.Image(…)` the head (the prefix) — the call's start.
const anchorOf = (site: DartCallSite, typeName: string): Node => {
    if (site.form === 'call') {
        return site.head;
    }
    return namedChildren(site.head).find((child) => (child.type === 'type_identifier' || child.type === 'identifier') && child.text === typeName) ?? site.head;
};

// Whether an ancestor names or hides the widget (see the module comment). Stops
// at a closure that is not a `*builder:` argument.
const namedOrHiddenByAncestor = (start: Node, widget: string, prefixes: ReadonlySet<string>): boolean => {
    let node: Node | null = start.parent;
    while (node !== null) {
        if (node.type === 'function_expression' && !isBuilderClosure(node)) {
            return false;
        }
        if (node.type === 'arguments') {
            const owner = ownerCall(node, prefixes);
            const ctor = owner === null ? null : asConstructor(owner);
            if (ctor !== null) {
                const named = directNamedArguments(node);
                if (ctor.typeName === 'Semantics') {
                    const label = named.get('label');
                    if (label !== undefined && labelIsMeaningful(label)) {
                        return true;
                    }
                } else if (ctor.typeName === 'ExcludeSemantics') {
                    if (!argumentIsLiteral(named.get('excluding'), 'false')) {
                        return true;
                    }
                } else if (ctor.typeName === 'Tooltip' && widget === 'IconButton') {
                    const message = named.get('message') ?? named.get('richMessage');
                    if (message !== undefined && labelIsMeaningful(message)) {
                        return true;
                    }
                }
            }
        }
        node = node.parent;
    }
    return false;
};

// `builder: (context) => …`, `itemBuilder: …` — a closure that builds the subtree
// in place; any other closure (onTap:, a positional callback) is not.
const isBuilderClosure = (closure: Node): boolean => {
    const parent = closure.parent;
    if (parent === null || parent.type !== 'named_argument') {
        return false;
    }
    const label = namedChildren(parent).find((node) => node.type === 'label');
    const name = label === undefined ? undefined : namedChildren(label).find((node) => node.type === 'identifier')?.text;
    return name !== undefined && /builder$/i.test(name);
};

// The call site whose argument list is `args`: a `const`/`new` expression, or the
// head identifier before the selector run that carries it.
const ownerCall = (args: Node, prefixes: ReadonlySet<string>): DartCallSite | null => {
    const parent = args.parent;
    if (parent === null) {
        return null;
    }
    if (parent.type === 'const_object_expression' || parent.type === 'new_expression') {
        return callSiteOf(parent, prefixes);
    }
    const selector = parent.type === 'argument_part' ? parent.parent : null;
    if (selector === null || selector.type !== 'selector') {
        return null;
    }
    let previous = selector.previousNamedSibling;
    while (previous !== null && previous.type === 'selector') {
        previous = previous.previousNamedSibling;
    }
    if (previous === null || previous.type !== 'identifier') {
        return null;
    }
    const site = callSiteOf(previous, prefixes);
    return site !== null && site.arguments.id === args.id ? site : null;
};

// Whether a Semantics `label:` (or Tooltip `message:`) argument actually provides a
// name: a non-empty value. An empty string literal does not; a dynamic/computed
// value is assumed to (conservative — avoids a false positive on a genuinely
// labelled widget).
const labelIsMeaningful = (label: Node): boolean => {
    const value = namedChildren(label).filter((node) => node.type !== 'label').pop();
    if (value === undefined) {
        return false;
    }
    const text = value.text.trim();
    return text.length > 0 && text !== "''" && text !== '""';
};

// Whether a named argument's value is exactly the literal `literal`.
const argumentIsLiteral = (argument: Node | undefined, literal: string): boolean => {
    if (argument === undefined) {
        return false;
    }
    const value = namedChildren(argument).filter((node) => node.type !== 'label').pop();
    return value !== undefined && value.text.trim() === literal;
};

// label -> the named_argument node, for the direct named arguments of this call
// (nested widgets' named arguments live deeper and are not included).
const directNamedArguments = (args: Node): Map<string, Node> => {
    const named = new Map<string, Node>();
    for (const child of namedChildren(args)) {
        if (child.type !== 'named_argument') {
            continue;
        }
        const label = namedChildren(child).find((node) => node.type === 'label');
        const name = label === undefined ? undefined : namedChildren(label).find((node) => node.type === 'identifier')?.text;
        if (name !== undefined) {
            named.set(name, child);
        }
    }
    return named;
};

// Whether excludeFromSemantics is passed as the literal true (decorative image).
const isExcludedFromSemantics = (named: Map<string, Node>): boolean => {
    const argument = named.get('excludeFromSemantics');
    if (argument === undefined) {
        return false;
    }
    const value = namedChildren(argument).filter((node) => node.type !== 'label').pop();
    return value !== undefined && value.text.trim() === 'true';
};

// The InputDecoration labelled-input keys: any of these gives the field an
// accessible name (labelText/label are proper labels; hintText is weaker but
// still announced, so its presence makes the field not provably nameless).
const DECORATION_LABEL_KEYS = ['labelText', 'label', 'hintText'];

// Whether this text field provably has no accessible label. A field with no
// `decoration:` at all has no label/hint; a `decoration: InputDecoration(...)`
// literal (any call form, incl. `const InputDecoration(…)`) is inspected for a
// label key. A decoration that is a variable or a chained/computed expression
// (e.g. `.copyWith(...)`) is present-but-unknown and does NOT flag, so the check
// never invents a false positive.
const isTextFieldUnlabelled = (named: Map<string, Node>, prefixes: ReadonlySet<string>): boolean => {
    const decoration = named.get('decoration');
    if (decoration === undefined) {
        return true;
    }
    const inputDecoration = inputDecorationArguments(decoration, prefixes);
    if (inputDecoration === null) {
        return false;
    }
    const decorationNamed = directNamedArguments(inputDecoration);
    return !DECORATION_LABEL_KEYS.some((key) => decorationNamed.has(key));
};

// The argument list of a `decoration: InputDecoration(...)` literal, or null when the
// decoration value is not exactly one InputDecoration call (a variable, or a chained
// expression such as InputDecoration(...).copyWith(...) whose final labels we cannot
// resolve statically) — in which case the field is left unflagged.
const inputDecorationArguments = (decoration: Node, prefixes: ReadonlySet<string>): Node | null => {
    const value = namedChildren(decoration).find((node) => node.type !== 'label');
    const site = value === undefined ? null : callSiteOf(value, prefixes);
    if (site === null || asConstructor(site)?.typeName !== 'InputDecoration' || site.names.length !== 1) {
        return null;
    }
    return site.arguments.endIndex === decoration.endIndex ? site.arguments : null;
};

const firstDescendant = (node: Node, type: string): Node | null => {
    return node.descendantsOfType(type).find((candidate): candidate is Node => candidate !== null) ?? null;
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

// The widget call itself as evidence — the head identifier plus its following
// selectors up to and including the argument list (e.g. `Image.asset('logo.png')`,
// `IconButton(onPressed: f, icon: Icon(...))`), or the whole `const`/`new`
// expression. Using identifier.parent.text would capture the whole enclosing
// expression (a Row/list/ternary), which is misleading.
const evidence = (site: DartCallSite): string => {
    if (site.form !== 'call') {
        return truncate(site.head.text);
    }
    const identifier = site.head;
    let text = identifier.text;
    let sibling = identifier.nextNamedSibling;
    while (sibling !== null && sibling.type === 'selector') {
        text += sibling.text;
        if (firstDescendant(sibling, 'arguments') !== null) {
            break;
        }
        sibling = sibling.nextNamedSibling;
    }
    return truncate(text);
};

const truncate = (text: string): string => {
    const flattened = text.replace(/\s+/g, ' ').trim();
    return flattened.length > 80 ? `${flattened.slice(0, 77)}...` : flattened;
};

const rangeOf = (node: Node): SourceRange => {
    return {startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: node.endPosition.row + 1, endCol: node.endPosition.column};
};
