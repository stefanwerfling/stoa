import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';

type Build = (spec: FactSpec) => Fact;

/**
 * Widget-aware accessibility facts for Flutter (Dart). Flutter has no HTML/ARIA;
 * accessibility is carried by widget properties (`semanticLabel`, `tooltip`) and
 * the `Semantics` widget. This emits only the two cleanest, low-false-positive
 * static checks: an `Image*` built with neither `semanticLabel:` nor
 * `excludeFromSemantics: true`, and an `IconButton` built without `tooltip:`.
 * Each is a fact about that widget's own constructor arguments — an ancestor
 * `Semantics(...)` wrapper or a label on a child widget is not resolved (noted in
 * the rules' missingContext), so the checks stay conservative.
 */
export const extractFlutterA11yFacts = (root: Node, build: Build): Fact[] => {
    const facts: Fact[] = [];
    let imageIndex = 0;
    let iconButtonIndex = 0;

    for (const identifier of descendants(root, 'identifier')) {
        const widget = identifier.text;
        if (widget !== 'Image' && widget !== 'IconButton') {
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
    }

    return facts;
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

const evidence = (identifier: Node): string => {
    const call = identifier.parent ?? identifier;
    const text = call.text.replace(/\s+/g, ' ').trim();
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

const rangeOf = (node: Node): SourceRange => {
    return {startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: node.endPosition.row + 1, endCol: node.endPosition.column};
};
