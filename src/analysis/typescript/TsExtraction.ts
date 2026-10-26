import {Node, SyntaxKind} from 'ts-morph';
import type {CallExpression, ClassDeclaration, Decorator, ImportDeclaration, MethodDeclaration, PropertyAssignment, SourceFile} from 'ts-morph';
import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {factBuilder, type AdapterInfo} from '../FactBuilder.js';
import {isDeepImport} from '../ImportPath.js';

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
    const facts: Fact[] = [];
    const filePath = sourceFile.getFilePath();
    const build = factBuilder(info, filePath);

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(sourceFile), value: lineCount(sourceFile)}));
    facts.push(build({kind: 'metric.exportCount', kindOf: 'file', range: fileRange(sourceFile), value: countExports(sourceFile)}));

    for (const fn of functionLikeNodes(sourceFile)) {
        const body = functionBody(fn);
        if (body === undefined) {
            continue;
        }

        const metrics = computeMetrics(fn, body);
        const symbol = functionName(fn);
        const kindOf = subjectKindOf(fn);
        const range = rangeOf(sourceFile, fn);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, range, value: metrics.nestingDepth}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, range, value: metrics.parameterCount}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, range, value: metrics.lineCount}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, range, value: hasComplexityRationale(fn)}));
        facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, range, value: usesNondeterminism(body)}));
    }

    sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause).forEach((clause, index) => {
        const block = clause.getBlock();
        const empty = block.getStatements().length === 0;
        const hasThrow = block.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0;
        const hasCall = block.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0;
        const range = rangeOf(sourceFile, clause);
        const symbol = `catch#${index}`;

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', symbol, range, value: empty}));
        facts.push(build({kind: 'ast.catchSwallowsError', kindOf: 'catch-clause', symbol, range, value: !hasThrow && !hasCall}));
    });

    const referenced = referencedIdentifiers(sourceFile);
    sourceFile.getImportDeclarations().forEach((decl, index) => {
        const module = decl.getModuleSpecifierValue();
        const range = rangeOf(sourceFile, decl);
        const symbol = `import#${index}`;
        facts.push(build({kind: 'deps.import', kindOf: 'import', symbol, range, value: {module, isTypeOnly: decl.isTypeOnly()}}));

        const names = importedNames(decl);
        if (names.length > 0 && names.every((name) => !referenced.has(name))) {
            facts.push(build({kind: 'deps.importUnused', kindOf: 'import', symbol, range, value: module}));
        }
        if (isDeepImport(module, '/')) {
            facts.push(build({kind: 'deps.importDeep', kindOf: 'import', symbol, range, value: module}));
        }

        for (const binding of importedBindings(decl)) {
            facts.push(build({kind: 'deps.importName', kindOf: 'import', symbol, range, value: {module, name: binding.name, kind: binding.kind}}));
        }
    });

    for (const exported of collectExportNames(sourceFile)) {
        facts.push(build({kind: 'deps.export', kindOf: 'module', symbol: exported.name, range: exported.range, value: exported.name}));
    }

    sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach((property, index) => {
        if (property.getName() !== 'synchronize') {
            return;
        }
        const value = synchronizeValue(property);
        if (value === null) {
            return;
        }
        facts.push(build({kind: 'orm.synchronizeEnabled', kindOf: 'statement', symbol: `synchronize#${index}`, range: rangeOf(sourceFile, property), value}));
    });

    sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression).forEach((object, index) => {
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
                    symbol: `syncWithMigrations#${index}`,
                    range: rangeOf(sourceFile, object),
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
        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

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
            facts.push(build({kind: 'migration.unguardedDdl', kindOf: 'statement', symbol: `ddl#${index}`, range: rangeOf(sourceFile, candidate.node), value: candidate.descriptor}));
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
            facts.push(build({kind: 'migration.dataLoss', kindOf: 'statement', symbol: `loss#${index}`, range: rangeOf(sourceFile, loss.node), value: loss.descriptor}));
        });

        for (const cls of sourceFile.getClasses()) {
            if (!cls.getImplements().some((impl) => impl.getText().includes('MigrationInterface'))) {
                continue;
            }
            const descriptor = missingDown(cls.getMethod('down'));
            if (descriptor !== null) {
                facts.push(build({kind: 'migration.noDown', kindOf: 'class', symbol: cls.getName() ?? '(anonymous)', range: rangeOf(sourceFile, cls.getNameNode() ?? cls), value: descriptor}));
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
                    facts.push(build({kind: 'orm.eagerRelation', kindOf: 'statement', symbol: property.getName(), range: rangeOf(sourceFile, decorator), value: decorator.getName()}));
                }
            }
        }
        // A subclass may inherit its primary key from a base entity, so only a
        // standalone @Entity without any primary column is reported.
        if (cls.getExtends() !== undefined || hasPrimaryKey(cls)) {
            continue;
        }
        facts.push(build({kind: 'orm.entityNoPrimaryKey', kindOf: 'class', symbol: cls.getName() ?? '(anonymous)', range: rangeOf(sourceFile, cls.getNameNode() ?? cls), value: 'entity has no primary key column'}));
    }

    return facts;
};

// A TypeORM migration file: a class implementing `MigrationInterface`. Scoping
// the DDL scan to these files keeps SQL strings elsewhere from being flagged.
const isMigrationFile = (sourceFile: SourceFile): boolean => {
    return sourceFile.getClasses().some((cls) => cls.getImplements().some((impl) => impl.getText().includes('MigrationInterface')));
};

const CREATE_TABLE = /\bcreate\s+table\b/i;
const CREATE_TABLE_GUARDED = /\bcreate\s+table\s+if\s+not\s+exists\b/i;
const DROP_TABLE = /\bdrop\s+table\b/i;
const DROP_TABLE_GUARDED = /\bdrop\s+table\s+if\s+exists\b/i;
const ADD_COLUMN = /\badd\s+column\b/i;
const ADD_COLUMN_GUARDED = /\badd\s+column\s+if\s+not\s+exists\b/i;
const DROP_COLUMN = /\bdrop\s+column\b/i;
const DROP_COLUMN_GUARDED = /\bdrop\s+column\s+if\s+exists\b/i;

const unguardedDdl = (sql: string): string | null => {
    if (CREATE_TABLE.test(sql) && !CREATE_TABLE_GUARDED.test(sql)) {
        return 'CREATE TABLE without IF NOT EXISTS';
    }
    if (DROP_TABLE.test(sql) && !DROP_TABLE_GUARDED.test(sql)) {
        return 'DROP TABLE without IF EXISTS';
    }
    if (ADD_COLUMN.test(sql) && !ADD_COLUMN_GUARDED.test(sql)) {
        return 'ADD COLUMN without IF NOT EXISTS';
    }
    if (DROP_COLUMN.test(sql) && !DROP_COLUMN_GUARDED.test(sql)) {
        return 'DROP COLUMN without IF EXISTS';
    }
    return null;
};

const enclosingMethodName = (node: Node): string | undefined => {
    return node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration)?.getName();
};

// Destructive DDL in up() — the drop itself loses data regardless of guards.
const destructiveDdl = (sql: string): string | null => {
    if (DROP_TABLE.test(sql)) {
        return 'DROP TABLE in up() destroys data';
    }
    if (DROP_COLUMN.test(sql)) {
        return 'DROP COLUMN in up() destroys data';
    }
    return null;
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
    return scope.getDescendantsOfKind(SyntaxKind.CallExpression).some((candidate) => {
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

const collectExportNames = (sourceFile: SourceFile): ExportedName[] => {
    const out: ExportedName[] = [];
    const add = (name: string, node: Node): void => {
        out.push({name, range: rangeOf(sourceFile, node)});
    };

    for (const d of sourceFile.getFunctions()) {
        if (d.isExported()) {
            add(d.isDefaultExport() ? 'default' : (d.getName() ?? 'default'), d);
        }
    }
    for (const d of sourceFile.getClasses()) {
        if (d.isExported()) {
            add(d.isDefaultExport() ? 'default' : (d.getName() ?? 'default'), d);
        }
    }
    for (const d of sourceFile.getInterfaces()) {
        if (d.isExported()) {
            add(d.getName(), d);
        }
    }
    for (const d of sourceFile.getTypeAliases()) {
        if (d.isExported()) {
            add(d.getName(), d);
        }
    }
    for (const d of sourceFile.getEnums()) {
        if (d.isExported()) {
            add(d.getName(), d);
        }
    }
    for (const statement of sourceFile.getVariableStatements()) {
        if (statement.isExported()) {
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

const usesNondeterminism = (body: Node): boolean => {
    let found = false;
    const walk = (node: Node): void => {
        node.forEachChild((child) => {
            if (FUNCTION_LIKE_KINDS.has(child.getKind())) {
                return;
            }
            if (Node.isCallExpression(child) && NONDETERMINISTIC_CALLS.has(child.getExpression().getText())) {
                found = true;
            }
            if (Node.isNewExpression(child) && child.getExpression().getText() === 'Date' && child.getArguments().length === 0) {
                found = true;
            }
            walk(child);
        });
    };
    walk(body);
    return found;
};

// Identifier texts referenced anywhere outside an import declaration.
const referencedIdentifiers = (sourceFile: SourceFile): Set<string> => {
    const names = new Set<string>();
    for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === undefined) {
            names.add(id.getText());
        }
    }
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
const countExports = (sourceFile: SourceFile): number => {
    let count = 0;
    count += sourceFile.getFunctions().filter((declaration) => declaration.isExported()).length;
    count += sourceFile.getClasses().filter((declaration) => declaration.isExported()).length;
    count += sourceFile.getInterfaces().filter((declaration) => declaration.isExported()).length;
    count += sourceFile.getTypeAliases().filter((declaration) => declaration.isExported()).length;
    count += sourceFile.getEnums().filter((declaration) => declaration.isExported()).length;
    for (const statement of sourceFile.getVariableStatements()) {
        if (statement.isExported()) {
            count += statement.getDeclarations().length;
        }
    }
    for (const exportDeclaration of sourceFile.getExportDeclarations()) {
        count += exportDeclaration.getNamedExports().length; // `export {a, b}`; `export *` contributes 0
    }
    count += sourceFile.getExportAssignments().length; // `export default <expr>` / `export =`
    return count;
};

const functionLikeNodes = (sourceFile: SourceFile): Node[] => {
    const nodes: Node[] = [];
    sourceFile.forEachDescendant((node) => {
        if (FUNCTION_LIKE_KINDS.has(node.getKind())) {
            nodes.push(node);
        }
    });
    return nodes;
};

const computeMetrics = (fn: Node, body: Node): FunctionMetrics => {
    const state = {cyclomatic: 1, cognitive: 0, maxNesting: 0};
    visit(body, 0, state);

    return {
        cyclomatic: state.cyclomatic,
        cognitive: state.cognitive,
        nestingDepth: state.maxNesting,
        parameterCount: parameterCount(fn),
        lineCount: fn.getEndLineNumber() - fn.getStartLineNumber() + 1
    };
};

interface MetricState {
    cyclomatic: number;
    cognitive: number;
    maxNesting: number;
}

const visit = (node: Node, nesting: number, state: MetricState): void => {
    node.forEachChild((child) => {
        if (FUNCTION_LIKE_KINDS.has(child.getKind())) {
            // Nested functions are measured as their own units; skip them here.
            return;
        }

        const kind = child.getKind();

        if (CYCLOMATIC_KINDS.has(kind)) {
            state.cyclomatic += 1;
        }
        if (Node.isBinaryExpression(child) && LOGICAL_OPERATORS.has(child.getOperatorToken().getKind())) {
            state.cyclomatic += 1;
            state.cognitive += 1;
        }

        const isNesting = NESTING_KINDS.has(kind);
        if (isNesting) {
            state.cognitive += 1 + nesting;
        }

        const childNesting = isNesting ? nesting + 1 : nesting;
        if (childNesting > state.maxNesting) {
            state.maxNesting = childNesting;
        }

        visit(child, childNesting, state);
    });
};

const functionBody = (fn: Node): Node | undefined => {
    const holder = fn as unknown as {getBody?: () => Node | undefined};
    return holder.getBody?.();
};

const parameterCount = (fn: Node): number => {
    const holder = fn as unknown as {getParameters?: () => unknown[]};
    return holder.getParameters?.().length ?? 0;
};

const functionName = (fn: Node): string => {
    const holder = fn as unknown as {getName?: () => string | undefined};
    const name = holder.getName?.();
    if (name !== undefined && name.length > 0) {
        return name;
    }
    if (fn.getKind() === SyntaxKind.Constructor) {
        return 'constructor';
    }
    return `anonymous@${fn.getStartLineNumber()}`;
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

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
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
