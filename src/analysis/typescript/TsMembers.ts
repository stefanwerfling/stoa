import {Node, SyntaxKind, ts} from 'ts-morph';
import type {ClassDeclaration, InterfaceDeclaration, ParameterDeclaration, SourceFile, TypeNode} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import {
    compactMember,
    sortedRefs,
    sortedUnique,
    type StructBody,
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
import {descendantsOfKind} from './NodeIndex.js';

type Build = (spec: FactSpec) => Fact;

/**
 * TypeScript class-model facts (Flutter quality track E3): one
 * `struct.typeDecl` per top-level class and interface, members embedded
 * (compact table, see StructFacts.ts). Syntactic (ts-morph AST, no type
 * checker) and file-local.
 *
 * - Parameter properties (`constructor(private repo: Repo)`) are field-formal
 *   parameters AND fields of their own.
 * - `throws-unsupported`: the body is only `throw new X(…)` where X is
 *   `NotImplementedError`/`NotSupportedError`/`UnsupportedOperationError`, or
 *   any `throw new …Error('…')` whose message says not implemented/supported.
 * - `refsImports`: identifiers in the body bound by this file's imports
 *   (default, named — local alias — and namespace names).
 * - Interface members are abstract.
 * - E4: a file that declares a class or interface and imports something also
 *   gets one `struct.importBindings` fact (local name → module, exported name).
 *
 * Not modelled (documented limits): class expressions, classes nested in
 * functions or namespaces, index signatures, object-literal "classes", and
 * shadowing of import names by locals.
 */

const UNSUPPORTED_ERROR_TYPES: ReadonlySet<string> = new Set(['NotImplementedError', 'NotSupportedError', 'UnsupportedOperationError']);
const UNSUPPORTED_MESSAGE = /not\s+(yet\s+)?(implemented|supported)|unsupported|unimplemented/i;

export const extractTsMemberFacts = (sourceFile: SourceFile, build: Build): Fact[] => {
    const facts: Fact[] = [];
    const imported = importedLocalNames(sourceFile);
    const erroneous = erroneousStatements(sourceFile);
    const hasErrorIn = (node: Node): boolean => erroneous.has(node.getPos());

    for (const declaration of sourceFile.getClasses()) {
        const name = declaration.getName();
        if (name === undefined) {
            continue;
        }
        const value: StructTypeDeclValue = {
            v: 1,
            declKind: declaration.isAbstract() ? 'abstract-class' : 'class',
            supertypes: classSupertypes(declaration),
            hasParseError: hasErrorIn(declaration),
            members: classMembers(declaration, sourceFile, imported).map(compactMember)
        };
        facts.push(build({kind: 'struct.typeDecl', kindOf: 'class', symbol: name, range: rangeOf(sourceFile, declaration), value}));
    }
    for (const declaration of sourceFile.getInterfaces()) {
        const value: StructTypeDeclValue = {
            v: 1,
            declKind: 'interface',
            supertypes: declaration.getExtends().flatMap((clause) => supertypeOf(clause.getExpression(), 'extends')),
            hasParseError: hasErrorIn(declaration),
            members: interfaceMembers(declaration, sourceFile).map(compactMember)
        };
        facts.push(build({kind: 'struct.typeDecl', kindOf: 'class', symbol: declaration.getName(), range: rangeOf(sourceFile, declaration), value}));
    }
    const bindings = importBindings(sourceFile);
    if (facts.length > 0 && bindings.length > 0) {
        const value: StructImportBindingsValue = {v: 1, bindings};
        facts.push(build({kind: 'struct.importBindings', kindOf: 'file', range: rangeOf(sourceFile, sourceFile), value}));
    }
    return facts;
};

const importBindings = (sourceFile: SourceFile): StructImportBinding[] => {
    const bindings: StructImportBinding[] = [];
    for (const declaration of sourceFile.getImportDeclarations()) {
        const module = declaration.getModuleSpecifierValue();
        const defaultImport = declaration.getDefaultImport();
        if (defaultImport !== undefined) {
            bindings.push({local: defaultImport.getText(), module, importedName: 'default', kind: 'default'});
        }
        const namespace = declaration.getNamespaceImport();
        if (namespace !== undefined) {
            bindings.push({local: namespace.getText(), module, importedName: '*', kind: 'namespace'});
        }
        for (const named of declaration.getNamedImports()) {
            bindings.push({local: named.getAliasNode()?.getText() ?? named.getName(), module, importedName: named.getName(), kind: 'named'});
        }
    }
    return bindings.sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0) || (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
};

// Start positions of the top-level statements a syntax error belongs to. TS
// keeps the errors it recovered from on the source file; an error is reported
// where the parser noticed it — often at the end of the file, after an
// unclosed declaration — so it belongs to the statement containing it, or else
// to the last statement before it.
const erroneousStatements = (sourceFile: SourceFile): ReadonlySet<number> => {
    const diagnostics = (sourceFile.compilerNode as unknown as {parseDiagnostics?: {start?: number}[]}).parseDiagnostics ?? [];
    const statements = sourceFile.getStatements();
    const marked = new Set<number>();
    for (const diagnostic of diagnostics) {
        const position = diagnostic.start ?? -1;
        if (position < 0) {
            continue;
        }
        const owner = statements.find((statement) => statement.getPos() <= position && position < statement.getEnd()) ?? statements.filter((statement) => statement.getEnd() <= position).at(-1);
        if (owner !== undefined) {
            marked.add(owner.getPos());
        }
    }
    return marked;
};

const importedLocalNames = (sourceFile: SourceFile): ReadonlySet<string> => {
    const names = new Set<string>();
    for (const declaration of sourceFile.getImportDeclarations()) {
        const defaultImport = declaration.getDefaultImport();
        if (defaultImport !== undefined) {
            names.add(defaultImport.getText());
        }
        const namespace = declaration.getNamespaceImport();
        if (namespace !== undefined) {
            names.add(namespace.getText());
        }
        for (const named of declaration.getNamedImports()) {
            names.add(named.getAliasNode()?.getText() ?? named.getName());
        }
    }
    return names;
};

// `ns.Foo<T>` / `Foo` as an expression (heritage clauses) → a type ref.
const refOfExpression = (expression: Node): StructTypeRef | null => {
    if (Node.isIdentifier(expression)) {
        return {prefix: null, name: expression.getText()};
    }
    if (Node.isPropertyAccessExpression(expression)) {
        return {prefix: expression.getExpression().getText(), name: expression.getName()};
    }
    return null;
};

const supertypeOf = (expression: Node, kind: StructSupertype['kind']): StructSupertype[] => {
    const ref = refOfExpression(expression);
    return ref === null ? [] : [{...ref, kind}];
};

const classSupertypes = (declaration: ClassDeclaration): StructSupertype[] => {
    const extended = declaration.getExtends();
    return [
        ...(extended === undefined ? [] : supertypeOf(extended.getExpression(), 'extends')),
        ...declaration.getImplements().flatMap((clause) => supertypeOf(clause.getExpression(), 'implements'))
    ];
};

// A written named type (`Foo`, `ns.Foo`, `Foo<T>`, `Foo | null`/`Foo | undefined`); keyword and other types → null.
const refOfType = (type: TypeNode | undefined): StructTypeRef | null => {
    if (type === undefined) {
        return null;
    }
    if (Node.isTypeReference(type)) {
        const name = type.getTypeName();
        return Node.isQualifiedName(name) ? {prefix: name.getLeft().getText(), name: name.getRight().getText()} : {prefix: null, name: name.getText()};
    }
    if (Node.isUnionTypeNode(type)) {
        const named = type.getTypeNodes().filter((part) => !isNullish(part));
        return named.length === 1 ? refOfType(named[0]) : null;
    }
    return null;
};

const isNullish = (type: TypeNode): boolean =>
    type.getKind() === SyntaxKind.UndefinedKeyword || (Node.isLiteralTypeNode(type) && type.getLiteral().getKind() === SyntaxKind.NullKeyword);

const paramOf = (param: ParameterDeclaration): StructParam => ({name: param.getName(), type: refOfType(param.getTypeNode()), isFieldFormal: param.isParameterProperty()});

const base = (name: string, memberKind: StructMemberKind, range: SourceRange): StructMember => ({
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
});

const classMembers = (declaration: ClassDeclaration, sourceFile: SourceFile, imported: ReadonlySet<string>): StructMember[] => {
    const own = new Set<string>();
    for (const member of declaration.getMembers()) {
        if (Node.isPropertyDeclaration(member) || Node.isMethodDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) {
            own.add(member.getName());
        } else if (Node.isConstructorDeclaration(member)) {
            member.getParameters().filter((param) => param.isParameterProperty()).forEach((param) => own.add(param.getName()));
        }
    }
    const className = declaration.getName() ?? '';
    const members: StructMember[] = [];
    for (const member of declaration.getMembers()) {
        const range = rangeOf(sourceFile, member);
        if (Node.isConstructorDeclaration(member)) {
            const params = member.getParameters();
            members.push({...base('constructor', 'constructor', range), params: params.map(paramOf), ...refsOf(member.getBody(), own, imported, className, params)});
            for (const param of params.filter((candidate) => candidate.isParameterProperty())) {
                members.push({...base(param.getName(), 'field', rangeOf(sourceFile, param)), isStatic: false, declaredType: refOfType(param.getTypeNode())});
            }
        } else if (Node.isPropertyDeclaration(member)) {
            members.push({
                ...base(member.getName(), 'field', range),
                isStatic: member.isStatic(),
                isAbstract: member.isAbstract(),
                isOverride: member.hasOverrideKeyword(),
                declaredType: refOfType(member.getTypeNode()),
                ...refsOf(member.getInitializer(), own, imported, className, [])
            });
        } else if (Node.isMethodDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) {
            const memberKind: StructMemberKind = Node.isGetAccessorDeclaration(member) ? 'getter' : Node.isSetAccessorDeclaration(member) ? 'setter' : 'method';
            const body = member.getBody();
            const params = member.getParameters();
            members.push({
                ...base(member.getName(), memberKind, range),
                isStatic: member.isStatic(),
                isAbstract: member.isAbstract() || body === undefined,
                isOverride: member.hasModifier(SyntaxKind.OverrideKeyword),
                ...bodyShape(body),
                declaredType: refOfType(member.getReturnTypeNode()),
                params: params.map(paramOf),
                ...refsOf(body, own, imported, className, params)
            });
        }
    }
    return members;
};

const interfaceMembers = (declaration: InterfaceDeclaration, sourceFile: SourceFile): StructMember[] => {
    const members: StructMember[] = [];
    for (const member of declaration.getMembers()) {
        const range = rangeOf(sourceFile, member);
        if (Node.isPropertySignature(member)) {
            members.push({...base(member.getName(), 'field', range), isAbstract: true, declaredType: refOfType(member.getTypeNode())});
        } else if (Node.isMethodSignature(member)) {
            members.push({
                ...base(member.getName(), 'method', range),
                isAbstract: true,
                body: 'abstract',
                declaredType: refOfType(member.getReturnTypeNode()),
                params: member.getParameters().map(paramOf)
            });
        }
    }
    return members;
};

const bodyShape = (body: Node | undefined): {body: StructBody; throwsType: string | null} => {
    if (body === undefined) {
        return {body: 'abstract', throwsType: null};
    }
    if (!Node.isBlock(body)) {
        return {body: 'normal', throwsType: null};
    }
    const statements = body.getStatements();
    if (statements.length === 0) {
        return {body: 'empty', throwsType: null};
    }
    const only = statements.length === 1 ? statements[0] : undefined;
    if (only !== undefined && Node.isThrowStatement(only)) {
        const thrown = only.getExpression();
        if (Node.isNewExpression(thrown)) {
            const type = thrown.getExpression().getText();
            const message = thrown.getArguments()[0];
            const messageText = message !== undefined && (Node.isStringLiteral(message) || Node.isNoSubstitutionTemplateLiteral(message)) ? message.getLiteralText() : '';
            if (UNSUPPORTED_ERROR_TYPES.has(type) || (/Error$/.test(type) && UNSUPPORTED_MESSAGE.test(messageText))) {
                return {body: 'throws-unsupported', throwsType: type};
            }
        }
    }
    return {body: 'normal', throwsType: null};
};

/**
 * The nodes refsOf inspects: `scope` and its descendants that are property
 * accesses, `new` expressions or identifiers — the same set as filtering
 * `[scope, ...scope.getDescendants()]`, without wrapping every token. The
 * compiler tree is walked like getDescendants (`getChildren`, JSDoc included);
 * only the hits are wrapped. Property accesses and `new` come from
 * getDescendantsOfKind (node walk, no JSDoc); should JSDoc hold one (e.g.
 * `@augments a.B`), the full getDescendants path is taken instead.
 */
const referenceCandidates = (scope: Node): Node[] => {
    const file = scope.getSourceFile().compilerNode;
    const rawExpressions = new Set<ts.Node>();
    let identifiers = 0;
    const walk = (node: ts.Node): void => {
        for (const child of node.getChildren(file)) {
            if (child.kind === ts.SyntaxKind.PropertyAccessExpression || child.kind === ts.SyntaxKind.NewExpression) {
                rawExpressions.add(child);
            } else if (child.kind === ts.SyntaxKind.Identifier) {
                identifiers += 1;
            }
            walk(child);
        }
    };
    walk(scope.compilerNode);
    const expressions = [...descendantsOfKind(scope, SyntaxKind.PropertyAccessExpression), ...descendantsOfKind(scope, SyntaxKind.NewExpression)];
    const identifierNodes = identifiers === 0 ? [] : scope.getDescendantsOfKind(SyntaxKind.Identifier);
    if (expressions.length !== rawExpressions.size || expressions.some((node) => !rawExpressions.has(node.compilerNode)) || identifierNodes.length !== identifiers) {
        return [scope, ...scope.getDescendants()];
    }
    return [scope, ...expressions, ...identifierNodes];
};

const refsOf = (
    scope: Node | undefined,
    own: ReadonlySet<string>,
    imported: ReadonlySet<string>,
    className: string,
    params: readonly ParameterDeclaration[]
): Pick<StructMember, 'refsMembers' | 'refsImports' | 'instantiates' | 'staticAccess'> => {
    if (scope === undefined) {
        return {refsMembers: [], refsImports: [], instantiates: [], staticAccess: []};
    }
    const shadowed = new Set(params.map((param) => param.getName()));
    const refsMembers: string[] = [];
    const refsImports: string[] = [];
    const instantiates: StructInstantiation[] = [];
    const staticAccess: StructStaticAccess[] = [];
    for (const node of referenceCandidates(scope)) {
        if (Node.isPropertyAccessExpression(node)) {
            const target = node.getExpression();
            if (target.getKind() === SyntaxKind.ThisKeyword || (Node.isIdentifier(target) && target.getText() === className)) {
                if (own.has(node.getName())) {
                    refsMembers.push(node.getName());
                }
            } else {
                const isCallee = Node.isCallExpression(node.getParent()) && node.getParent()?.getChildAtIndex(0) === node;
                const ref = refOfExpression(target);
                if (!isCallee && ref !== null && /^[A-Z]/.test(ref.name) && (ref.prefix === null || imported.has(ref.prefix))) {
                    staticAccess.push({...ref, member: node.getName()});
                }
            }
        } else if (Node.isNewExpression(node)) {
            const ref = refOfExpression(node.getExpression());
            if (ref !== null) {
                instantiates.push({...ref, member: null});
            }
        } else if (Node.isIdentifier(node) && imported.has(node.getText()) && !shadowed.has(node.getText())) {
            const parent = node.getParent();
            // `x.name` (the name part) and `{name: …}` keys are not references to the import.
            const isMemberName = Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node;
            const isKey = Node.isPropertyAssignment(parent) && parent.getNameNode() === node;
            if (!isMemberName && !isKey) {
                refsImports.push(node.getText());
            }
        }
    }
    return {refsMembers: sortedUnique(refsMembers), refsImports: sortedUnique(refsImports), instantiates: sortedRefs(instantiates), staticAccess: sortedRefs(staticAccess)};
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};
