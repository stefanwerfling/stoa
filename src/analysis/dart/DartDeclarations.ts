import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';

type Build = (spec: FactSpec) => Fact;

/**
 * Declaration facts for Dart (Flutter analysis, Phase 0b): the library
 * directives and the type declarations of one file, as plain data. They are
 * the input a later, Dart-specific library index needs to decide widget
 * IDENTITY (is this `Image` Flutter's, a local class, or an imported one?) —
 * Dart's library model (implicit export of every public top-level name,
 * show/hide combinators, `export` barrels, `part`/`part of`, `package:` URIs)
 * does not fit the ES-module SymbolGraph, so it gets its own facts rather than
 * being bent into `deps.importName`/`deps.export`.
 *
 * Deliberately NOT emitted here: `deps.import`. That would put Dart files into
 * the ModuleGraph and with it into R-DEP-CYCLE / R-DEP-UNUSED — a finding change
 * that needs its own decision. No rule reads the facts below.
 */

/** A type as written: `m.StatelessWidget` → prefix `m`, name `StatelessWidget`; `State<Bar>` → typeArguments `['Bar']`. */
export interface DartTypeRef {
    prefix: string | null;
    name: string;
    typeArguments: string[];
}

export type DartDirectiveKind = 'import' | 'export' | 'part' | 'part-of';

export interface DartDirectiveValue {
    [key: string]: unknown;
    kind: DartDirectiveKind;
    /** The URI without quotes; null only for the legacy `part of some.library;` form. */
    uri: string | null;
    /** `part of some.library;` — the library NAME instead of a URI. */
    libraryName: string | null;
    prefix: string | null;
    deferred: boolean;
    show: string[];
    hide: string[];
    /** The alternative URIs of a configurable import (`if (dart.library.io) 'x.dart'`), in source order. */
    conditionalUris: string[];
}

export type DartTypeDeclKind = 'class' | 'mixin' | 'enum';

export interface DartTypeDeclValue {
    [key: string]: unknown;
    declKind: DartTypeDeclKind;
    name: string;
    isAbstract: boolean;
    typeParameters: string[];
    superclass: DartTypeRef | null;
    mixins: DartTypeRef[];
    interfaces: DartTypeRef[];
    /** A mixin's `on` constraints. */
    on: DartTypeRef[];
}

export const extractDartDeclarationFacts = (root: Node, build: Build): Fact[] => {
    const facts: Fact[] = [];
    let directiveIndex = 0;

    for (const node of namedChildren(root)) {
        const directive = directiveOf(node);
        if (directive !== null) {
            facts.push(build({kind: 'dart.importSpec', kindOf: 'import', symbol: `directive#${directiveIndex}`, range: rangeOf(node), value: directive}));
            directiveIndex += 1;
        }
    }

    // Type declarations at any depth are only legal at top level in Dart, but
    // error recovery can nest them; descendantsOfType keeps them all, in
    // source order.
    for (const node of root.descendantsOfType(['class_definition', 'mixin_declaration', 'enum_declaration'])) {
        if (node === null) {
            continue;
        }
        const declaration = typeDeclOf(node);
        if (declaration !== null) {
            facts.push(build({kind: 'dart.classDecl', kindOf: 'class', symbol: declaration.name, range: rangeOf(node), value: declaration}));
        }
    }

    return facts;
};

const directiveOf = (node: Node): DartDirectiveValue | null => {
    const empty = {libraryName: null, prefix: null, deferred: false, show: [] as string[], hide: [] as string[], conditionalUris: [] as string[]};
    if (node.type === 'part_directive') {
        return {...empty, kind: 'part', uri: firstUri(node)};
    }
    if (node.type === 'part_of_directive') {
        const uri = firstUri(node);
        const name = namedChildren(node).find((child) => child.type === 'dotted_identifier_list');
        return {...empty, kind: 'part-of', uri, libraryName: uri === null && name !== undefined ? name.text : null};
    }
    if (node.type !== 'import_or_export') {
        return null;
    }
    const inner = namedChildren(node)[0];
    if (inner === undefined) {
        return null;
    }
    if (inner.type === 'library_export') {
        return {...empty, kind: 'export', uri: firstUri(inner), conditionalUris: conditionalUris(inner), ...combinators(inner)};
    }
    const spec = namedChildren(inner).find((child) => child.type === 'import_specification');
    if (spec === undefined) {
        return null;
    }
    const tokens = allChildren(spec);
    return {
        ...empty,
        kind: 'import',
        uri: firstUri(spec),
        prefix: namedChildren(spec).find((child) => child.type === 'identifier')?.text ?? null,
        deferred: tokens.some((child) => child.type === 'deferred'),
        conditionalUris: conditionalUris(spec),
        ...combinators(spec)
    };
};

// The directive's main URI: a direct `uri` child, or the first `uri` of a
// `configurable_uri` (the one used when no configuration matches).
const firstUri = (node: Node): string | null => {
    for (const child of namedChildren(node)) {
        if (child.type === 'uri') {
            return unquote(child.text);
        }
        if (child.type === 'configurable_uri') {
            const uri = namedChildren(child).find((candidate) => candidate.type === 'uri');
            return uri === undefined ? null : unquote(uri.text);
        }
    }
    return null;
};

const conditionalUris = (node: Node): string[] => {
    const configurable = namedChildren(node).find((child) => child.type === 'configurable_uri');
    if (configurable === undefined) {
        return [];
    }
    return namedChildren(configurable)
        .filter((child) => child.type === 'configuration_uri')
        .map((configuration) => namedChildren(configuration).find((child) => child.type === 'uri'))
        .filter((uri): uri is Node => uri !== undefined)
        .map((uri) => unquote(uri.text));
};

// show/hide are only distinguishable by the combinator's anonymous keyword token.
const combinators = (node: Node): {show: string[]; hide: string[]} => {
    const show: string[] = [];
    const hide: string[] = [];
    for (const combinator of namedChildren(node).filter((child) => child.type === 'combinator')) {
        const names = namedChildren(combinator).filter((child) => child.type === 'identifier').map((child) => child.text);
        (allChildren(combinator)[0]?.type === 'hide' ? hide : show).push(...names);
    }
    return {show, hide};
};

const typeDeclOf = (node: Node): DartTypeDeclValue | null => {
    // An ERROR directly in the declaration HEADER means the grammar did not
    // understand it — e.g. an enhanced enum (`enum E with M`, `implements`,
    // constructors; Dart 2.17) or a Dart 3 class modifier — and the `name`
    // field may then point at the wrong identifier. No fact beats a wrong one;
    // the file's `file.parseErrors` fact already records the recovery. Errors
    // inside the class BODY sit deeper and leave the header intact.
    if (namedChildren(node).some((child) => child.type === 'ERROR')) {
        return null;
    }
    const nameNode = node.childForFieldName('name') ?? namedChildren(node).find((child) => child.type === 'identifier') ?? null;
    if (nameNode === null) {
        return null;
    }
    const declKind: DartTypeDeclKind = node.type === 'mixin_declaration' ? 'mixin' : node.type === 'enum_declaration' ? 'enum' : 'class';
    const superclassNode = node.childForFieldName('superclass');
    const interfacesNode = node.childForFieldName('interfaces') ?? namedChildren(node).find((child) => child.type === 'interfaces') ?? null;
    const typeParametersNode = node.childForFieldName('type_parameters') ?? namedChildren(node).find((child) => child.type === 'type_parameters') ?? null;

    let superclass: DartTypeRef | null = null;
    let mixins: DartTypeRef[] = [];
    if (superclassNode !== null) {
        superclass = typeRefs(superclassNode)[0] ?? null;
        const mixinsNode = namedChildren(superclassNode).find((child) => child.type === 'mixins');
        mixins = mixinsNode === undefined ? [] : typeRefs(mixinsNode);
    } else {
        // A `with` clause directly on the declaration (no `extends`).
        const mixinsNode = namedChildren(node).find((child) => child.type === 'mixins');
        mixins = mixinsNode === undefined ? [] : typeRefs(mixinsNode);
    }

    return {
        declKind,
        name: nameNode.text,
        isAbstract: allChildren(node).some((child) => child.type === 'abstract'),
        typeParameters:
            typeParametersNode === null
                ? []
                : namedChildren(typeParametersNode)
                      .filter((child) => child.type === 'type_parameter')
                      .map((parameter) => namedChildren(parameter).find((child) => child.type === 'type_identifier')?.text ?? parameter.text),
        superclass,
        mixins,
        interfaces: interfacesNode === null ? [] : typeRefs(interfacesNode),
        on: declKind === 'mixin' ? typeRefsAfter(node, 'on') : []
    };
};

// The type references listed DIRECTLY in `node` (a nested `mixins` clause is
// read separately).
const typeRefs = (node: Node): DartTypeRef[] => scanTypeRefs(allChildren(node));

// The type references following an anonymous keyword token (a mixin's `on`)
// up to the next clause or the body.
const typeRefsAfter = (node: Node, keyword: string): DartTypeRef[] => {
    const children = allChildren(node);
    const start = children.findIndex((child) => child.type === keyword);
    if (start < 0) {
        return [];
    }
    const rest = children.slice(start + 1);
    const stop = rest.findIndex((child) => child.type === 'class_body' || child.type === 'interfaces' || child.type === 'implements');
    return scanTypeRefs(stop < 0 ? rest : rest.slice(0, stop));
};

// Consecutive `type_identifier`s are either `prefix.Type` or two list entries
// (`with A, B`) — told apart only by the anonymous token between them ('.' vs
// ','), which is why callers pass ALL children, not just the named ones.
const scanTypeRefs = (children: readonly Node[]): DartTypeRef[] => {
    const refs: DartTypeRef[] = [];
    let joinNext = false;
    for (const child of children) {
        if (child.type === '.') {
            joinNext = true;
            continue;
        }
        const last = refs[refs.length - 1];
        if (child.type === 'type_identifier') {
            if (joinNext && last !== undefined && last.prefix === null) {
                refs[refs.length - 1] = {prefix: last.name, name: child.text, typeArguments: []};
            } else {
                refs.push({prefix: null, name: child.text, typeArguments: []});
            }
        } else if (child.type === 'type_arguments' && last !== undefined) {
            last.typeArguments = namedChildren(child).map((argument) => argument.text);
        }
        joinNext = false;
    }
    return refs;
};

const unquote = (text: string): string => text.replace(/^(?:r)?(['"]{1,3})([\s\S]*)\1$/, '$2');

const allChildren = (node: Node): Node[] => node.children.filter((child): child is Node => child !== null);

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

const rangeOf = (node: Node): SourceRange => {
    return {startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: node.endPosition.row + 1, endCol: node.endPosition.column};
};
