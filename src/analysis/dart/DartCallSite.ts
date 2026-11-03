import type {Node} from 'web-tree-sitter';
import type {SourceRange} from '../../Types.js';

/**
 * One normalized Dart call / instance-creation site. tree-sitter-dart has NO
 * call node: `Text('a')` is a primary `identifier` followed by `selector`
 * SIBLINGS in the parent (one of them carrying the `arguments`), while
 * `const Text('a')` and `new Text('a')` are dedicated `const_object_expression`
 * / `new_expression` nodes. This module folds all three shapes — plus import
 * prefixes, named constructors and type arguments — into one record, so later
 * extractors (Flutter widget structure, declarations) read ONE shape instead
 * of re-implementing the sibling walk.
 *
 * Extraction-time only: `head` and `arguments` are AST nodes and must never be
 * stored beyond the adapter's extractFacts() call (the tree is released right
 * after). Only `form`, `prefix`, `names`, `typeArguments` and `range` are plain
 * data.
 *
 * Deliberately NOT a type resolution: `names` is what the source spells. Whether
 * `Image` is Flutter's Image is decided elsewhere (see the Flutter analysis
 * report, widget identity).
 */
export type DartCallForm = 'call' | 'const' | 'new';

export interface DartCallSite {
    form: DartCallForm;
    /** The import prefix (`m` in `m.Image(...)`), only when this file declares it via `import ... as m`; otherwise null. */
    prefix: string | null;
    /** The name chain after the prefix up to the invocation: `['Text']`, `['Image', 'asset']`, `['items', 'map']`. */
    names: readonly string[];
    /** Type arguments as written (`['int']` for `Foo<int>(...)`), empty when none. */
    typeArguments: readonly string[];
    /** First node of the site (the prefix or the first name; the `const`/`new` expression itself for those forms). Extraction-time only. */
    head: Node;
    /** The `arguments` node of the invocation. Extraction-time only. */
    arguments: Node;
    /** From the head (incl. `const`/`new` and prefix) to the end of the argument list. */
    range: SourceRange;
}

/** A call site read as an instance creation: the type name and, if any, the named constructor. */
export interface DartConstructorRef {
    typeName: string;
    constructorName: string | null;
}

// Parents in which an identifier is NOT a primary expression but a member name
// (`.asset`), an argument label (`child:`) or similar.
const NON_PRIMARY_PARENTS: ReadonlySet<string> = new Set(['unconditional_assignable_selector', 'conditional_assignable_selector', 'label']);

/**
 * The import prefixes this file declares (`import '...' as m;` → `m`).
 * Syntactic and file-local; a local variable shadowing a prefix name is not
 * detected (documented limitation).
 */
export const importPrefixes = (root: Node): ReadonlySet<string> => {
    const prefixes = new Set<string>();
    for (const spec of root.descendantsOfType('import_specification')) {
        if (spec === null) {
            continue;
        }
        // The prefix is the import_specification's own identifier child;
        // show/hide names live one level deeper, inside `combinator`.
        const prefix = namedChildren(spec).find((child) => child.type === 'identifier');
        if (prefix !== undefined) {
            prefixes.add(prefix.text);
        }
    }
    return prefixes;
};

/**
 * Normalizes `node` into a call site, or null when it does not start one:
 * a primary `identifier` whose selector run reaches an argument list, a
 * `const_object_expression` or a `new_expression`. For the bare-call form only
 * the FIRST invocation of the chain is the site (`Image.asset('x').copyWith()`
 * is the site `Image.asset`; the chained call operates on its result).
 */
export const callSiteOf = (node: Node, prefixes: ReadonlySet<string>): DartCallSite | null => {
    if (node.type === 'const_object_expression' || node.type === 'new_expression') {
        return creationSite(node, node.type === 'const_object_expression' ? 'const' : 'new', prefixes);
    }
    if (node.type !== 'identifier' || (node.parent !== null && NON_PRIMARY_PARENTS.has(node.parent.type))) {
        return null;
    }
    return bareCallSite(node, prefixes);
};

/** Every call site in `root`, in source order (deterministic). */
export const callSites = (root: Node): DartCallSite[] => {
    const prefixes = importPrefixes(root);
    const sites: DartCallSite[] = [];
    for (const node of root.descendantsOfType(['identifier', 'const_object_expression', 'new_expression'])) {
        if (node === null) {
            continue;
        }
        const site = callSiteOf(node, prefixes);
        if (site !== null) {
            sites.push(site);
        }
    }
    return sites.sort((a, b) => a.head.startIndex - b.head.startIndex || a.arguments.startIndex - b.arguments.startIndex);
};

/**
 * Reads a call site as an instance creation, or null when it cannot be one by
 * its shape. `const`/`new` always are; a bare call is when its chain is one or
 * two names and the first is UpperCamelCase — a Dart naming CONVENTION, not a
 * proof (a top-level function named `Foo` would match), so consumers must
 * treat the result as heuristic.
 */
export const asConstructor = (site: DartCallSite): DartConstructorRef | null => {
    const [typeName, constructorName] = site.names;
    if (typeName === undefined || site.names.length > 2) {
        return null;
    }
    if (site.form === 'call' && !/^[A-Z]/.test(typeName)) {
        return null;
    }
    return {typeName, constructorName: constructorName ?? null};
};

// `const [prefix.]Type[<T>][.ctor](args)` / `new ...`. Three names are
// unambiguous (`const m.EdgeInsets.all(8)`: prefix, type, constructor). Two
// names are NOT — the grammar cannot tell `const w.Text(...)` (prefix + type)
// from `const Text.rich(...)` (type + named constructor) — so, exactly like the
// bare-call form, the first name is a prefix only when this file declares it.
const creationSite = (node: Node, form: 'const' | 'new', prefixes: ReadonlySet<string>): DartCallSite | null => {
    const children = namedChildren(node);
    const args = children.find((child) => child.type === 'arguments');
    if (args === undefined) {
        return null;
    }
    const chain = children.filter((child) => child.type === 'type_identifier' || child.type === 'identifier').map((child) => child.text);
    const first = chain[0];
    if (first === undefined) {
        return null;
    }
    const hasPrefix = chain.length === 3 || (chain.length === 2 && prefixes.has(first));
    const typeArgs = children.find((child) => child.type === 'type_arguments');
    return {
        form,
        prefix: hasPrefix ? first : null,
        names: hasPrefix ? chain.slice(1) : chain,
        typeArguments: typeArgs === undefined ? [] : typeArgumentTexts(typeArgs),
        head: node,
        arguments: args,
        range: spanRange(node, args)
    };
};

// `[prefix.]a[.b...][<T>](args)` — the primary identifier followed by selector
// siblings. Walks name selectors until the first selector carrying an argument
// list; any other selector first (index `[i]`, null-assert `!`) ends the chain
// without a call.
const bareCallSite = (identifier: Node, prefixes: ReadonlySet<string>): DartCallSite | null => {
    const chain = [identifier.text];
    let sibling = identifier.nextNamedSibling;
    while (sibling !== null && sibling.type === 'selector') {
        const part = namedChildren(sibling)[0];
        if (part === undefined) {
            return null;
        }
        if (part.type === 'argument_part') {
            const args = namedChildren(part).find((child) => child.type === 'arguments');
            if (args === undefined) {
                return null;
            }
            const typeArgs = namedChildren(part).find((child) => child.type === 'type_arguments');
            const hasPrefix = chain.length > 1 && prefixes.has(chain[0] as string);
            return {
                form: 'call',
                prefix: hasPrefix ? (chain[0] as string) : null,
                names: hasPrefix ? chain.slice(1) : chain,
                typeArguments: typeArgs === undefined ? [] : typeArgumentTexts(typeArgs),
                head: identifier,
                arguments: args,
                range: spanRange(identifier, args)
            };
        }
        if (part.type !== 'unconditional_assignable_selector' && part.type !== 'conditional_assignable_selector') {
            return null;
        }
        const name = namedChildren(part).find((child) => child.type === 'identifier');
        if (name === undefined) {
            return null;
        }
        chain.push(name.text);
        sibling = sibling.nextNamedSibling;
    }
    return null;
};

const typeArgumentTexts = (typeArgs: Node): string[] => namedChildren(typeArgs).map((child) => child.text);

/**
 * The number of syntax errors tree-sitter recovered from: `ERROR` nodes plus
 * zero-width `MISSING` tokens. tree-sitter always returns a tree, so a file
 * using syntax the grammar does not know (tree-sitter-dart 1.0.0 lacks Dart 3
 * records, patterns, switch expressions and class modifiers) still "parses" —
 * this count makes that silent degradation visible. Only subtrees flagged
 * `hasError` are descended, so a clean file costs O(1).
 */
export const parseErrorCount = (root: Node): number => {
    if (!root.hasError) {
        return 0;
    }
    let count = 0;
    const visit = (node: Node): void => {
        if (node.isError || node.isMissing) {
            count += 1;
        }
        if (!node.hasError) {
            return;
        }
        for (const child of node.children) {
            if (child !== null) {
                visit(child);
            }
        }
    };
    visit(root);
    return count;
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

const spanRange = (from: Node, to: Node): SourceRange => {
    return {startLine: from.startPosition.row + 1, startCol: from.startPosition.column, endLine: to.endPosition.row + 1, endCol: to.endPosition.column};
};
