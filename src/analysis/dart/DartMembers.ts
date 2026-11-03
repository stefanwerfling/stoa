import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import {
    compactMember,
    sortedRefs,
    sortedUnique,
    type StructBody,
    type StructDeclKind,
    type StructInstantiation,
    type StructMember,
    type StructMemberKind,
    type StructParam,
    type StructStaticAccess,
    type StructSupertype,
    type StructTypeDeclValue,
    type StructTypeRef
} from '../StructFacts.js';
import {asConstructor, callSiteOf} from './DartCallSite.js';

type Build = (spec: FactSpec) => Fact;

/**
 * Dart class-model facts (Flutter quality track E3): one `struct.typeDecl` per
 * class / mixin / enum, with the members of a class or mixin body embedded
 * (compact table, see StructFacts.ts). Syntactic and file-local; every name is
 * as written. A setter is the member `name` with memberKind `setter`.
 *
 * tree-sitter-dart shapes read here: a class body holds `declaration` nodes
 * (fields, constructors without body, body-less methods/getters/setters) and
 * `method_signature` nodes whose `function_body` is the NEXT sibling;
 * annotations (`@override`) are siblings BEFORE the member. A prefixed type
 * is two `type_identifier`s (`http`, `Client`).
 *
 * Not modelled (documented limits): members of enhanced enums (the grammar
 * cannot parse them; the enum still gets a typeDecl), extension declarations,
 * function-typed parameters' inner shape, and shadowing beyond parameters and
 * local variable names. `refsImports` also lists UpperCamelCase names not
 * declared in this file — candidates for the TypeModel to resolve.
 */

const UNSUPPORTED_ERRORS: ReadonlySet<string> = new Set(['UnsupportedError', 'UnimplementedError']);
const MEMBER_SELECTORS: ReadonlySet<string> = new Set(['unconditional_assignable_selector', 'conditional_assignable_selector', 'cascade_selector', 'label']);
const CONSTRUCTOR_SIGNATURES: ReadonlySet<string> = new Set([
    'constructor_signature',
    'constant_constructor_signature',
    'factory_constructor_signature',
    'redirecting_factory_constructor_signature'
]);

interface MemberDraft {
    name: string;
    memberKind: StructMemberKind;
    isStatic: boolean;
    isAbstract: boolean;
    isOverride: boolean;
    body: StructBody | null;
    throwsType: string | null;
    declaredType: StructTypeRef | null;
    params: StructParam[];
    /** Nodes whose content is analysed for refs (body, initializer). */
    scope: Node[];
    range: SourceRange;
}

export const extractDartMemberFacts = (root: Node, prefixes: ReadonlySet<string>, build: Build): Fact[] => {
    const facts: Fact[] = [];
    const declaredInFile = new Set<string>();
    const types = root.descendantsOfType(['class_definition', 'mixin_declaration', 'enum_declaration']).filter((node): node is Node => node !== null);
    for (const node of types) {
        const name = namedChildren(node).find((child) => child.type === 'identifier');
        if (name !== undefined) {
            declaredInFile.add(name.text);
        }
    }
    for (const node of types) {
        const name = namedChildren(node).find((child) => child.type === 'identifier');
        if (name === undefined) {
            continue;
        }
        const body = namedChildren(node).find((child) => child.type === 'class_body');
        const drafts = body === undefined || node.type === 'enum_declaration' ? [] : membersOf(body, name.text, prefixes);
        // Constructors are not referenced by a bare member name (`Repo` is the type).
        const ownMembers = new Set(drafts.filter((draft) => draft.memberKind !== 'constructor').map((draft) => draft.name));
        const members = drafts.map((draft) => {
            const member: StructMember = {
                name: draft.name,
                memberKind: draft.memberKind,
                range: [draft.range.startLine, draft.range.startCol, draft.range.endLine, draft.range.endCol],
                isStatic: draft.isStatic,
                isAbstract: draft.isAbstract,
                isOverride: draft.isOverride,
                body: draft.body,
                throwsType: draft.throwsType,
                declaredType: draft.declaredType,
                params: draft.params,
                ...refsOf(draft, ownMembers, declaredInFile, prefixes)
            };
            return compactMember(member);
        });
        const value: StructTypeDeclValue = {v: 1, declKind: declKindOf(node), supertypes: supertypesOf(node), hasParseError: node.hasError, members};
        facts.push(build({kind: 'struct.typeDecl', kindOf: 'class', symbol: name.text, range: rangeOf(node), value}));
    }
    return facts;
};

const declKindOf = (node: Node): StructDeclKind => {
    if (node.type === 'mixin_declaration') {
        return 'mixin';
    }
    if (node.type === 'enum_declaration') {
        return 'enum';
    }
    return node.children.some((child) => child?.type === 'abstract') ? 'abstract-class' : 'class';
};

// A run of type_identifier nodes → type refs (`p` `.` `J` → p.J: two
// type_identifiers joined by a `.` token are a prefixed type).
const typeRefsOf = (nodes: readonly Node[]): StructTypeRef[] => {
    const refs: StructTypeRef[] = [];
    const names = nodes.filter((node) => node.type === 'type_identifier');
    for (let index = 0; index < names.length; index += 1) {
        const current = names[index] as Node;
        const next = names[index + 1];
        if (next !== undefined && current.nextSibling?.type === '.' && current.nextNamedSibling?.id === next.id) {
            refs.push({prefix: current.text, name: next.text});
            index += 1;
        } else {
            refs.push({prefix: null, name: current.text});
        }
    }
    return refs;
};

const supertypesOf = (node: Node): StructSupertype[] => {
    const supertypes: StructSupertype[] = [];
    for (const child of namedChildren(node)) {
        if (child.type === 'superclass') {
            const parts = namedChildren(child);
            supertypes.push(...typeRefsOf(parts.filter((part) => part.type === 'type_identifier')).map((ref) => ({...ref, kind: 'extends' as const})));
            const mixins = parts.find((part) => part.type === 'mixins');
            if (mixins !== undefined) {
                supertypes.push(...typeRefsOf(namedChildren(mixins)).map((ref) => ({...ref, kind: 'with' as const})));
            }
        } else if (child.type === 'mixins') {
            supertypes.push(...typeRefsOf(namedChildren(child)).map((ref) => ({...ref, kind: 'with' as const})));
        } else if (child.type === 'interfaces') {
            supertypes.push(...typeRefsOf(namedChildren(child)).map((ref) => ({...ref, kind: 'implements' as const})));
        }
    }
    if (node.type === 'mixin_declaration') {
        // `mixin M on A, B` — the constraint types are direct type_identifier children.
        const on = typeRefsOf(namedChildren(node).filter((child) => child.type === 'type_identifier')).map((ref) => ({...ref, kind: 'on' as const}));
        supertypes.unshift(...on);
    }
    return supertypes;
};

const membersOf = (body: Node, owner: string, prefixes: ReadonlySet<string>): MemberDraft[] => {
    const drafts: MemberDraft[] = [];
    let annotations: string[] = [];
    for (const child of namedChildren(body)) {
        if (child.type === 'marker_annotation' || child.type === 'annotation') {
            const name = namedChildren(child).find((part) => part.type === 'identifier');
            if (name !== undefined) {
                annotations.push(name.text);
            }
            continue;
        }
        const isOverride = annotations.includes('override');
        if (child.type === 'declaration') {
            drafts.push(...declarationMembers(child, owner, isOverride, prefixes));
            annotations = [];
        } else if (child.type === 'method_signature') {
            const functionBody = child.nextNamedSibling?.type === 'function_body' ? child.nextNamedSibling : null;
            const draft = methodMember(child, functionBody, owner, isOverride, prefixes);
            if (draft !== null) {
                drafts.push(draft);
            }
            annotations = [];
        } else if (child.type !== 'function_body' && child.type !== 'comment' && child.type !== 'documentation_comment') {
            annotations = [];
        }
    }
    return drafts;
};

const hasToken = (node: Node, token: string): boolean => node.children.some((child) => child?.type === token);

// Members written as a `declaration`: fields, body-less constructors/methods/getters/setters.
const declarationMembers = (node: Node, owner: string, isOverride: boolean, prefixes: ReadonlySet<string>): MemberDraft[] => {
    const parts = namedChildren(node);
    const isStatic = hasToken(node, 'static');
    const isExternal = hasToken(node, 'external');
    const range = rangeOf(node);
    const constructor = parts.find((part) => CONSTRUCTOR_SIGNATURES.has(part.type));
    if (constructor !== undefined) {
        return [constructorMember(constructor, owner, initializersOf(node, constructor), range, isOverride)];
    }
    const signature = parts.find((part) => part.type === 'function_signature' || part.type === 'getter_signature' || part.type === 'setter_signature' || part.type === 'operator_signature');
    if (signature !== undefined) {
        const draft = signatureMember(signature, owner, isStatic, isOverride, prefixes, range);
        return [{...draft, isAbstract: !isExternal, body: isExternal ? null : 'abstract'}];
    }
    // Fields: `T a = x, b;` / `static final T a = x;`.
    const declaredType = typeRefsOf(parts)[0] ?? null;
    const list = parts.find((part) => part.type === 'initialized_identifier_list' || part.type === 'static_final_declaration_list');
    const fields: MemberDraft[] = [];
    for (const entry of list === undefined ? [] : namedChildren(list)) {
        const [identifier, ...initializer] = namedChildren(entry);
        if (identifier === undefined || identifier.type !== 'identifier') {
            continue;
        }
        fields.push({
            name: identifier.text,
            memberKind: 'field',
            isStatic,
            isAbstract: false,
            isOverride,
            body: null,
            throwsType: null,
            declaredType: typeRefsOf(parts).length > 1 ? null : declaredType,
            params: [],
            scope: initializer,
            range
        });
    }
    return fields;
};

// A `method_signature` (with its body sibling).
const methodMember = (node: Node, functionBody: Node | null, owner: string, isOverride: boolean, prefixes: ReadonlySet<string>): MemberDraft | null => {
    const inner = namedChildren(node)[0];
    if (inner === undefined) {
        return null;
    }
    const range = functionBody === null ? rangeOf(node) : spanRange(node, functionBody);
    if (CONSTRUCTOR_SIGNATURES.has(inner.type)) {
        return constructorMember(inner, owner, [...initializersOf(node, inner), ...(functionBody === null ? [] : [functionBody])], range, isOverride);
    }
    const draft = signatureMember(inner, owner, hasToken(node, 'static'), isOverride, prefixes, range);
    const {body, throwsType} = functionBody === null ? {body: 'abstract' as const, throwsType: null} : bodyShape(functionBody);
    return {...draft, body, throwsType, isAbstract: functionBody === null, scope: functionBody === null ? [] : [functionBody]};
};

const signatureMember = (signature: Node, owner: string, isStatic: boolean, isOverride: boolean, prefixes: ReadonlySet<string>, range: SourceRange): MemberDraft => {
    const parts = namedChildren(signature);
    const memberKind: StructMemberKind = signature.type === 'getter_signature' ? 'getter' : signature.type === 'setter_signature' ? 'setter' : 'method';
    const nameNode = parts.find((part) => part.type === 'identifier');
    const operator = signature.type === 'operator_signature' ? parts.find((part) => part.type.endsWith('operator')) : undefined;
    const name = operator !== undefined ? `operator${operator.text}` : (nameNode?.text ?? '?');
    // The return type is the type run before the name.
    const before = nameNode === undefined ? parts : parts.filter((part) => part.endIndex <= nameNode.startIndex);
    const returnTypes = typeRefsOf(before);
    const list = parts.find((part) => part.type === 'formal_parameter_list');
    return {
        name,
        memberKind,
        isStatic,
        isAbstract: false,
        isOverride,
        body: null,
        throwsType: null,
        declaredType: returnTypes.length === 1 ? (returnTypes[0] as StructTypeRef) : null,
        params: list === undefined ? [] : paramsOf(list),
        scope: [],
        range
    };
};

// The parts of a constructor that hold code: its initializer list (a sibling
// of the signature, or inside it) and, for `=>` factories, the redirect.
const initializersOf = (container: Node, signature: Node): Node[] =>
    [...namedChildren(container), ...namedChildren(signature)].filter((part) => part.type === 'initializers' || part.type === 'redirection');

const constructorMember = (signature: Node, owner: string, scope: Node[], range: SourceRange, isOverride: boolean): MemberDraft => {
    const identifiers = signature.descendantsOfType('identifier').filter((node): node is Node => node !== null && node.parent !== null && (node.parent.id === signature.id || node.parent.type === 'qualified'));
    const named = identifiers.length > 1 ? (identifiers.at(-1) as Node).text : null;
    const list = namedChildren(signature).find((part) => part.type === 'formal_parameter_list');
    return {
        name: named ?? owner,
        memberKind: 'constructor',
        isStatic: false,
        isAbstract: false,
        isOverride,
        body: null,
        throwsType: null,
        declaredType: null,
        params: list === undefined ? [] : paramsOf(list),
        scope,
        range
    };
};

const paramsOf = (list: Node): StructParam[] => {
    const params: StructParam[] = [];
    const visit = (node: Node): void => {
        for (const child of namedChildren(node)) {
            if (child.type === 'optional_formal_parameters') {
                visit(child);
            } else if (child.type === 'formal_parameter') {
                const param = paramOf(child);
                if (param !== null) {
                    params.push(param);
                }
            }
        }
    };
    visit(list);
    return params;
};

const paramOf = (node: Node): StructParam | null => {
    const parts = namedChildren(node);
    const special = parts.find((part) => part.type === 'constructor_param' || part.type === 'super_formal_parameter');
    if (special !== undefined) {
        const name = namedChildren(special).filter((part) => part.type === 'identifier').at(-1);
        return name === undefined ? null : {name: name.text, type: null, isFieldFormal: special.type === 'constructor_param'};
    }
    const name = parts.filter((part) => part.type === 'identifier').at(-1);
    if (name === undefined) {
        return null;
    }
    const types = typeRefsOf(parts.filter((part) => part.endIndex <= name.startIndex));
    return {name: name.text, type: types.length === 1 ? (types[0] as StructTypeRef) : null, isFieldFormal: false};
};

// `=> throw UnsupportedError()` / `{ throw UnimplementedError(); }` / `{}`.
const bodyShape = (functionBody: Node): {body: StructBody; throwsType: string | null} => {
    const parts = namedChildren(functionBody).filter((part) => part.type !== 'comment' && part.type !== 'documentation_comment');
    const block = parts.find((part) => part.type === 'block');
    let expression: Node | undefined;
    if (block !== undefined) {
        const statements = namedChildren(block).filter((part) => part.type !== 'comment' && part.type !== 'documentation_comment');
        if (statements.length === 0) {
            return {body: 'empty', throwsType: null};
        }
        const only = statements.length === 1 ? statements[0] : undefined;
        expression = only?.type === 'expression_statement' ? namedChildren(only)[0] : undefined;
    } else {
        expression = parts.find((part) => part.type === 'throw_expression');
    }
    if (expression?.type === 'throw_expression') {
        const thrown = namedChildren(expression)[0];
        const type = thrown?.type === 'identifier' ? thrown.text : thrown?.type === 'new_expression' || thrown?.type === 'const_object_expression' ? namedChildren(thrown).find((part) => part.type === 'type_identifier')?.text : undefined;
        if (type !== undefined && UNSUPPORTED_ERRORS.has(type)) {
            return {body: 'throws-unsupported', throwsType: type};
        }
    }
    return {body: 'normal', throwsType: null};
};

const refsOf = (
    draft: MemberDraft,
    ownMembers: ReadonlySet<string>,
    declaredInFile: ReadonlySet<string>,
    prefixes: ReadonlySet<string>
): Pick<StructMember, 'refsMembers' | 'refsImports' | 'instantiates' | 'staticAccess'> => {
    const shadowed = new Set(draft.params.map((param) => param.name));
    const nodes: Node[] = [];
    for (const scope of draft.scope) {
        nodes.push(scope, ...scope.descendantsOfType(['identifier', 'type_identifier', 'const_object_expression', 'new_expression']).filter((node): node is Node => node !== null));
    }
    for (const node of nodes) {
        if (node.type === 'identifier' && node.parent?.type === 'initialized_variable_definition' && namedChildren(node.parent).find((part) => part.type === 'identifier')?.id === node.id) {
            shadowed.add(node.text);
        }
    }
    const refsMembers: string[] = [];
    const refsImports: string[] = [];
    const instantiates: StructInstantiation[] = [];
    const staticAccess: StructStaticAccess[] = [];
    for (const node of nodes) {
        if (node.type === 'const_object_expression' || node.type === 'new_expression' || node.type === 'identifier') {
            const site = callSiteOf(node, prefixes);
            const constructor = site === null ? null : asConstructor(site);
            if (site !== null && constructor !== null) {
                instantiates.push({prefix: site.prefix, name: constructor.typeName, member: constructor.constructorName});
            }
        }
        if (node.type !== 'identifier' && node.type !== 'type_identifier') {
            continue;
        }
        const parent = node.parent;
        if (parent !== null && MEMBER_SELECTORS.has(parent.type)) {
            // `this.x` — an own member; any other `a.x` belongs to another object.
            const selector = parent.parent;
            if (node.type === 'identifier' && selector?.type === 'selector' && selector.previousNamedSibling?.type === 'this' && ownMembers.has(node.text)) {
                refsMembers.push(node.text);
            }
            continue;
        }
        if (prefixes.has(node.text)) {
            refsImports.push(node.text);
            const access = staticAccessOf(node, prefixes);
            if (access !== null) {
                staticAccess.push(access);
            }
            continue;
        }
        if (shadowed.has(node.text)) {
            continue;
        }
        if (node.type === 'identifier' && ownMembers.has(node.text)) {
            refsMembers.push(node.text);
        } else if (/^[A-Z]/.test(node.text) && !declaredInFile.has(node.text)) {
            refsImports.push(node.text);
        }
        if (node.type === 'identifier' && /^[A-Z]/.test(node.text)) {
            const access = staticAccessOf(node, prefixes);
            if (access !== null) {
                staticAccess.push(access);
            }
        }
    }
    return {refsMembers: sortedUnique(refsMembers), refsImports: sortedUnique(refsImports), instantiates: sortedRefs(instantiates), staticAccess: sortedRefs(staticAccess)};
};

// `Type.member` or `prefix.Type.member` read as a property (not followed by an argument list).
const staticAccessOf = (head: Node, prefixes: ReadonlySet<string>): StructStaticAccess | null => {
    const chain: string[] = [];
    let sibling = head.nextNamedSibling;
    let afterLast: Node | null = null;
    const limit = prefixes.has(head.text) ? 2 : 1;
    while (sibling?.type === 'selector' && chain.length < limit) {
        const access = namedChildren(sibling)[0];
        const name = access?.type === 'unconditional_assignable_selector' ? namedChildren(access).find((part) => part.type === 'identifier') : undefined;
        if (name === undefined) {
            return null;
        }
        chain.push(name.text);
        sibling = sibling.nextNamedSibling;
        afterLast = sibling;
    }
    if (chain.length < limit) {
        return null;
    }
    const isCall = afterLast?.type === 'selector' && namedChildren(afterLast)[0]?.type === 'argument_part';
    if (isCall) {
        return null;
    }
    if (limit === 2) {
        const [type, member] = chain as [string, string];
        return /^[A-Z]/.test(type) && /^[a-z_$]/.test(member) ? {prefix: head.text, name: type, member} : null;
    }
    const member = chain[0] as string;
    return /^[a-z_$]/.test(member) ? {prefix: null, name: head.text, member} : null;
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

const rangeOf = (node: Node): SourceRange => ({startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: node.endPosition.row + 1, endCol: node.endPosition.column});

const spanRange = (from: Node, to: Node): SourceRange => ({startLine: from.startPosition.row + 1, startCol: from.startPosition.column, endLine: to.endPosition.row + 1, endCol: to.endPosition.column});
