import {declarationIdentities, uniqueIdentities, uniqueSymbols, type DeclarationBase, type IdentityKind, type IdentityScheme} from '../../FindingIdentity.js';
import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {factBuilder, identitySchemeOf, type AdapterInfo} from '../FactBuilder.js';
import type {StructImportBinding} from '../StructFacts.js';
import {isDeepImport} from '../ImportPath.js';
import {destructiveDdl, nullableNoDefault, unguardedDdl} from '../MigrationSql.js';
import {childNodes, collect, isPhpNode, rangeOf, type PhpNode} from './PhpAst.js';
import {extractPhpMemberFacts} from './PhpMembers.js';
import {referencedLocalNames} from './PhpReferences.js';


interface FunctionMetrics {
    cyclomatic: number;
    cognitive: number;
    nestingDepth: number;
    parameterCount: number;
    lineCount: number;
}

interface MetricState {
    cyclomatic: number;
    cognitive: number;
    maxNesting: number;
}

const FUNCTION_LIKE: ReadonlySet<string> = new Set(['function', 'method', 'closure', 'arrowfunc']);
const NESTING_KINDS: ReadonlySet<string> = new Set(['if', 'for', 'foreach', 'while', 'do', 'switch', 'catch', 'retif']);
const CYCLOMATIC_KINDS: ReadonlySet<string> = new Set(['if', 'for', 'foreach', 'while', 'do', 'case', 'catch', 'retif']);
const LOGICAL_TYPES: ReadonlySet<string> = new Set(['&&', '||', '??', 'and', 'or']);
const RATIONALE_MARKER = 'stoa:allow-complexity';

/**
 * Extracts the same fact set as the TypeScript adapter from a PHP program:
 * per-function complexity metrics, per-catch error-handling signals, per-use
 * dependency facts and the file line count. This is what makes the fact schema
 * sprachneutral — the rule engine cannot tell PHP from TypeScript. The cognitive
 * figure is the same documented approximation as the TS adapter.
 */
export const extractFacts = (program: PhpNode, content: string, filePath: string, info: AdapterInfo): Fact[] => {
    const scheme = identitySchemeOf(info);
    const facts: Fact[] = [];
    const build = factBuilder(info, filePath);
    const lines = content.split('\n');

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(lines), value: lineCount(content)}));

    // An abstract or interface method has `body: null` — nothing to measure.
    const functions = qualifiedFunctions(program, scheme).flatMap(({fn, base}) => (isPhpNode(fn.body) ? [{fn, body: fn.body, base}] : []));
    const identities = declarationIdentities(functions.map(({base}) => base), scheme);
    for (const [index, {fn, body}] of functions.entries()) {
        const identity = identities[index];
        if (identity === undefined) {
            continue;
        }
        const {symbol, kind: identityKind} = identity;
        const metrics = computeMetrics(fn, body);
        const kindOf: SubjectKind = fn.kind === 'method' ? 'method' : 'function';
        const range = rangeOf(fn);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, identityKind, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, identityKind, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, identityKind, range, value: metrics.nestingDepth}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, identityKind, range, value: metrics.parameterCount}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, identityKind, range, value: metrics.lineCount}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, identityKind, range, value: leadingHasMarker(lines, range.startLine)}));
        facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, identityKind, range, value: usesNondeterminism(body)}));
    }

    collect(program, (node) => node.kind === 'catch').forEach((clause, index) => {
        const body = clause.body as PhpNode | undefined;
        const children = (body?.children as PhpNode[] | undefined) ?? [];
        const empty = children.length === 0;
        const hasThrow = children.length > 0 && exists(body as PhpNode, (node) => node.kind === 'throw');
        const hasCall = children.length > 0 && exists(body as PhpNode, (node) => node.kind === 'call');
        const symbol = `catch#${index}`;

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', site: true, symbol, range: rangeOf(clause), value: empty}));
        facts.push(
            build({
                kind: 'ast.catchSwallowsError',
                kindOf: 'catch-clause',
                site: true,
                symbol,
                range: rangeOf(clause),
                value: !hasThrow && !hasCall && !catchReadsError(clause)
            })
        );
        facts.push(
            build({
                kind: 'doc.catchHasRationale',
                kindOf: 'catch-clause',
                site: true,
                symbol,
                range: rangeOf(clause),
                value: body !== undefined && exists(body, (node) => node.kind === 'commentline' || node.kind === 'commentblock')
            })
        );
    });

    const referenced = referencedLocalNames(program);
    const classBindings: StructImportBinding[] = [];
    let importIndex = 0;
    for (const group of collect(program, (node) => node.kind === 'usegroup')) {
        for (const item of (group.items as PhpNode[] | undefined) ?? []) {
            // A group use (`use App\{A, B}`) names its items relative to the group prefix.
            const module = qualifiedUseName(group, item);
            classBindings.push(...classBinding(group, item, module));
            const symbol = `import#${importIndex}`;
            facts.push(build({kind: 'deps.import', kindOf: 'import', site: true, symbol, range: rangeOf(group), value: {module, isTypeOnly: false, useKind: useKindOf(group, item)}}));

            const local = aliasName(item) ?? lastSegment(module);
            if (local.length > 0 && !referenced.has(local)) {
                facts.push(build({kind: 'deps.importUnused', kindOf: 'import', site: true, symbol, range: rangeOf(group), value: module}));
            }
            if (isDeepImport(module, '\\')) {
                facts.push(build({kind: 'deps.importDeep', kindOf: 'import', site: true, symbol, range: rangeOf(group), value: module}));
            }
            importIndex += 1;
        }
    }

    // Class-level identities: a class's name, or `(anonymous)` for
    // `new class …` — numbered `(anonymous)#n` when one file holds several.
    const classes = collect(program, (node) => node.kind === 'class');
    const namespaces = typeNamespaces(program, scheme);
    const classIdentities = new Map(
        uniqueIdentities(classes.map((cls) => qualifiedName(namespaces.get(cls) ?? '', [nodeName(cls)]))).map((identity, index) => {
            const cls = classes[index] as PhpNode;
            return [cls, nodeName(cls) === '(anonymous)' ? {symbol: identity.symbol, kind: 'anonymous' as const} : identity];
        })
    );
    const classSymbol = (cls: PhpNode): string => classIdentities.get(cls)?.symbol ?? nodeName(cls);
    const classKind = (cls: PhpNode): IdentityKind => classIdentities.get(cls)?.kind ?? 'declaration';

    for (const cls of collect(program, isDoctrineMigration)) {
        // Two Doctrine migration styles: raw SQL via $this->addSql('...') and the
        // DBAL Schema API ($schema->dropTable(), $table->addColumn(...)). Raw SQL
        // runs through the shared MigrationSql checks; the Schema API has no
        // IF [NOT] EXISTS concept, so only data-loss and nullable apply there.
        const sqlStatements: {sql: string; node: PhpNode}[] = [];
        const losses: {node: PhpNode; descriptor: string}[] = [];
        const nullables: {node: PhpNode; descriptor: string}[] = [];

        for (const method of collect(cls, (node) => node.kind === 'method')) {
            const inUp = functionName(method) === 'up';
            for (const call of collect(method, (node) => node.kind === 'call')) {
                const name = callMethodName(call);
                if (name === null) {
                    continue;
                }
                if (name === 'addSql') {
                    const sql = firstStringArgument(call);
                    if (sql === null) {
                        continue;
                    }
                    sqlStatements.push({sql, node: call});
                    if (inUp) {
                        const loss = destructiveDdl(sql);
                        if (loss !== null) {
                            losses.push({node: call, descriptor: loss});
                        }
                        const nullable = nullableNoDefault(sql);
                        if (nullable !== null) {
                            nullables.push({node: call, descriptor: nullable});
                        }
                    }
                } else if (inUp && (name === 'dropTable' || name === 'dropColumn')) {
                    losses.push({node: call, descriptor: `${name}() in up() destroys data`});
                } else if (inUp && name === 'addColumn' && schemaAddColumnNotNullNoDefault(call)) {
                    nullables.push({node: call, descriptor: 'addColumn() with notnull:true and no default'});
                }
            }
        }

        sqlStatements.sort(byPosition);
        let ddlIndex = 0;
        for (const statement of sqlStatements) {
            const descriptor = unguardedDdl(statement.sql);
            if (descriptor !== null) {
                facts.push(build({kind: 'migration.unguardedDdl', kindOf: 'statement', site: true, symbol: `ddl#${ddlIndex}`, range: rangeOf(statement.node), value: descriptor}));
                ddlIndex += 1;
            }
        }

        losses.sort(byPosition);
        losses.forEach((loss, index) => {
            facts.push(build({kind: 'migration.dataLoss', kindOf: 'statement', site: true, symbol: `loss#${index}`, range: rangeOf(loss.node), value: loss.descriptor}));
        });

        nullables.sort(byPosition);
        nullables.forEach((nullable, index) => {
            facts.push(build({kind: 'migration.nullableNoDefault', kindOf: 'statement', site: true, symbol: `nullable#${index}`, range: rangeOf(nullable.node), value: nullable.descriptor}));
        });

        const descriptor = migrationMissingDown(cls);
        if (descriptor !== null) {
            facts.push(build({kind: 'migration.noDown', kindOf: 'class', symbol: classSymbol(cls), identityKind: classKind(cls), range: rangeOf(cls), value: descriptor}));
        }
    }

    // Doctrine entities, both PHP 8 attributes (#[ORM\Entity]) and the older
    // annotation docblocks (@ORM\Entity). Attributes sit on the property node;
    // annotation docblocks sit on the enclosing propertystatement.
    for (const cls of collect(program, (node) => node.kind === 'class')) {
        if (!hasAttribute(cls, 'Entity') && !annotationPresent(leadingDoc(cls), 'Entity')) {
            continue;
        }

        let hasPrimaryKey = false;
        for (const statement of collect(cls, (node) => node.kind === 'propertystatement')) {
            const doc = leadingDoc(statement);
            const docHasId = annotationPresent(doc, 'Id');
            const docRelation = annotationEagerRelation(doc);
            for (const property of (statement.properties as PhpNode[] | undefined) ?? []) {
                const attributes = attributesOf(property);
                if (docHasId || attributes.some((attribute) => attributeShortName(attribute) === 'Id')) {
                    hasPrimaryKey = true;
                }
                const eager = attributes.find((attribute) => RELATION_ATTRIBUTES.has(attributeShortName(attribute)) && relationIsEager(attribute));
                const relation = eager !== undefined ? attributeShortName(eager) : docRelation;
                if (relation !== null) {
                    facts.push(build({kind: 'orm.eagerRelation', kindOf: 'statement', symbol: `${classSymbol(cls)}.${nodeName(property)}`, identityKind: classKind(cls), range: rangeOf(eager ?? statement), value: relation}));
                }
            }
        }

        // A subclass may inherit its key from a base entity/mapped superclass, so
        // only a standalone @Entity without any #[ORM\Id] property is reported.
        if (!isPhpNode(cls.extends) && !hasPrimaryKey) {
            facts.push(build({kind: 'orm.entityNoPrimaryKey', kindOf: 'class', symbol: classSymbol(cls), identityKind: classKind(cls), range: rangeOf(cls), value: 'entity has no primary key column'}));
        }
    }

    // Class model (identity spec, phase 4) — scheme 2 only: the type
    // identities it is keyed by are namespace-qualified from scheme 2 on.
    if (scheme !== 1) {
        facts.push(...classModelFacts(program, namespaces, classBindings, build));
    }

    return facts;
};

/** The file's `struct.typeDecl` / `struct.importBindings` facts (PhpMembers.ts): its named types under their identities. */
const classModelFacts = (program: PhpNode, namespaces: ReadonlyMap<PhpNode, string>, classBindings: StructImportBinding[], build: ReturnType<typeof factBuilder>): Fact[] => {
    const types = collect(program, (node) => TYPE_KINDS.has(node.kind) && node.isAnonymous !== true && nodeName(node) !== '(anonymous)');
    const typeSymbols = uniqueSymbols(types.map((node) => qualifiedName(namespaces.get(node) ?? '', [nodeName(node)])));
    const declared = collect(program, (node) => node.kind === 'namespace');
    const namespace = declared.length === 0 ? '' : declared.length === 1 ? namespaceName(declared[0] as PhpNode) : null;
    const bindings = classBindings.sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0) || (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
    return extractPhpMemberFacts(types.map((node, index) => ({node, symbol: typeSymbols[index] as string})), bindings, namespace, build);
};

const RELATION_ATTRIBUTES: ReadonlySet<string> = new Set(['OneToOne', 'OneToMany', 'ManyToOne', 'ManyToMany']);

// PHP 8 attributes attach to the `property` node (and the `class` node) as
// attrGroups, each holding attrs.
const attributesOf = (node: PhpNode): PhpNode[] => {
    const attributes: PhpNode[] = [];
    for (const group of (node.attrGroups as PhpNode[] | undefined) ?? []) {
        for (const attribute of (group.attrs as PhpNode[] | undefined) ?? []) {
            attributes.push(attribute);
        }
    }
    return attributes;
};

const attributeShortName = (attribute: PhpNode): string => {
    return typeof attribute.name === 'string' ? lastSegment(attribute.name) : '';
};

const hasAttribute = (node: PhpNode, shortName: string): boolean => {
    return attributesOf(node).some((attribute) => attributeShortName(attribute) === shortName);
};

// The docblock text of a node (glayzzle attaches it as leadingComments; a
// property's docblock sits on its propertystatement, not the property).
const leadingDoc = (node: PhpNode): string => {
    const comments = node.leadingComments as PhpNode[] | undefined;
    if (comments === undefined) {
        return '';
    }
    return comments.map((comment) => (typeof comment.value === 'string' ? comment.value : '')).join('\n');
};

// Short names of the @-annotations in a docblock (so @ORM\Entity and @Entity
// both match the short name 'Entity', mirroring the attribute short name).
const annotationShortNames = (doc: string): string[] => {
    return (doc.match(/@[A-Za-z_\\]+/g) ?? []).map((token) => lastSegment(token.slice(1)));
};

const annotationPresent = (doc: string, shortName: string): boolean => {
    return annotationShortNames(doc).includes(shortName);
};

// A relation annotation (@ORM\ManyToOne etc.) carrying fetch="EAGER" in the same
// docblock; returns the relation short name or null.
const annotationEagerRelation = (doc: string): string | null => {
    if (!/fetch\s*=\s*(?:["']EAGER["']|[\w\\]*::FETCH_EAGER)/i.test(doc)) {
        return null;
    }
    return annotationShortNames(doc).find((name) => RELATION_ATTRIBUTES.has(name)) ?? null;
};

// A Doctrine relation is eager when its `fetch` argument is 'EAGER' — either the
// string form (fetch: 'EAGER') or the constant form (fetch: …::FETCH_EAGER).
const relationIsEager = (attribute: PhpNode): boolean => {
    for (const argument of (attribute.args as PhpNode[] | undefined) ?? []) {
        if (!isPhpNode(argument) || argument.kind !== 'namedargument' || argument.name !== 'fetch') {
            continue;
        }
        if (isEagerValue(argument.value)) {
            return true;
        }
    }
    return false;
};

const isEagerValue = (value: unknown): boolean => {
    if (!isPhpNode(value)) {
        return false;
    }
    if (value.kind === 'string') {
        return value.value === 'EAGER';
    }
    if (value.kind === 'staticlookup') {
        const offset = value.offset;
        return isPhpNode(offset) && offset.name === 'FETCH_EAGER';
    }
    return false;
};

// A Doctrine migration class extends AbstractMigration.
const isDoctrineMigration = (node: PhpNode): boolean => {
    if (node.kind !== 'class') {
        return false;
    }
    const extended = node.extends;
    return isPhpNode(extended) && typeof extended.name === 'string' && lastSegment(extended.name) === 'AbstractMigration';
};

// The method name of an instance call ($obj->method(...)): addSql, dropTable, …
const callMethodName = (call: PhpNode): string | null => {
    const what = call.what;
    if (!isPhpNode(what) || what.kind !== 'propertylookup') {
        return null;
    }
    const offset = what.offset;
    return isPhpNode(offset) && typeof offset.name === 'string' ? offset.name : null;
};

const firstStringArgument = (call: PhpNode): string | null => {
    const first = (call.arguments as PhpNode[] | undefined)?.[0];
    if (isPhpNode(first) && first.kind === 'string' && typeof first.value === 'string') {
        return first.value;
    }
    return null;
};

// A Schema-API $table->addColumn(name, type, ['notnull' => true]) with no
// 'default' (and not auto-incrementing) — the DBAL equivalent of a raw NOT NULL
// add with no default. Only an explicit notnull:true counts (conservative).
const schemaAddColumnNotNullNoDefault = (call: PhpNode): boolean => {
    const options = (call.arguments as PhpNode[] | undefined)?.[2];
    if (!isPhpNode(options) || options.kind !== 'array') {
        return false;
    }
    let notNull = false;
    let hasDefault = false;
    let autoFilled = false;
    for (const item of (options.items as PhpNode[] | undefined) ?? []) {
        if (!isPhpNode(item) || item.kind !== 'entry') {
            continue;
        }
        const key = item.key;
        const keyName = isPhpNode(key) && typeof key.value === 'string' ? key.value : '';
        if (keyName === 'notnull') {
            notNull = isTrue(item.value);
        } else if (keyName === 'default') {
            hasDefault = true;
        } else if (keyName === 'autoincrement') {
            autoFilled = isTrue(item.value);
        }
    }
    return notNull && !hasDefault && !autoFilled;
};

const isTrue = (value: unknown): boolean => {
    return isPhpNode(value) && value.kind === 'boolean' && value.value === true;
};

// A migration is reversible only if its down() undoes something; a missing or
// empty down() is the concern (a throwing down() has statements and is left).
const migrationMissingDown = (cls: PhpNode): string | null => {
    const down = collect(cls, (node) => node.kind === 'method' && functionName(node) === 'down')[0];
    if (down === undefined) {
        return 'migration has no down() method';
    }
    const body = down.body as PhpNode | undefined;
    const children = (body?.children as PhpNode[] | undefined) ?? [];
    return children.length === 0 ? 'migration down() is empty' : null;
};

const nodeName = (node: PhpNode): string => {
    const name = node.name;
    if (isPhpNode(name) && typeof name.name === 'string') {
        return name.name;
    }
    return typeof name === 'string' ? name : '(anonymous)';
};

const byPosition = (a: {node: PhpNode}, b: {node: PhpNode}): number => {
    const left = a.node.loc?.start;
    const right = b.node.loc?.start;
    if (left === undefined || right === undefined) {
        return 0;
    }
    return left.line - right.line || left.column - right.column;
};

// PHP non-deterministic built-ins (clock / RNG / unique ids).
const NONDETERMINISTIC_PHP: ReadonlySet<string> = new Set([
    'time',
    'microtime',
    'date',
    'rand',
    'mt_rand',
    'random_int',
    'random_bytes',
    'uniqid'
]);

const usesNondeterminism = (body: PhpNode): boolean => {
    let found = false;
    const walk = (node: PhpNode): void => {
        for (const child of childNodes(node)) {
            if (FUNCTION_LIKE.has(child.kind)) {
                continue;
            }
            if (child.kind === 'call') {
                const what = child.what;
                if (isPhpNode(what) && what.kind === 'name' && typeof what.name === 'string') {
                    if (NONDETERMINISTIC_PHP.has(lastSegment(what.name))) {
                        found = true;
                    }
                }
            }
            walk(child);
        }
    };
    walk(body);
    return found;
};

/** A class `use` as an import binding (local alias → fully qualified name); none for `use function` / `use const`. */
const classBinding = (group: PhpNode, item: PhpNode, module: string): StructImportBinding[] => {
    if (useKindOf(group, item) !== 'class') {
        return [];
    }
    const fqn = module.replace(/^\\/u, '');
    return [{local: aliasName(item) ?? lastSegment(fqn), module: fqn, importedName: fqn, kind: 'named'}];
};

/** What a PHP `use` imports: a class-like name (class, interface, trait, enum, namespace), a function or a constant. */
type PhpUseKind = 'class' | 'function' | 'const';

const useKindOf = (group: PhpNode, item: PhpNode): PhpUseKind => {
    const kind = item.type ?? group.type;
    return kind === 'function' || kind === 'const' ? kind : 'class';
};

const qualifiedUseName = (group: PhpNode, item: PhpNode): string => {
    const name = String(item.name ?? '');
    const prefix = typeof group.name === 'string' && group.name.length > 0 ? group.name : null;
    return prefix === null ? name : `${prefix.replace(/\\+$/u, '')}\\${name}`;
};

const aliasName = (item: PhpNode): string | null => {
    const alias = item.alias;
    if (typeof alias === 'string') {
        return alias;
    }
    if (isPhpNode(alias) && typeof alias.name === 'string') {
        return alias.name;
    }
    return null;
};

const lastSegment = (fqn: string): string => {
    const parts = fqn.split('\\');
    return parts[parts.length - 1] ?? fqn;
};

const computeMetrics = (fn: PhpNode, body: PhpNode): FunctionMetrics => {
    const state: MetricState = {cyclomatic: 1, cognitive: 0, maxNesting: 0};
    visit(body, 0, state);

    const loc = fn.loc;
    const lineCountForFn = loc === undefined ? 1 : loc.end.line - loc.start.line + 1;
    const args = fn.arguments as unknown[] | undefined;

    return {
        cyclomatic: state.cyclomatic,
        cognitive: state.cognitive,
        nestingDepth: state.maxNesting,
        parameterCount: args?.length ?? 0,
        lineCount: lineCountForFn
    };
};

/**
 * An `elseif` / `else if`: the `if` that is the `alternate` of another `if`
 * continues that chain — one flat cognitive increment, no extra nesting level
 * (SonarSource cognitive complexity), as in the TypeScript adapter.
 */
const isElseIf = (child: PhpNode, parent: PhpNode): boolean => child.kind === 'if' && parent.kind === 'if' && parent.alternate === child;

/** Whether `child` opens a nesting level: a nesting structure that is not an else-if. */
const nestsDeeper = (child: PhpNode, parent: PhpNode): boolean => NESTING_KINDS.has(child.kind) && !isElseIf(child, parent);

/** The cognitive increment of the structure `child` itself at `nesting`: 1 + nesting when it nests, 1 for an else-if, else 0. */
const structureIncrement = (child: PhpNode, parent: PhpNode, nesting: number): number => {
    if (isElseIf(child, parent)) {
        return 1;
    }
    return NESTING_KINDS.has(child.kind) ? 1 + nesting : 0;
};

const visit = (node: PhpNode, nesting: number, state: MetricState): void => {
    for (const child of childNodes(node)) {
        if (FUNCTION_LIKE.has(child.kind)) {
            continue;
        }

        if (CYCLOMATIC_KINDS.has(child.kind)) {
            state.cyclomatic += 1;
        }
        if (child.kind === 'bin' && typeof child.type === 'string' && LOGICAL_TYPES.has(child.type)) {
            state.cyclomatic += 1;
            state.cognitive += 1;
        }

        state.cognitive += structureIncrement(child, node, nesting);
        const childNesting = nestsDeeper(child, node) ? nesting + 1 : nesting;
        if (childNesting > state.maxNesting) {
            state.maxNesting = childNesting;
        }

        visit(child, childNesting, state);
    }
};

// A catch whose bound `$e` is READ in the block (`$last = $e`, passed,
// returned) hands the error on rather than swallowing it; the target of a plain
// `$e = …` assignment is a write, not a read. Mirrors the TypeScript adapter.
const catchReadsError = (clause: PhpNode): boolean => {
    const variable = clause.variable as PhpNode | undefined;
    const body = clause.body as PhpNode | undefined;
    const name = variable?.name;
    if (body === undefined || typeof name !== 'string') {
        return false;
    }
    const writes = new Set(collect(body, (node) => node.kind === 'assign' && node.operator === '=').map((assign) => assign.left));
    return exists(body, (node) => node.kind === 'variable' && node.name === name && !writes.has(node));
};

const exists = (root: PhpNode, predicate: (node: PhpNode) => boolean): boolean => {
    return collect(root, predicate).length > 0;
};

const TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'trait', 'interface', 'enum']);

/** A namespace's name (`App\\Service`); `''` for the global `namespace {}`. */
const namespaceName = (node: PhpNode): string => (typeof node.name === 'string' ? node.name : '');

/** Scope segments joined by `.`, behind the namespace and a `\\` when there is one. */
const qualifiedName = (namespace: string, segments: readonly string[]): string => `${namespace.length > 0 ? `${namespace}\\` : ''}${segments.join('.')}`;

/** Every class, trait, interface and enum with the namespace it is declared in (`''` outside one or under scheme 1). */
const typeNamespaces = (program: PhpNode, scheme: IdentityScheme): Map<PhpNode, string> => {
    const found = new Map<PhpNode, string>();
    const walk = (node: PhpNode, namespace: string): void => {
        const inner = node.kind === 'namespace' && scheme !== 1 ? namespaceName(node) : namespace;
        if (TYPE_KINDS.has(node.kind)) {
            found.set(node, namespace);
        }
        for (const child of childNodes(node)) {
            walk(child, inner);
        }
    };
    walk(program, '');
    return found;
};

/**
 * Every function-like node in source order (the same order as `collect`)
 * with its identity base: the name qualified by the enclosing class, trait,
 * interface or enum and by the enclosing named function or method
 * (`Service.run`, `Service.run.helper`), so two classes' `run` in one file no
 * longer share a symbol. A closure assigned to a variable takes its name
 * (`$handler = function () {}` → `handler`), a closure inside another value
 * assigned to a variable lives in that variable's scope; any other closure is
 * `<scope>.(anonymous)`, numbered within that scope (`declarationSymbols`) —
 * never by its line. Under identity scheme 2 the namespace leads, PHP-style
 * (`App\Service.run`), so one file's two namespaces no longer share a
 * symbol; scheme 1 left it out.
 */
const qualifiedFunctions = (program: PhpNode, scheme: IdentityScheme): {fn: PhpNode; base: DeclarationBase}[] => {
    const found: {fn: PhpNode; base: DeclarationBase}[] = [];
    const bound = new Map<PhpNode, string>();
    const walk = (node: PhpNode, scopes: readonly string[], namespace: string): void => {
        let inner = scopes;
        let innerNamespace = namespace;
        const assignment = variableAssignment(node);
        if (assignment !== undefined) {
            if (FUNCTION_LIKE.has(assignment.right.kind)) {
                bound.set(assignment.right, assignment.name);
            } else {
                // `$rows = array_map(function () {…}, …)`: the closure lives in `rows`.
                walk(assignment.left, scopes, namespace);
                walk(assignment.right, [...scopes, assignment.name], namespace);
                return;
            }
        }
        if (FUNCTION_LIKE.has(node.kind)) {
            const own = functionName(node) ?? bound.get(node);
            found.push({fn: node, base: {base: qualifiedName(namespace, [...scopes, own ?? '(anonymous)']), anonymous: own === undefined}});
            inner = own === undefined ? scopes : [...scopes, own];
        } else if (TYPE_KINDS.has(node.kind) && nodeName(node) !== '(anonymous)') {
            inner = [...scopes, nodeName(node)];
        } else if (node.kind === 'namespace' && scheme !== 1) {
            innerNamespace = namespaceName(node);
        }
        for (const child of childNodes(node)) {
            walk(child, inner, innerNamespace);
        }
    };
    walk(program, [], '');
    return found;
};

/** `$name = <right>`: the variable, its name and the assigned expression; undefined for any other node. */
const variableAssignment = (node: PhpNode): {left: PhpNode; name: string; right: PhpNode} | undefined => {
    const left = node.kind === 'assign' ? (node.left as PhpNode | undefined) : undefined;
    const right = node.right as PhpNode | undefined;
    return right !== undefined && left?.kind === 'variable' && typeof left.name === 'string' ? {left, name: left.name, right} : undefined;
};

/** A function's or method's own name; `undefined` for a closure or arrow function. */
const functionName = (fn: PhpNode): string | undefined => {
    const name = fn.name;
    if (typeof name === 'string' && name.length > 0) {
        return name;
    }
    if (isPhpNode(name) && typeof name.name === 'string') {
        return name.name;
    }
    return undefined;
};

const fileRange = (lines: string[]): SourceRange => {
    return {startLine: 1, startCol: 0, endLine: Math.max(lines.length, 1), endCol: 0};
};

const lineCount = (content: string): number => {
    if (content.length === 0) {
        return 0;
    }
    return content.split('\n').length;
};

// Scans the comment block immediately above a function for the opt-out marker.
const leadingHasMarker = (lines: string[], startLine: number): boolean => {
    for (let index = startLine - 2; index >= 0; index -= 1) {
        const text = (lines[index] ?? '').trim();
        if (text.length === 0) {
            continue;
        }
        const isComment =
            text.startsWith('//') || text.startsWith('#') || text.startsWith('*') || text.startsWith('/*') || text.endsWith('*/');
        if (!isComment) {
            return false;
        }
        if (text.includes(RATIONALE_MARKER)) {
            return true;
        }
    }
    return false;
};
