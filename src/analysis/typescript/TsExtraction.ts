import {Node, SyntaxKind, ts} from 'ts-morph';
import type {Block, CallExpression, CatchClause, ClassDeclaration, Decorator, ImportDeclaration, MethodDeclaration, ObjectLiteralExpression, PropertyAssignment, PropertyDeclaration, SourceFile, VariableDeclaration} from 'ts-morph';
import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {declarationIdentities, type DeclarationBase, type IdentityScheme} from '../../FindingIdentity.js';
import {factBuilder, identitySchemeOf, type AdapterInfo} from '../FactBuilder.js';
import {ANCHOR_FACT, type AnchorValue} from '../SiteIdentity.js';
import {isDeepImport} from '../ImportPath.js';
import {extractJsxA11yFacts} from '../jsx/JsxA11y.js';
import {extractBackendValidationFacts, extractMassAssignmentFacts} from './BackendValidation.js';
import {extractValidationAnnotations} from './ValidationAnnotations.js';
import {extractValidatorUsageFacts} from './ValidatorUsage.js';
import {extractValidationDataflowFacts} from './ValidationDataflow.js';
import {destructiveDdl, nullableNoDefault, unguardedDdl} from '../MigrationSql.js';
import {extractTsMemberFacts} from './TsMembers.js';
import type {ReexportValue} from '../DepsFacts.js';
import {descendantsOfKind, descendantsOfKinds} from './NodeIndex.js';
import {exportLookup} from './ExportLookup.js';
import {lineSpanOf, rangeOfNode} from './SourcePositions.js';

interface FunctionMetrics {
    cyclomatic: number;
    cognitive: number;
    nestingDepth: number;
    parameterCount: number;
    lineCount: number;
}

const FUNCTION_LIKE_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration,
    SyntaxKind.Constructor,
    SyntaxKind.GetAccessor,
    SyntaxKind.SetAccessor
]);

// Structures that add cognitive load and increase nesting depth.
const NESTING_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.IfStatement,
    SyntaxKind.ForStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
    SyntaxKind.SwitchStatement,
    SyntaxKind.CatchClause,
    SyntaxKind.ConditionalExpression
]);

// Decision points for cyclomatic complexity (switch counts its case clauses).
const CYCLOMATIC_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.IfStatement,
    SyntaxKind.ForStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
    SyntaxKind.CaseClause,
    SyntaxKind.CatchClause,
    SyntaxKind.ConditionalExpression
]);

const LOGICAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.AmpersandAmpersandToken,
    SyntaxKind.BarBarToken,
    SyntaxKind.QuestionQuestionToken
]);

/**
 * Extracts the M2 fact set from a parsed source file: per-function complexity
 * metrics, per-catch error-handling signals, per-import dependency facts and the
 * file line count. Facts are emitted in source order, so the output is
 * deterministic. The cognitive-complexity figure is a documented approximation
 * of the SonarSource metric (nesting-weighted structures plus flat increments
 * for logical-operator occurrences), intended as a signal, not a verdict.
 */
export const extractFacts = (sourceFile: SourceFile, info: AdapterInfo): Fact[] => {
    const scheme = identitySchemeOf(info);
    const facts: Fact[] = [];
    const filePath = sourceFile.getFilePath();
    const build = factBuilder(info, filePath);

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(sourceFile), value: lineCount(sourceFile)}));
    facts.push(build({kind: 'metric.exportCount', kindOf: 'file', range: fileRange(sourceFile), value: countExports(sourceFile)}));

    const functions = functionLikeNodes(sourceFile).flatMap((fn) => {
        const body = functionBody(fn);
        return body === undefined ? [] : [{fn, body}];
    });
    const identities = declarationIdentities(functions.map(({fn}) => functionBase(fn, scheme)), scheme);
    for (const [index, {fn, body}] of functions.entries()) {
        const identity = identities[index];
        if (identity === undefined) {
            continue;
        }
        const {symbol, kind: identityKind} = identity;
        const metrics = measureBody(fn, body);
        const kindOf = subjectKindOf(fn);
        const range = rangeOfNode(sourceFile, fn);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, identityKind, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, identityKind, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, identityKind, range, value: metrics.nestingDepth}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, identityKind, range, value: metrics.parameterCount}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, identityKind, range, value: metrics.lineCount}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, identityKind, range, value: hasComplexityRationale(fn)}));
        facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, identityKind, range, value: metrics.nondeterministic}));
    }

    descendantsOfKind(sourceFile, SyntaxKind.CatchClause).forEach((clause, index) => {
        const block = clause.getBlock();
        const empty = block.getStatements().length === 0;
        const hasThrow = descendantsOfKind(block, SyntaxKind.ThrowStatement).length > 0;
        const hasCall = descendantsOfKind(block, SyntaxKind.CallExpression).length > 0;
        const range = rangeOfNode(sourceFile, clause);
        const symbol = `catch#${index}`;

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', site: true, symbol, range, value: empty}));
        facts.push(build({kind: 'ast.catchSwallowsError', kindOf: 'catch-clause', site: true, symbol, range, value: !hasThrow && !hasCall && !catchReadsError(clause)}));
        facts.push(build({kind: 'doc.catchHasRationale', kindOf: 'catch-clause', site: true, symbol, range, value: blockHasComment(block)}));
    });

    const referenced = referencedIdentifiers(sourceFile);
    sourceFile.getImportDeclarations().forEach((decl, index) => {
        const module = decl.getModuleSpecifierValue();
        const range = rangeOfNode(sourceFile, decl);
        const symbol = `import#${index}`;
        facts.push(build({kind: 'deps.import', kindOf: 'import', site: true, symbol, range, value: {module, isTypeOnly: decl.isTypeOnly()}}));

        const names = importedNames(decl);
        if (names.length > 0 && names.every((name) => !referenced.has(name))) {
            facts.push(build({kind: 'deps.importUnused', kindOf: 'import', site: true, symbol, range, value: module}));
        }
        if (isDeepImport(module, '/')) {
            facts.push(build({kind: 'deps.importDeep', kindOf: 'import', site: true, symbol, range, value: module}));
        }

        for (const binding of importedBindings(decl)) {
            facts.push(build({kind: 'deps.importName', kindOf: 'import', site: true, symbol, range, value: {module, name: binding.name, kind: binding.kind}}));
        }
    });

    facts.push(...exportFacts(sourceFile, build));

    // Class model (E3): neutral struct.typeDecl facts with embedded members.
    facts.push(...extractTsMemberFacts(sourceFile, build));

    descendantsOfKind(sourceFile, SyntaxKind.PropertyAssignment).forEach((property, index) => {
        if (property.getName() !== 'synchronize') {
            return;
        }
        const value = synchronizeValue(property);
        if (value === null) {
            return;
        }
        facts.push(build({kind: 'orm.synchronizeEnabled', kindOf: 'statement', site: true, symbol: `synchronize#${index}`, range: rangeOfNode(sourceFile, property), value}));
    });

    descendantsOfKind(sourceFile, SyntaxKind.ObjectLiteralExpression).forEach((object, index) => {
        const properties = object.getProperties();
        const syncEnabled = properties.some(
            (p) => Node.isPropertyAssignment(p) && p.getName() === 'synchronize' && synchronizeValue(p) !== null
        );
        const hasMigrations = properties.some(
            (p) => Node.isPropertyAssignment(p) && (p.getName() === 'migrations' || p.getName() === 'migrationsRun')
        );
        if (syncEnabled && hasMigrations) {
            facts.push(
                build({
                    kind: 'orm.syncWithMigrations',
                    kindOf: 'statement',
                    site: true,
                    symbol: `syncWithMigrations#${index}`,
                    range: rangeOfNode(sourceFile, object),
                    value: 'synchronize + migrations'
                })
            );
        }
    });

    if (isMigrationFile(sourceFile)) {
        const literals = [
            ...sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral),
            ...sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)
        ];
        const calls = descendantsOfKind(sourceFile, SyntaxKind.CallExpression);

        const candidates: {node: Node; descriptor: string}[] = [];
        for (const literal of literals) {
            const descriptor = unguardedDdl(literal.getLiteralText());
            if (descriptor !== null) {
                candidates.push({node: literal, descriptor});
            }
        }
        for (const call of calls) {
            const descriptor = unguardedQueryBuilderDdl(call);
            if (descriptor !== null) {
                candidates.push({node: call, descriptor});
            }
        }

        // One stable numbering across both raw SQL and the query-builder API,
        // ordered by source position so symbols stay deterministic.
        candidates.sort((a, b) => a.node.getStart() - b.node.getStart());
        candidates.forEach((candidate, index) => {
            facts.push(build({kind: 'migration.unguardedDdl', kindOf: 'statement', site: true, symbol: `ddl#${index}`, range: rangeOfNode(sourceFile, candidate.node), value: candidate.descriptor}));
        });

        // Dropping a table or column in up() destroys data on the forward path,
        // even when guarded with IF EXISTS. Scoped to up() so the expected drops
        // in down() (reversing a create) are not flagged.
        const losses: {node: Node; descriptor: string}[] = [];
        for (const literal of literals) {
            if (enclosingMethodName(literal) !== 'up') {
                continue;
            }
            const descriptor = destructiveDdl(literal.getLiteralText());
            if (descriptor !== null) {
                losses.push({node: literal, descriptor});
            }
        }
        for (const call of calls) {
            if (enclosingMethodName(call) !== 'up') {
                continue;
            }
            const descriptor = destructiveCall(call);
            if (descriptor !== null) {
                losses.push({node: call, descriptor});
            }
        }
        losses.sort((a, b) => a.node.getStart() - b.node.getStart());
        losses.forEach((loss, index) => {
            facts.push(build({kind: 'migration.dataLoss', kindOf: 'statement', site: true, symbol: `loss#${index}`, range: rangeOfNode(sourceFile, loss.node), value: loss.descriptor}));
        });

        // Adding a NOT NULL column without a default breaks on a non-empty table:
        // existing rows have no value for it. Only up() is in scope.
        const nullables: {node: Node; descriptor: string}[] = [];
        for (const literal of literals) {
            if (enclosingMethodName(literal) !== 'up') {
                continue;
            }
            const descriptor = nullableNoDefault(literal.getLiteralText());
            if (descriptor !== null) {
                nullables.push({node: literal, descriptor});
            }
        }
        for (const call of calls) {
            if (enclosingMethodName(call) !== 'up') {
                continue;
            }
            const descriptor = addColumnNotNullNoDefault(call);
            if (descriptor !== null) {
                nullables.push({node: call, descriptor});
            }
        }
        nullables.sort((a, b) => a.node.getStart() - b.node.getStart());
        nullables.forEach((nullable, index) => {
            facts.push(build({kind: 'migration.nullableNoDefault', kindOf: 'statement', site: true, symbol: `nullable#${index}`, range: rangeOfNode(sourceFile, nullable.node), value: nullable.descriptor}));
        });

        for (const cls of sourceFile.getClasses()) {
            if (!cls.getImplements().some((impl) => impl.getText().includes('MigrationInterface'))) {
                continue;
            }
            const descriptor = missingDown(cls.getMethod('down'));
            if (descriptor !== null) {
                facts.push(build({kind: 'migration.noDown', kindOf: 'class', symbol: cls.getName() ?? '(anonymous)', range: rangeOfNode(sourceFile, cls.getNameNode() ?? cls), value: descriptor}));
            }
        }
    }

    for (const cls of sourceFile.getClasses()) {
        if (!cls.getDecorators().some((decorator) => decorator.getName() === 'Entity')) {
            continue;
        }
        for (const property of cls.getProperties()) {
            for (const decorator of property.getDecorators()) {
                if (RELATION_DECORATORS.has(decorator.getName()) && decoratorHasEager(decorator)) {
                    facts.push(build({kind: 'orm.eagerRelation', kindOf: 'statement', symbol: `${cls.getName() ?? '(anonymous)'}.${property.getName()}`, range: rangeOfNode(sourceFile, decorator), value: decorator.getName()}));
                }
            }
        }
        // A subclass may inherit its primary key from a base entity, so only a
        // standalone @Entity without any primary column is reported.
        if (cls.getExtends() !== undefined || hasPrimaryKey(cls)) {
            continue;
        }
        facts.push(build({kind: 'orm.entityNoPrimaryKey', kindOf: 'class', symbol: cls.getName() ?? '(anonymous)', range: rangeOfNode(sourceFile, cls.getNameNode() ?? cls), value: 'entity has no primary key column'}));
    }

    // UI/UX accessibility facts from JSX elements (same ui.* facts the HTML
    // adapter emits, so the a11y rules fire on React/JSX too).
    facts.push(...extractJsxA11yFacts(sourceFile, build));

    // Trust-boundary facts: server request handlers that read client input
    // (req/request .body/.query/.params) without recognized validation.
    facts.push(...extractBackendValidationFacts(sourceFile, build));

    // Mass-assignment facts: the raw request payload flowing whole into
    // Object.assign or a persistence-verb call.
    facts.push(...extractMassAssignmentFacts(sourceFile, build));

    // Validation Trace ID annotations (// stoa:validation <ID>). Always
    // extracted (cheap, mirrors the existing stoa:allow-complexity marker scan);
    // only interpreted against a contract when --contracts is supplied.
    facts.push(...extractValidationAnnotations(sourceFile, build));

    // Whether an annotated schema is actually invoked, and whether a raw
    // request copy still reaches a sink despite validation having run.
    facts.push(...extractValidatorUsageFacts(sourceFile, build));

    // Where the VALIDATED value (not just the raw request) goes afterwards —
    // an Evidence Graph per validator invocation (same-function sink, a
    // one-hop cross-function trace, or an explicit unresolved destination).
    facts.push(...extractValidationDataflowFacts(sourceFile, build));

    if (scheme >= 3) {
        for (const anchor of topLevelAnchors(sourceFile)) {
            facts.push(build({kind: ANCHOR_FACT, kindOf: 'statement', symbol: anchor.name, range: rangeOfNode(sourceFile, anchor.node), value: {form: 'binding'} satisfies AnchorValue}));
        }
    }

    return facts;
};

/**
 * The top-level bindings of a module that can hold finding sites outside
 * every function (identity scheme 3, SiteIdentity.ts): each `const`/`let`/
 * `var` declarator with a plain name (its whole statement when it declares
 * only one, so a comment marker on the statement is inside), `export default
 * <expression>` as `default`, and an assignment to a dotted name
 * (`module.exports = {…}`, `exports.config = {…}`) by that name. A
 * destructuring pattern names no single binding and anchors nothing.
 */
const topLevelAnchors = (sourceFile: SourceFile): {name: string; node: Node}[] => {
    const anchors: {name: string; node: Node}[] = [];
    for (const statement of sourceFile.getStatements()) {
        if (Node.isVariableStatement(statement)) {
            const declarations = statement.getDeclarations();
            for (const declaration of declarations) {
                const name = declaration.getNameNode();
                if (Node.isIdentifier(name)) {
                    anchors.push({name: name.getText(), node: declarations.length === 1 ? statement : declaration});
                }
            }
        } else if (Node.isExportAssignment(statement)) {
            anchors.push({name: statement.isExportEquals() ? 'export=' : 'default', node: statement});
        } else if (Node.isExpressionStatement(statement)) {
            const expression = statement.getExpression();
            if (Node.isBinaryExpression(expression) && expression.getOperatorToken().getKind() === SyntaxKind.EqualsToken && isDottedName(expression.getLeft())) {
                anchors.push({name: expression.getLeft().getText(), node: statement});
            }
        }
    }
    return anchors;
};

const isDottedName = (node: Node): boolean => Node.isIdentifier(node) || (Node.isPropertyAccessExpression(node) && isDottedName(node.getExpression()));

// A TypeORM migration file: a class implementing `MigrationInterface`. Scoping
// the DDL scan to these files keeps SQL strings elsewhere from being flagged.
const isMigrationFile = (sourceFile: SourceFile): boolean => {
    return sourceFile.getClasses().some((cls) => cls.getImplements().some((impl) => impl.getText().includes('MigrationInterface')));
};

const enclosingMethodName = (node: Node): string | undefined => {
    return node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration)?.getName();
};

const destructiveCall = (call: CallExpression): string | null => {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) {
        return null;
    }
    const method = expression.getName();
    if (method === 'dropTable') {
        return 'dropTable() in up() destroys data';
    }
    if (method === 'dropColumn') {
        return 'dropColumn() in up() destroys data';
    }
    return null;
};

// Query-builder addColumn whose TableColumn is explicitly isNullable:false with
// no default. isNullable is left implicit a lot (TypeORM defaults to NOT NULL),
// so only an explicit false is treated as a signal — keeps the check low-noise.
const addColumnNotNullNoDefault = (call: CallExpression): string | null => {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== 'addColumn') {
        return null;
    }
    const options = tableColumnOptions(call.getArguments()[1]);
    if (options === undefined) {
        return null;
    }
    const isNullable = options.getProperty('isNullable');
    const explicitlyNotNull = isNullable !== undefined && Node.isPropertyAssignment(isNullable) && isNullable.getInitializerIfKind(SyntaxKind.FalseKeyword) !== undefined;
    if (!explicitlyNotNull || options.getProperty('default') !== undefined) {
        return null;
    }
    return 'addColumn() with isNullable:false and no default';
};

// The column options are the object literal in `new TableColumn({...})` (or a
// bare object literal passed directly).
const tableColumnOptions = (argument: Node | undefined): ObjectLiteralExpression | undefined => {
    if (argument === undefined) {
        return undefined;
    }
    if (Node.isNewExpression(argument)) {
        const inner = argument.getArguments()[0];
        return inner !== undefined && Node.isObjectLiteralExpression(inner) ? inner : undefined;
    }
    return Node.isObjectLiteralExpression(argument) ? argument : undefined;
};

// The programmatic TypeORM query-builder equivalents. Both take the existence
// guard as their second argument — createTable(table, ifNotExist?) and
// dropTable(table, ifExist?) — so a call with no second argument, or an
// explicit `false`, runs the DDL unconditionally. A non-literal second
// argument is given the benefit of the doubt to keep the check conservative.
const unguardedQueryBuilderDdl = (call: CallExpression): string | null => {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) {
        return null;
    }
    const method = expression.getName();

    if (method === 'createTable' || method === 'dropTable') {
        // createTable(table, ifNotExist?) / dropTable(table, ifExist?): the
        // existence guard is the second argument.
        const guard = call.getArguments()[1];
        if (guard !== undefined && guard.getKind() !== SyntaxKind.FalseKeyword) {
            return null;
        }
        return method === 'createTable' ? 'createTable() without the ifNotExist argument' : 'dropTable() without the ifExist argument';
    }

    if (method === 'addColumn' || method === 'dropColumn') {
        // addColumn/dropColumn have no existence flag in TypeORM; the robust
        // pattern is a surrounding hasColumn() check. If the enclosing method
        // never calls hasColumn, treat the column change as unguarded.
        if (hasColumnGuardInScope(call)) {
            return null;
        }
        return method === 'addColumn' ? 'addColumn() without a hasColumn guard' : 'dropColumn() without a hasColumn guard';
    }

    return null;
};

const RELATION_DECORATORS = new Set(['OneToOne', 'OneToMany', 'ManyToOne', 'ManyToMany']);

// The options object may sit in any argument position (after the target, or
// after both the target and the inverse-side function), so every argument is
// scanned for an `eager: true` entry.
const decoratorHasEager = (decorator: Decorator): boolean => {
    return decorator.getArguments().some((argument) => {
        if (!Node.isObjectLiteralExpression(argument)) {
            return false;
        }
        const eager = argument.getProperty('eager');
        return eager !== undefined && Node.isPropertyAssignment(eager) && eager.getInitializerIfKind(SyntaxKind.TrueKeyword) !== undefined;
    });
};

const PRIMARY_DECORATORS = new Set(['PrimaryColumn', 'PrimaryGeneratedColumn', 'ObjectIdColumn']);

const hasPrimaryKey = (cls: ClassDeclaration): boolean => {
    return cls.getProperties().some((property) =>
        property.getDecorators().some((decorator) => {
            const name = decorator.getName();
            return PRIMARY_DECORATORS.has(name) || (name === 'Column' && columnMarkedPrimary(decorator));
        })
    );
};

// @Column({primary: true}) is an alternative way to declare the key.
const columnMarkedPrimary = (decorator: Decorator): boolean => {
    const argument = decorator.getArguments()[0];
    if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        return false;
    }
    const primary = argument.getProperty('primary');
    return primary !== undefined && Node.isPropertyAssignment(primary) && primary.getInitializerIfKind(SyntaxKind.TrueKeyword) !== undefined;
};

// A migration is reversible only if its down() actually undoes something. A
// missing or empty down() is the concern; a down() that deliberately throws
// (declaring the migration irreversible) is a conscious choice and left alone.
const missingDown = (down: MethodDeclaration | undefined): string | null => {
    if (down === undefined) {
        return 'migration has no down() method';
    }
    const body = down.getBody();
    if (body !== undefined && Node.isBlock(body) && body.getStatements().length === 0) {
        return 'migration down() is empty';
    }
    return null;
};

const hasColumnGuardInScope = (call: CallExpression): boolean => {
    const scope =
        call.getFirstAncestor(
            (node) => Node.isMethodDeclaration(node) || Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node)
        ) ?? call.getSourceFile();
    return descendantsOfKind(scope, SyntaxKind.CallExpression).some((candidate) => {
        const callee = candidate.getExpression();
        return Node.isPropertyAccessExpression(callee) && callee.getName() === 'hasColumn';
    });
};

// Detects a TypeORM-style `synchronize: true` (or `… ?? true`, which defaults to
// true) property. The property name is specific enough to be high-precision.
const synchronizeValue = (property: PropertyAssignment): string | null => {
    const initializer = property.getInitializer();
    if (initializer === undefined) {
        return null;
    }
    if (initializer.getKind() === SyntaxKind.TrueKeyword) {
        return 'true';
    }
    if (
        Node.isBinaryExpression(initializer) &&
        initializer.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken &&
        initializer.getRight().getKind() === SyntaxKind.TrueKeyword
    ) {
        return '?? true (defaults to true)';
    }
    return null;
};

interface ImportBinding {
    name: string;
    kind: 'named' | 'default' | 'namespace';
}

// Imported names, mapped to the name as EXPORTED by the target (not the local
// alias), so a dead-export rule can match uses against exports.
const importedBindings = (decl: ImportDeclaration): ImportBinding[] => {
    const bindings: ImportBinding[] = [];
    if (decl.getDefaultImport() !== undefined) {
        bindings.push({name: 'default', kind: 'default'});
    }
    if (decl.getNamespaceImport() !== undefined) {
        bindings.push({name: '*', kind: 'namespace'});
    }
    for (const named of decl.getNamedImports()) {
        bindings.push({name: named.getName(), kind: 'named'});
    }
    return bindings;
};

interface ExportedName {
    name: string;
    range: SourceRange;
}

interface Reexport {
    symbol: string;
    range: SourceRange;
    value: ReexportValue;
}

// `deps.export` per exported name, `deps.reexport` per `export … from` (see DepsFacts.ts).
const exportFacts = (sourceFile: SourceFile, build: ReturnType<typeof factBuilder>): Fact[] => [
    ...collectExportNames(sourceFile).map((exported) => build({kind: 'deps.export', kindOf: 'module', symbol: exported.name, range: exported.range, value: exported.name})),
    ...collectReexports(sourceFile).map((reexport) => build({kind: 'deps.reexport', kindOf: 'module', symbol: reexport.symbol, range: reexport.range, value: {...reexport.value}}))
];

const collectReexports = (sourceFile: SourceFile): Reexport[] => {
    const out: Reexport[] = [];
    sourceFile.getExportDeclarations().forEach((declaration, index) => {
        const module = declaration.getModuleSpecifierValue();
        if (module === undefined) {
            return;
        }
        const named = declaration.getNamedExports();
        if (named.length === 0) {
            const namespace = declaration.getNamespaceExport()?.getName();
            const kind = namespace === undefined ? 'star' : 'namespace';
            out.push({symbol: `reexport#${index}`, range: rangeOfNode(sourceFile, declaration), value: {module, name: '*', exportedAs: namespace ?? '*', kind, isTypeOnly: declaration.isTypeOnly()}});
            return;
        }
        named.forEach((specifier, position) => {
            const name = specifier.getNameNode().getText();
            const exportedAs = specifier.getAliasNode()?.getText() ?? name;
            out.push({
                symbol: `reexport#${index}.${position}`,
                range: rangeOfNode(sourceFile, specifier),
                value: {module, name, exportedAs, kind: 'named', isTypeOnly: declaration.isTypeOnly() || specifier.isTypeOnly()}
            });
        });
    });
    return out;
};

// Memoized per parse: `countExports` and `exportFacts` both read it. Keyed by
// the compiler node — re-parsing a path can hand back the same SourceFile
// wrapper with new content.
const exportNamesCache = new WeakMap<ts.SourceFile, ExportedName[]>();

const collectExportNames = (sourceFile: SourceFile): ExportedName[] => {
    const cached = exportNamesCache.get(sourceFile.compilerNode);
    if (cached !== undefined) {
        return cached;
    }
    const out: ExportedName[] = [];
    exportNamesCache.set(sourceFile.compilerNode, out);
    const add = (name: string, node: Node): void => {
        out.push({name, range: rangeOfNode(sourceFile, node)});
    };
    const lookup = exportLookup(sourceFile);

    for (const d of sourceFile.getFunctions()) {
        if (lookup.isExported(d)) {
            add(lookup.isDefaultExport(d) ? 'default' : (d.getName() ?? 'default'), d);
        }
    }
    for (const d of sourceFile.getClasses()) {
        if (lookup.isExported(d)) {
            add(lookup.isDefaultExport(d) ? 'default' : (d.getName() ?? 'default'), d);
        }
    }
    for (const d of sourceFile.getInterfaces()) {
        if (lookup.isExported(d)) {
            add(d.getName(), d);
        }
    }
    for (const d of sourceFile.getTypeAliases()) {
        if (lookup.isExported(d)) {
            add(d.getName(), d);
        }
    }
    for (const d of sourceFile.getEnums()) {
        if (lookup.isExported(d)) {
            add(d.getName(), d);
        }
    }
    for (const statement of sourceFile.getVariableStatements()) {
        if (lookup.isExported(statement)) {
            for (const declaration of statement.getDeclarations()) {
                add(declaration.getName(), declaration);
            }
        }
    }
    for (const exportDeclaration of sourceFile.getExportDeclarations()) {
        for (const specifier of exportDeclaration.getNamedExports()) {
            add((specifier.getAliasNode() ?? specifier.getNameNode()).getText(), specifier);
        }
    }
    for (const assignment of sourceFile.getExportAssignments()) {
        if (!assignment.isExportEquals()) {
            add('default', assignment);
        }
    }
    return out;
};

// Non-deterministic APIs: their use makes a unit's output depend on wall-clock /
// RNG, which undermines reproducibility and testability (marcus.control).
const NONDETERMINISTIC_CALLS: ReadonlySet<string> = new Set(['Math.random', 'Date.now', 'performance.now']);

// Identifier texts referenced anywhere outside an import declaration. Walks
// the compiler tree directly — the same children ts-morph's
// getDescendantsOfKind(Identifier) visits (`getChildren`, JSDoc included) —
// and skips each import declaration as a whole, instead of wrapping every
// identifier and walking its ancestors (measured: the most expensive single
// fact family of the TS extraction).
const referencedIdentifiers = (sourceFile: SourceFile): Set<string> => {
    const names = new Set<string>();
    const file = sourceFile.compilerNode;
    const walk = (node: ts.Node): void => {
        for (const child of node.getChildren(file)) {
            if (child.kind === ts.SyntaxKind.ImportDeclaration) {
                continue;
            }
            if (child.kind === ts.SyntaxKind.Identifier) {
                names.add(child.getText(file));
            }
            walk(child);
        }
    };
    walk(file);
    return names;
};

const importedNames = (decl: ImportDeclaration): string[] => {
    const names: string[] = [];
    const def = decl.getDefaultImport();
    if (def !== undefined) {
        names.push(def.getText());
    }
    const ns = decl.getNamespaceImport();
    if (ns !== undefined) {
        names.push(ns.getText());
    }
    for (const named of decl.getNamedImports()) {
        names.push((named.getAliasNode() ?? named.getNameNode()).getText());
    }
    return names;
};

// Counts the module's public surface syntactically (no module resolution), so a
// file with unresolved re-exports is still counted safely.
// Every exported declaration, named export specifier (`export {a, b}`;
// `export *` contributes 0) and export assignment (`export default <expr>`,
// `export =`). The same declarations `collectExportNames` lists — which
// leaves out only `export =` — so it is counted from that list rather than by
// asking `isExported()` (a symbol lookup) of every declaration a second time.
const countExports = (sourceFile: SourceFile): number =>
    collectExportNames(sourceFile).length + sourceFile.getExportAssignments().filter((assignment) => assignment.isExportEquals()).length;

const functionLikeNodes = (sourceFile: SourceFile): Node[] => descendantsOfKinds(sourceFile, FUNCTION_LIKE_KINDS);

/**
 * One walk over a function's body for everything measured per function: the
 * complexity metrics and whether it calls a non-deterministic API — the body
 * itself included, so an expression body counts. Nested functions are their
 * own units and are skipped. Walks the compiler tree
 * (`ts.forEachChild`) — the same children ts-morph's `forEachChild` visits,
 * without building a wrapper array per node; texts are the same
 * `getText()` slices ts-morph returns.
 */
const measureBody = (fn: Node, body: Node): FunctionMetrics & {nondeterministic: boolean} => {
    const file = body.getSourceFile().compilerNode;
    const state = {cyclomatic: 1, cognitive: 0, maxNesting: 0, nondeterministic: false};
    // `inspect` measures one node and then its children. It starts at the body
    // itself, so an expression body (`() => a && b`, `() => Math.random()`)
    // counts like its block form `{ return …; }`; a block body is in none of
    // the kind sets and adds nothing itself.
    const inspect = (node: ts.Node, nesting: number): undefined => {
        const kind = node.kind as SyntaxKind;
        if (FUNCTION_LIKE_KINDS.has(kind)) {
            return undefined;
        }
        if (CYCLOMATIC_KINDS.has(kind)) {
            state.cyclomatic += 1;
        }
        if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind as SyntaxKind)) {
            state.cyclomatic += 1;
            state.cognitive += 1;
        }
        if (ts.isCallExpression(node) && NONDETERMINISTIC_CALLS.has(node.expression.getText(file))) {
            state.nondeterministic = true;
        }
        if (ts.isNewExpression(node) && node.expression.getText(file) === 'Date' && (node.arguments?.length ?? 0) === 0) {
            state.nondeterministic = true;
        }
        state.cognitive += structureIncrement(node, nesting);
        const childNesting = nestsDeeper(node) ? nesting + 1 : nesting;
        if (childNesting > state.maxNesting) {
            state.maxNesting = childNesting;
        }
        ts.forEachChild(node, (child) => inspect(child, childNesting));
        return undefined;
    };
    inspect(body.compilerNode, 0);
    return {
        cyclomatic: state.cyclomatic,
        cognitive: state.cognitive,
        nestingDepth: state.maxNesting,
        parameterCount: parameterCount(fn),
        lineCount: lineSpanOf(fn.getSourceFile(), fn),
        nondeterministic: state.nondeterministic
    };
};

/**
 * An `else if`: the `if` that is the else branch of another `if` continues
 * that chain — one flat cognitive increment, no extra nesting level
 * (SonarSource cognitive complexity). An `if` inside an `else { … }` block is
 * nested as usual.
 */
const isElseIf = (node: ts.Node): boolean => ts.isIfStatement(node) && ts.isIfStatement(node.parent) && node.parent.elseStatement === node;

/** Whether `node` opens a nesting level: a nesting structure that is not an else-if. */
const nestsDeeper = (node: ts.Node): boolean => NESTING_KINDS.has(node.kind as SyntaxKind) && !isElseIf(node);

/** The cognitive increment of the structure `node` itself at `nesting`: 1 + nesting when it nests, 1 for an else-if, else 0. */
const structureIncrement = (node: ts.Node, nesting: number): number => {
    if (isElseIf(node)) {
        return 1;
    }
    return NESTING_KINDS.has(node.kind as SyntaxKind) ? 1 + nesting : 0;
};

const functionBody = (fn: Node): Node | undefined => {
    const holder = fn as unknown as {getBody?: () => Node | undefined};
    return holder.getBody?.();
};

const parameterCount = (fn: Node): number => {
    const holder = fn as unknown as {getParameters?: () => unknown[]};
    return holder.getParameters?.().length ?? 0;
};

/**
 * The name a function-like node declares or is bound to: its own name
 * (`function f`, method `run`, a named function expression), `constructor`,
 * or the binding that holds it — `const handler = () => …`, an object
 * property `onClick: () => …`, a class field `run = () => …`. `undefined` for
 * a function with none of these (a callback passed as an argument).
 */
const ownName = (fn: Node): string | undefined => {
    const holder = fn as unknown as {getName?: () => string | undefined};
    const name = holder.getName?.();
    if (name !== undefined && name.length > 0) {
        return name;
    }
    if (fn.getKind() === SyntaxKind.Constructor) {
        return 'constructor';
    }
    const parent = fn.getParent();
    if (parent !== undefined && (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent))) {
        const nameNode = parent.getNameNode();
        if (Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode) || Node.isPrivateIdentifier(nameNode)) {
            return nameNode.getText().replace(/^['"]|['"]$/g, '');
        }
    }
    return undefined;
};

/**
 * The name of a node that scopes the functions inside it, or `undefined`
 * when it scopes nothing nameable: a named class or namespace, a named (or
 * bound) function, or a variable, object property or class field whose
 * initializer is not itself a function (`const api = {run() {}}` → `api.run`,
 * `const pair = list.map(() => …)` → `pair.(anonymous)#0`). A binding whose
 * initializer IS a function is that function's own name (`ownName`), not a
 * second scope.
 */
const scopeName = (node: Node, scheme: IdentityScheme): string | undefined => {
    if (Node.isModuleDeclaration(node)) {
        // `namespace A.B {}` is two nested declarations; ts-morph names the
        // outer one `A.B`, which with the inner `B` made `A.B.B` (scheme 1).
        return scheme === 1 ? node.getName() : node.compilerNode.name.text;
    }
    if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
        return node.getName();
    }
    if (FUNCTION_LIKE_KINDS.has(node.getKind())) {
        return ownName(node);
    }
    if (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node) || Node.isPropertyDeclaration(node)) {
        return bindingScopeName(node);
    }
    return undefined;
};

/** A binding whose initializer is not itself a function (`const api = {run() {}}`): its name scopes what it holds. */
const bindingScopeName = (node: VariableDeclaration | PropertyAssignment | PropertyDeclaration): string | undefined => {
    const initializer = node.getInitializer();
    const nameNode = node.getNameNode();
    if (initializer === undefined || FUNCTION_LIKE_KINDS.has(initializer.getKind())) {
        return undefined;
    }
    return Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode) || Node.isPrivateIdentifier(nameNode) ? nameNode.getText().replace(/^['"]|['"]$/g, '') : undefined;
};

/**
 * A function's identity base: its name qualified by every enclosing named
 * scope (`Service.run`, `outer.inner`, `api.run`), so two classes' `run` in
 * one file no longer share a symbol. A function with no name is
 * `<scope>.(anonymous)`, numbered within that scope (`declarationSymbols`) —
 * never by its line, which any edit above it would shift.
 */
const functionBase = (fn: Node, scheme: IdentityScheme): DeclarationBase => {
    const scopes: string[] = [];
    for (let node = fn.getParent(); node !== undefined; node = node.getParent()) {
        const name = scopeName(node, scheme);
        if (name !== undefined && name.length > 0) {
            scopes.unshift(name);
        }
    }
    const own = ownName(fn);
    const variant = Node.isGetAccessorDeclaration(fn) ? ':get' : Node.isSetAccessorDeclaration(fn) ? ':set' : undefined;
    return {base: [...scopes, own ?? '(anonymous)'].join('.'), anonymous: own === undefined, ...(variant !== undefined ? {variant} : {})};
};

const subjectKindOf = (fn: Node): SubjectKind => {
    return fn.getKind() === SyntaxKind.MethodDeclaration ? 'method' : 'function';
};

// An explicit, inline opt-out marker lets a team accept complexity it judges
// necessary — the "context beats threshold" rule in action (see docs rule-model).
const RATIONALE_MARKER = 'stoa:allow-complexity';

const hasComplexityRationale = (fn: Node): boolean => {
    return fn.getLeadingCommentRanges().some((comment) => comment.getText().includes(RATIONALE_MARKER));
};

// A comment anywhere inside a catch block documents why the error is
// deliberately not propagated — exactly what R-ERR-SWALLOWED's remediation asks
// for ("comment an intentionally ignored case"). Comments are trivia, so they
// are found as the leading trivia of the tokens after the opening brace; a
// comment-only block has no statements and its comment is the leading trivia
// of the closing brace. The raw compiler API is used on purpose: ts-morph's
// comment-statement handling would hide such comments from getStatements().
const blockHasComment = (block: Block): boolean => {
    const sourceFile = block.getSourceFile().compilerNode;
    const text = sourceFile.getFullText();
    const afterOpenBrace = block.getStart() + 1;
    const visit = (node: ts.Node): boolean => {
        if (node.pos >= afterOpenBrace && (ts.getLeadingCommentRanges(text, node.pos)?.length ?? 0) > 0) {
            return true;
        }
        return node.getChildren(sourceFile).some(visit);
    };
    return visit(block.compilerNode);
};

// A catch whose bound error is READ inside the block (assigned elsewhere,
// passed, returned, stored in a field) hands the error on rather than
// swallowing it — e.g. a retry loop keeping `lastError = e` for afterwards.
// A write to the binding itself (`e = x`), a property name (`x.e`, `{e: 1}`)
// or a shadowing declaration is not a read.
const catchReadsError = (clause: CatchClause): boolean => {
    const nameNode = clause.getVariableDeclaration()?.getNameNode();
    if (nameNode === undefined) {
        return false;
    }
    const bound = Node.isIdentifier(nameNode)
        ? [nameNode]
        : descendantsOfKind(nameNode, SyntaxKind.BindingElement).map((element) => element.getNameNode()).filter(Node.isIdentifier);
    const names = new Set(bound.map((identifier) => identifier.getText()));
    return clause
        .getBlock()
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((identifier) => names.has(identifier.getText()) && isIdentifierRead(identifier));
};

const isIdentifierRead = (identifier: Node): boolean => {
    const parent = identifier.getParent();
    if (parent === undefined) {
        return false;
    }
    if ((Node.isPropertyAccessExpression(parent) || Node.isPropertyAssignment(parent)) && parent.getNameNode() === identifier) {
        return false;
    }
    if ((Node.isVariableDeclaration(parent) || Node.isParameterDeclaration(parent) || Node.isBindingElement(parent)) && parent.getNameNode() === identifier) {
        return false;
    }
    return !(Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken && parent.getLeft() === identifier);
};

const fileRange = (sourceFile: SourceFile): SourceRange => {
    const lines = Math.max(lineCount(sourceFile), 1);
    return {startLine: 1, startCol: 0, endLine: lines, endCol: 0};
};

const lineCount = (sourceFile: SourceFile): number => {
    const text = sourceFile.getFullText();
    if (text.length === 0) {
        return 0;
    }
    return text.split('\n').length;
};
