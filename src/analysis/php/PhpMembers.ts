import type {Fact} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import {
    compactMember,
    sortedRefs,
    sortedUnique,
    UNSUPPORTED_MESSAGE,
    type StructBody,
    type StructDeclKind,
    type StructImportBinding,
    type StructImportBindingsValue,
    type StructInstantiation,
    type StructMember,
    type StructMemberKind,
    type StructParam,
    type StructStaticAccess,
    type StructSupertype,
    type StructTypeDeclValue,
    type StructTypeRef
} from '../StructFacts.js';
import {childNodes, isPhpNode, rangeOf, type PhpNode} from './PhpAst.js';

type Build = (spec: FactSpec) => Fact;

/**
 * PHP class-model facts (identity spec, phase 4), the same neutral
 * `struct.typeDecl` the TypeScript and Dart adapters emit (StructFacts.ts):
 * one per named class, interface, trait and enum, symbol = the type's
 * identity (namespace-qualified, `App\Service\UserService`), members
 * embedded. Syntactic, file-local, names as written.
 *
 * - declKind: a trait is a `mixin`, its `use` inside a class a `with`
 *   supertype (members copied in, as a Dart mixin's); an interface's parents
 *   are `extends`.
 * - Members: methods (`__construct` as the constructor), properties,
 *   class constants and enum cases (static fields); a promoted constructor
 *   parameter is a field-formal parameter AND a field of its own.
 * - `isOverride`: the `#[\Override]` attribute (PHP 8.3).
 * - `throws-unsupported`: the body is only `throw new X(…)` where X is
 *   `NotImplemented…`/`NotSupported…`/`UnsupportedOperation…` (Error or
 *   Exception), or any …Error/…Exception whose message says not
 *   implemented/supported — the TypeScript adapter's rule.
 * - References (body): `$this->x` / `self::x` / `static::x` of own members,
 *   imported names (by their local alias), `new X`, static reads `X::$p` /
 *   `X::C` (not calls, not `X::class`).
 * - One `struct.importBindings` per file that declares a type: the class
 *   `use`s (local alias → fully qualified name) and the file's namespace
 *   (`null` when the file declares several — then a name is unresolvable).
 *
 * Not modelled: anonymous classes, types without a name, trait adaptations
 * (`insteadof`/`as`), property hooks.
 */

const UNSUPPORTED_TYPES: ReadonlySet<string> = new Set([
    'NotImplementedError',
    'NotSupportedError',
    'UnsupportedOperationError',
    'NotImplementedException',
    'NotSupportedException',
    'UnsupportedOperationException'
]);

export const extractPhpMemberFacts = (types: readonly {node: PhpNode; symbol: string}[], bindings: readonly StructImportBinding[], namespace: string | null, build: Build): Fact[] => {
    const facts: Fact[] = [];
    const imported = new Set(bindings.map((binding) => binding.local.toLowerCase()));
    for (const {node, symbol} of types) {
        const value: StructTypeDeclValue = {v: 1, declKind: declKindOf(node), supertypes: supertypesOf(node), hasParseError: false, members: membersOf(node, imported).map(compactMember)};
        facts.push(build({kind: 'struct.typeDecl', kindOf: 'class', symbol, range: rangeOf(node), value}));
    }
    const first = types[0];
    if (first !== undefined) {
        const value: StructImportBindingsValue = {v: 1, bindings: [...bindings], namespace};
        facts.push(build({kind: 'struct.importBindings', kindOf: 'file', range: {startLine: 1, startCol: 0, endLine: 1, endCol: 0}, value}));
    }
    return facts;
};

const declKindOf = (node: PhpNode): StructDeclKind => {
    if (node.kind === 'interface') {
        return 'interface';
    }
    if (node.kind === 'trait') {
        return 'mixin';
    }
    if (node.kind === 'enum') {
        return 'enum';
    }
    return node.isAbstract === true ? 'abstract-class' : 'class';
};

/** A type name as written (`\App\Repo`, `Sub\Repo`, `Repo`): the qualifier as `prefix` (`\` for the global namespace), the last segment as `name`. */
const refOfName = (written: string): StructTypeRef => {
    const cut = written.lastIndexOf('\\');
    if (cut < 0) {
        return {prefix: null, name: written};
    }
    return {prefix: cut === 0 ? '\\' : written.slice(0, cut), name: written.slice(cut + 1)};
};

const namesOf = (value: unknown): PhpNode[] => (Array.isArray(value) ? value : [value]).filter((entry): entry is PhpNode => isPhpNode(entry) && entry.kind === 'name');

const supertypesOf = (node: PhpNode): StructSupertype[] => {
    const supertypes: StructSupertype[] = [];
    const add = (names: PhpNode[], kind: StructSupertype['kind']): void => {
        for (const name of names) {
            if (typeof name.name === 'string') {
                supertypes.push({...refOfName(name.name), kind});
            }
        }
    };
    add(namesOf(node.extends), 'extends');
    add(namesOf(node.implements), 'implements');
    for (const item of bodyOf(node).filter((entry) => entry.kind === 'traituse')) {
        add(namesOf(item.traits), 'with');
    }
    return supertypes;
};

/** The nodes of an AST list property (`body`, `properties`, `arguments` …); `[]` for anything else. */
const nodesIn = (value: unknown): PhpNode[] => (Array.isArray(value) ? value.filter(isPhpNode) : []);

const bodyOf = (node: PhpNode): PhpNode[] => nodesIn(node.body);

const identifierOf = (value: unknown): string => {
    if (isPhpNode(value) && typeof value.name === 'string') {
        return value.name;
    }
    return typeof value === 'string' ? value : '';
};

/** A declared type as a named reference: a class name (`?Foo`, `Foo|null` included); built-in types and real unions are null. */
const typeRefOf = (type: unknown): StructTypeRef | null => {
    if (!isPhpNode(type)) {
        return null;
    }
    if (type.kind === 'name' && typeof type.name === 'string') {
        return BUILTIN_TYPES.has(type.name.toLowerCase()) ? null : refOfName(type.name);
    }
    if (type.kind === 'uniontype' && Array.isArray(type.types)) {
        const named = type.types.filter((part): part is PhpNode => isPhpNode(part) && !(part.kind === 'typereference' && String(part.name).toLowerCase() === 'null'));
        return named.length === 1 ? typeRefOf(named[0]) : null;
    }
    return null;
};

// Written as a `name` by the parser in some positions (a backed enum's `string`), never a class.
const BUILTIN_TYPES: ReadonlySet<string> = new Set(['int', 'float', 'string', 'bool', 'array', 'object', 'mixed', 'void', 'null', 'callable', 'iterable', 'never', 'false', 'true', 'self', 'static', 'parent']);

const paramOf = (param: PhpNode): StructParam => ({name: identifierOf(param.name), type: typeRefOf(param.type), isFieldFormal: isPromoted(param)});

const isPromoted = (param: PhpNode): boolean => typeof param.flags === 'number' && param.flags !== 0;

const empty = (name: string, memberKind: StructMemberKind, node: PhpNode): StructMember => {
    const range = rangeOf(node);
    return {
        name,
        memberKind,
        range: [range.startLine, range.startCol, range.endLine, range.endCol],
        isStatic: false,
        isAbstract: false,
        isOverride: false,
        body: null,
        throwsType: null,
        declaredType: null,
        params: [],
        refsMembers: [],
        refsImports: [],
        instantiates: [],
        staticAccess: []
    };
};

/** The member names one class-body item declares (a constructor also its promoted parameters). */
const declaredNames = (item: PhpNode): string[] => {
    switch (item.kind) {
        case 'method':
            return [identifierOf(item.name), ...nodesIn(item.arguments).filter(isPromoted).map((param) => identifierOf(param.name))];
        case 'propertystatement':
            return nodesIn(item.properties).map((property) => identifierOf(property.name));
        case 'classconstant':
            return nodesIn(item.constants).map((constant) => identifierOf(constant.name));
        case 'enumcase':
            return [identifierOf(item.name)];
        default:
            return [];
    }
};

const ownNames = (node: PhpNode): Set<string> => new Set(bodyOf(node).flatMap(declaredNames));

const membersOf = (node: PhpNode, imported: ReadonlySet<string>): StructMember[] => {
    const context: ReferenceContext = {own: ownNames(node), imported};
    return bodyOf(node).flatMap((item) => membersFrom(item, node.kind === 'interface', context));
};

/** The members one class-body item declares. */
const membersFrom = (item: PhpNode, isInterface: boolean, context: ReferenceContext): StructMember[] => {
    switch (item.kind) {
        case 'method':
            return methodMembers(item, isInterface, context);
        case 'propertystatement':
            return nodesIn(item.properties).map((property) => ({
                ...empty(identifierOf(property.name), 'field', property),
                isStatic: item.isStatic === true,
                isAbstract: item.isAbstract === true,
                declaredType: typeRefOf(property.type)
            }));
        case 'classconstant':
            return nodesIn(item.constants).map((constant) => ({...empty(identifierOf(constant.name), 'field', constant), isStatic: true}));
        case 'enumcase':
            return [{...empty(identifierOf(item.name), 'field', item), isStatic: true}];
        default:
            return [];
    }
};

/** A method (and, for a constructor, the fields its promoted parameters declare). */
const methodMembers = (method: PhpNode, isInterface: boolean, context: ReferenceContext): StructMember[] => {
    const name = identifierOf(method.name);
    const params = nodesIn(method.arguments);
    const body = isPhpNode(method.body) ? method.body : null;
    const isConstructor = name.toLowerCase() === '__construct';
    const member: StructMember = {
        ...empty(name, isConstructor ? 'constructor' : 'method', method),
        isStatic: method.isStatic === true,
        isAbstract: isInterface || method.isAbstract === true || body === null,
        isOverride: hasOverrideAttribute(method),
        ...(isConstructor ? {} : bodyShape(body)),
        declaredType: isConstructor ? null : typeRefOf(method.type),
        params: params.map(paramOf),
        ...refsOf(body, context)
    };
    const promoted = isConstructor ? params.filter(isPromoted).map((param) => ({...empty(identifierOf(param.name), 'field', param), declaredType: typeRefOf(param.type)})) : [];
    return [member, ...promoted];
};

const hasOverrideAttribute = (method: PhpNode): boolean =>
    nodesIn(method.attrGroups).some((group) => nodesIn(group.attrs).some((attribute) => /^\\?Override$/i.test(String(attribute.name))));

const bodyShape = (body: PhpNode | null): {body: StructBody; throwsType: string | null} => {
    if (body === null) {
        return {body: 'abstract', throwsType: null};
    }
    const statements = nodesIn(body.children);
    if (statements.length === 0) {
        return {body: 'empty', throwsType: null};
    }
    const throwsType = statements.length === 1 ? unsupportedThrow(statements[0] as PhpNode) : null;
    return throwsType === null ? {body: 'normal', throwsType: null} : {body: 'throws-unsupported', throwsType};
};

/** The thrown type when `statement` is `throw new X(…)` saying unsupported/not implemented (see the module comment), else null. */
const unsupportedThrow = (statement: PhpNode): string | null => {
    const thrown = statement.kind === 'throw' && isPhpNode(statement.what) && statement.what.kind === 'new' ? statement.what : null;
    const type = thrown !== null && isPhpNode(thrown.what) && thrown.what.kind === 'name' && typeof thrown.what.name === 'string' ? thrown.what.name : null;
    if (thrown === null || type === null) {
        return null;
    }
    const short = refOfName(type).name;
    const [message] = nodesIn(thrown.arguments);
    const messageText = message?.kind === 'string' && typeof message.value === 'string' ? message.value : '';
    return UNSUPPORTED_TYPES.has(short) || (/(Error|Exception)$/.test(short) && UNSUPPORTED_MESSAGE.test(messageText)) ? type : null;
};

const SELF_KINDS: ReadonlySet<string> = new Set(['selfreference', 'staticreference']);

interface References {
    refsMembers: string[];
    refsImports: string[];
    instantiates: StructInstantiation[];
    staticAccess: StructStaticAccess[];
}

/** The class's own member names and the file's imported aliases (lower-cased). */
interface ReferenceContext {
    own: ReadonlySet<string>;
    imported: ReadonlySet<string>;
}

const refsOf = (body: PhpNode | null, context: ReferenceContext): References => {
    const found: References = {refsMembers: [], refsImports: [], instantiates: [], staticAccess: []};
    if (body === null) {
        return found;
    }
    const walk = (node: PhpNode, parent: PhpNode | null): void => {
        referenceAt(node, parent, context, found);
        for (const child of childNodes(node)) {
            walk(child, node);
        }
    };
    walk(body, null);
    return {refsMembers: sortedUnique(found.refsMembers), refsImports: sortedUnique(found.refsImports), instantiates: sortedRefs(found.instantiates), staticAccess: sortedRefs(found.staticAccess)};
};

const offsetName = (offset: unknown): string => (isPhpNode(offset) && typeof offset.name === 'string' ? (offset.kind === 'variable' ? `$${offset.name}` : offset.name) : '');

const writtenName = (node: PhpNode | null): string | null => (node?.kind === 'name' && typeof node.name === 'string' ? node.name : null);

/** What `node` (a child of `parent`) references, added to `found`. */
const referenceAt = (node: PhpNode, parent: PhpNode | null, context: ReferenceContext, found: References): void => {
    switch (node.kind) {
        case 'propertylookup':
        case 'nullsafepropertylookup':
            thisReference(node, context, found);
            return;
        case 'staticlookup':
            staticReference(node, parent, context, found);
            return;
        case 'new':
            newReference(node, found);
            return;
        case 'name':
            importReference(node, context, found);
            return;
        default:
            return;
    }
};

const addOwn = (name: string, context: ReferenceContext, found: References): void => {
    if (context.own.has(name)) {
        found.refsMembers.push(name);
    }
};

/** `$this->x` / `$this?->x` of an own member. */
const thisReference = (node: PhpNode, context: ReferenceContext, found: References): void => {
    if (isPhpNode(node.what) && node.what.kind === 'variable' && node.what.name === 'this') {
        addOwn(offsetName(node.offset), context, found);
    }
};

/** `self::x` / `static::x` (an own member) or a static read `X::$p` / `X::C` — not a call, not `X::class`. */
const staticReference = (node: PhpNode, parent: PhpNode | null, context: ReferenceContext, found: References): void => {
    const what = isPhpNode(node.what) ? node.what : null;
    const member = offsetName(node.offset);
    if (what !== null && SELF_KINDS.has(what.kind)) {
        addOwn(member.replace(/^\$/, ''), context, found);
        return;
    }
    const type = writtenName(what);
    const isCallee = parent?.kind === 'call' && parent.what === node;
    if (type !== null && member !== 'class' && !isCallee) {
        found.staticAccess.push({...refOfName(type), member});
    }
};

/** `new X(…)` of a named class (not `new $x`, `new self`, `new class`). */
const newReference = (node: PhpNode, found: References): void => {
    const type = writtenName(isPhpNode(node.what) ? node.what : null);
    if (type !== null) {
        found.instantiates.push({...refOfName(type), member: null});
    }
};

/** A name whose first segment is an imported alias (not fully qualified). */
const importReference = (node: PhpNode, context: ReferenceContext, found: References): void => {
    if (typeof node.name !== 'string' || node.resolution === 'fqn') {
        return;
    }
    const local = node.name.split('\\')[0] ?? '';
    if (context.imported.has(local.toLowerCase())) {
        found.refsImports.push(local);
    }
};
