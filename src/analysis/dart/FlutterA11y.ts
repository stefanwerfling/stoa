import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';

type Build = (spec: FactSpec) => Fact;

/**
 * Widget-aware accessibility facts for Flutter (Dart). Flutter has no HTML/ARIA;
 * accessibility is carried by widget properties (`semanticLabel`, `tooltip`,
 * `InputDecoration.labelText`) and the `Semantics` widget. This emits only the
 * cleanest, low-false-positive static checks: an `Image*` built with neither
 * `semanticLabel:` nor `excludeFromSemantics: true`, an `IconButton` built without
 * `tooltip:`, and a `TextField`/`TextFormField` whose `InputDecoration` carries no
 * label/hint (or which has no `decoration:` at all). Each check reads the widget's
 * own constructor arguments, plus one ancestor relationship: a wrapping
 * `Semantics(label: …)` names the whole subtree, so a widget inside it is treated
 * as named and not flagged. A label on a child widget, a decoration built elsewhere
 * (variable, `copyWith`), or a name via `Semantics(value:/hint:)` or `MergeSemantics`
 * is not resolved (noted in the rules' missingContext), so the checks stay conservative.
 */
export const extractFlutterA11yFacts = (root: Node, build: Build): Fact[] => {
    const facts: Fact[] = [];
    let imageIndex = 0;
    let iconButtonIndex = 0;
    let textFieldIndex = 0;

    for (const identifier of descendants(root, 'identifier')) {
        const widget = identifier.text;
        if (widget !== 'Image' && widget !== 'IconButton' && widget !== 'TextField' && widget !== 'TextFormField') {
            continue;
        }
        // `IconButton.styleFrom(...)` and friends are static ButtonStyle factories,
        // not widget constructors — they carry no tooltip/label and must not be
        // flagged (e.g. inside an IconButtonThemeData). A widget is a bare
        // `Widget(...)` or a widget named constructor (Image.network, IconButton.filled).
        const invoked = invokedConstructorName(identifier);
        if (invoked !== null && NON_WIDGET_FACTORIES.has(invoked)) {
            continue;
        }
        // An ancestor Semantics(label: …) gives the whole subtree an accessible
        // name, so a widget inside it is already named — do not flag any of the
        // three checks. An empty label does not count; a dynamic label is assumed
        // to name it (conservative). A Semantics without a label is not a name.
        if (hasLabelledSemanticsAncestor(identifier)) {
            continue;
        }
        const args = constructorArguments(identifier);
        if (args === null) {
            continue;
        }
        const named = directNamedArguments(args);

        if (widget === 'Image' && !named.has('semanticLabel') && !isExcludedFromSemantics(named)) {
            facts.push(build({kind: 'ui.flutterImageNoSemanticLabel', kindOf: 'statement', symbol: `image#${imageIndex}`, range: rangeOf(identifier), value: evidence(identifier)}));
            imageIndex += 1;
        }
        if (widget === 'IconButton' && !named.has('tooltip')) {
            facts.push(build({kind: 'ui.flutterIconButtonNoTooltip', kindOf: 'statement', symbol: `iconButton#${iconButtonIndex}`, range: rangeOf(identifier), value: evidence(identifier)}));
            iconButtonIndex += 1;
        }
        if ((widget === 'TextField' || widget === 'TextFormField') && isTextFieldUnlabelled(named)) {
            facts.push(build({kind: 'ui.flutterTextFieldNoLabel', kindOf: 'statement', symbol: `textField#${textFieldIndex}`, range: rangeOf(identifier), value: evidence(identifier)}));
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

// The name invoked on `identifier` right before its argument list: a named
// constructor or static method (e.g. 'network' for Image.network(...), 'styleFrom'
// for IconButton.styleFrom(...)), or null for a bare `Widget(...)` call. It is the
// last name-selector seen before the first `arguments`-bearing selector.
const invokedConstructorName = (identifier: Node): string | null => {
    let sibling = identifier.nextNamedSibling;
    let lastName: string | null = null;
    while (sibling !== null) {
        if (sibling.type === 'selector') {
            if (firstDescendant(sibling, 'arguments') !== null) {
                return lastName;
            }
            const selector = firstDescendant(sibling, 'unconditional_assignable_selector');
            if (selector !== null) {
                lastName = namedChildren(selector).find((node) => node.type === 'identifier')?.text ?? lastName;
            }
        }
        sibling = sibling.nextNamedSibling;
    }
    return lastName;
};

// Whether `identifier` sits inside a `Semantics(label: …)` call that gives its
// subtree an accessible name. Walks the ancestors looking for an `arguments` node
// whose call head is `Semantics` and which carries a meaningful `label:` argument.
const hasLabelledSemanticsAncestor = (identifier: Node): boolean => {
    let node: Node | null = identifier.parent;
    while (node !== null) {
        if (node.type === 'arguments' && argumentsCallHead(node) === 'Semantics') {
            const label = directNamedArguments(node).get('label');
            if (label !== undefined && labelIsMeaningful(label)) {
                return true;
            }
        }
        node = node.parent;
    }
    return false;
};

// The head identifier of the call whose argument list is `args` (the name before
// the `(`), or null. `args` → argument_part → selector; the head is the first
// non-selector named sibling before that selector.
const argumentsCallHead = (args: Node): string | null => {
    const selector = args.parent?.parent ?? null;
    if (selector === null || selector.type !== 'selector') {
        return null;
    }
    let previous = selector.previousNamedSibling;
    while (previous !== null && previous.type === 'selector') {
        previous = previous.previousNamedSibling;
    }
    return previous !== null && previous.type === 'identifier' ? previous.text : null;
};

// Whether a Semantics `label:` argument actually provides a name: a non-empty
// value. An empty string literal does not; a dynamic/computed value is assumed to
// (conservative — avoids a false positive on a genuinely labelled widget).
const labelIsMeaningful = (label: Node): boolean => {
    const value = namedChildren(label).filter((node) => node.type !== 'label').pop();
    if (value === undefined) {
        return false;
    }
    const text = value.text.trim();
    return text.length > 0 && text !== "''" && text !== '""';
};

// The argument list of the constructor call headed by `identifier` (handling
// named constructors like Image.network): the first `arguments` reachable
// through the identifier's following `selector` siblings. null when the
// identifier is not a call head (e.g. `Image` used as a type).
const constructorArguments = (identifier: Node): Node | null => {
    let sibling = identifier.nextNamedSibling;
    while (sibling !== null) {
        if (sibling.type === 'selector') {
            const args = firstDescendant(sibling, 'arguments');
            if (args !== null) {
                return args;
            }
        }
        sibling = sibling.nextNamedSibling;
    }
    return null;
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
// literal is inspected for a label key. A decoration that is a variable or a
// chained/computed expression (e.g. `.copyWith(...)`) is present-but-unknown and
// does NOT flag, so the check never invents a false positive.
const isTextFieldUnlabelled = (named: Map<string, Node>): boolean => {
    const decoration = named.get('decoration');
    if (decoration === undefined) {
        return true;
    }
    const inputDecoration = inputDecorationArguments(decoration);
    if (inputDecoration === null) {
        return false;
    }
    const decorationNamed = directNamedArguments(inputDecoration);
    return !DECORATION_LABEL_KEYS.some((key) => decorationNamed.has(key));
};

// The argument list of a `decoration: InputDecoration(...)` literal, or null when the
// decoration value is not a direct InputDecoration call (a variable, or a chained
// expression such as InputDecoration(...).copyWith(...) whose final labels we cannot
// resolve statically) — in which case the field is left unflagged.
const inputDecorationArguments = (decoration: Node): Node | null => {
    const value = namedChildren(decoration).find((node) => node.type !== 'label');
    if (value === undefined) {
        return null;
    }
    const head = firstDescendant(value, 'identifier');
    if (head === null || head.text !== 'InputDecoration' || /\.(copyWith|merge)\b/.test(value.text)) {
        return null;
    }
    return constructorArguments(head);
};

const descendants = (node: Node, type: string): Node[] => {
    return node.descendantsOfType(type).filter((candidate): candidate is Node => candidate !== null);
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
// `IconButton(onPressed: f, icon: Icon(...))`). Using identifier.parent.text would
// capture the whole enclosing expression (a Row/list/ternary), which is misleading.
const evidence = (identifier: Node): string => {
    let text = identifier.text;
    let sibling = identifier.nextNamedSibling;
    while (sibling !== null && sibling.type === 'selector') {
        text += sibling.text;
        if (firstDescendant(sibling, 'arguments') !== null) {
            break;
        }
        sibling = sibling.nextNamedSibling;
    }
    const flattened = text.replace(/\s+/g, ' ').trim();
    return flattened.length > 80 ? `${flattened.slice(0, 77)}...` : flattened;
};

const rangeOf = (node: Node): SourceRange => {
    return {startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: node.endPosition.row + 1, endCol: node.endPosition.column};
};
