import type {Fact, SourceRange, SubjectKind} from '../../Types.js';
import {factBuilder, type AdapterInfo} from '../FactBuilder.js';
import {isDeepImport} from '../ImportPath.js';
import {destructiveDdl, nullableNoDefault, unguardedDdl} from '../MigrationSql.js';

/**
 * Minimal structural view of a glayzzle php-parser node. We keep this local and
 * permissive rather than depending on the parser's full AST typings.
 */
export interface PhpNode {
    kind: string;
    loc?: {start: {line: number; column: number}; end: {line: number; column: number}};
    [key: string]: unknown;
}

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
    const facts: Fact[] = [];
    const build = factBuilder(info, filePath);
    const lines = content.split('\n');

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(lines), value: lineCount(content)}));

    for (const fn of collect(program, (node) => FUNCTION_LIKE.has(node.kind))) {
        const body = fn.body as PhpNode | undefined;
        if (body === undefined) {
            continue;
        }

        const metrics = computeMetrics(fn, body);
        const symbol = functionName(fn);
        const kindOf: SubjectKind = fn.kind === 'method' ? 'method' : 'function';
        const range = rangeOf(fn);

        facts.push(build({kind: 'metric.cyclomaticComplexity', kindOf, symbol, range, value: metrics.cyclomatic}));
        facts.push(build({kind: 'metric.cognitiveComplexity', kindOf, symbol, range, value: metrics.cognitive}));
        facts.push(build({kind: 'metric.nestingDepth', kindOf, symbol, range, value: metrics.nestingDepth}));
        facts.push(build({kind: 'metric.parameterCount', kindOf, symbol, range, value: metrics.parameterCount}));
        facts.push(build({kind: 'metric.functionLength', kindOf, symbol, range, value: metrics.lineCount}));
        facts.push(build({kind: 'doc.hasComplexityRationale', kindOf, symbol, range, value: leadingHasMarker(lines, range.startLine)}));
        facts.push(build({kind: 'ast.usesNondeterminism', kindOf, symbol, range, value: usesNondeterminism(body)}));
    }

    collect(program, (node) => node.kind === 'catch').forEach((clause, index) => {
        const body = clause.body as PhpNode | undefined;
        const children = (body?.children as PhpNode[] | undefined) ?? [];
        const empty = children.length === 0;
        const hasThrow = children.length > 0 && exists(body as PhpNode, (node) => node.kind === 'throw');
        const hasCall = children.length > 0 && exists(body as PhpNode, (node) => node.kind === 'call');
        const symbol = `catch#${index}`;

        facts.push(build({kind: 'ast.emptyCatch', kindOf: 'catch-clause', symbol, range: rangeOf(clause), value: empty}));
        facts.push(
            build({
                kind: 'ast.catchSwallowsError',
                kindOf: 'catch-clause',
                symbol,
                range: rangeOf(clause),
                value: !hasThrow && !hasCall
            })
        );
    });

    const referenced = referencedShortNames(program);
    let importIndex = 0;
    for (const group of collect(program, (node) => node.kind === 'usegroup')) {
        for (const item of (group.items as PhpNode[] | undefined) ?? []) {
            const module = String(item.name ?? '');
            const symbol = `import#${importIndex}`;
            facts.push(build({kind: 'deps.import', kindOf: 'import', symbol, range: rangeOf(group), value: {module, isTypeOnly: false}}));

            const local = aliasName(item) ?? lastSegment(module);
            if (local.length > 0 && !referenced.has(local)) {
                facts.push(build({kind: 'deps.importUnused', kindOf: 'import', symbol, range: rangeOf(group), value: module}));
            }
            if (isDeepImport(module, '\\')) {
                facts.push(build({kind: 'deps.importDeep', kindOf: 'import', symbol, range: rangeOf(group), value: module}));
            }
            importIndex += 1;
        }
    }

    for (const cls of collect(program, isDoctrineMigration)) {
        // Collect every addSql('...') literal with the method it sits in, in
        // document order, so the same migration rules fire for Doctrine as for
        // TypeORM (shared SQL checks in MigrationSql).
        const statements: {sql: string; node: PhpNode; method: string}[] = [];
        for (const method of collect(cls, (node) => node.kind === 'method')) {
            const name = functionName(method);
            for (const call of collect(method, isAddSqlCall)) {
                const sql = addSqlArgument(call);
                if (sql !== null) {
                    statements.push({sql, node: call, method: name});
                }
            }
        }
        statements.sort(byPosition);

        let ddlIndex = 0;
        for (const statement of statements) {
            const descriptor = unguardedDdl(statement.sql);
            if (descriptor !== null) {
                facts.push(build({kind: 'migration.unguardedDdl', kindOf: 'statement', symbol: `ddl#${ddlIndex}`, range: rangeOf(statement.node), value: descriptor}));
                ddlIndex += 1;
            }
        }

        let lossIndex = 0;
        for (const statement of statements) {
            if (statement.method !== 'up') {
                continue;
            }
            const descriptor = destructiveDdl(statement.sql);
            if (descriptor !== null) {
                facts.push(build({kind: 'migration.dataLoss', kindOf: 'statement', symbol: `loss#${lossIndex}`, range: rangeOf(statement.node), value: descriptor}));
                lossIndex += 1;
            }
        }

        let nullableIndex = 0;
        for (const statement of statements) {
            if (statement.method !== 'up') {
                continue;
            }
            const descriptor = nullableNoDefault(statement.sql);
            if (descriptor !== null) {
                facts.push(build({kind: 'migration.nullableNoDefault', kindOf: 'statement', symbol: `nullable#${nullableIndex}`, range: rangeOf(statement.node), value: descriptor}));
                nullableIndex += 1;
            }
        }

        const descriptor = migrationMissingDown(cls);
        if (descriptor !== null) {
            facts.push(build({kind: 'migration.noDown', kindOf: 'class', symbol: nodeName(cls), range: rangeOf(cls), value: descriptor}));
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
                    facts.push(build({kind: 'orm.eagerRelation', kindOf: 'statement', symbol: nodeName(property), range: rangeOf(eager ?? statement), value: relation}));
                }
            }
        }

        // A subclass may inherit its key from a base entity/mapped superclass, so
        // only a standalone @Entity without any #[ORM\Id] property is reported.
        if (!isPhpNode(cls.extends) && !hasPrimaryKey) {
            facts.push(build({kind: 'orm.entityNoPrimaryKey', kindOf: 'class', symbol: nodeName(cls), range: rangeOf(cls), value: 'entity has no primary key column'}));
        }
    }

    return facts;
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
    if (!/fetch\s*=\s*["']EAGER["']/i.test(doc)) {
        return null;
    }
    return annotationShortNames(doc).find((name) => RELATION_ATTRIBUTES.has(name)) ?? null;
};

// A Doctrine relation is eager when it carries a `fetch: 'EAGER'` argument.
const relationIsEager = (attribute: PhpNode): boolean => {
    for (const argument of (attribute.args as PhpNode[] | undefined) ?? []) {
        if (!isPhpNode(argument) || argument.kind !== 'namedargument' || argument.name !== 'fetch') {
            continue;
        }
        const value = argument.value;
        if (isPhpNode(value) && value.kind === 'string' && value.value === 'EAGER') {
            return true;
        }
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

const isAddSqlCall = (node: PhpNode): boolean => {
    if (node.kind !== 'call') {
        return false;
    }
    const what = node.what;
    if (!isPhpNode(what) || what.kind !== 'propertylookup') {
        return false;
    }
    const offset = what.offset;
    return isPhpNode(offset) && offset.name === 'addSql';
};

const addSqlArgument = (call: PhpNode): string | null => {
    const first = (call.arguments as PhpNode[] | undefined)?.[0];
    if (isPhpNode(first) && first.kind === 'string' && typeof first.value === 'string') {
        return first.value;
    }
    return null;
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

const referencedShortNames = (program: PhpNode): Set<string> => {
    const names = new Set<string>();
    for (const node of collect(program, (candidate) => candidate.kind === 'name')) {
        if (typeof node.name === 'string') {
            names.add(lastSegment(node.name));
        }
    }
    return names;
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

        const isNesting = NESTING_KINDS.has(child.kind);
        if (isNesting) {
            state.cognitive += 1 + nesting;
        }

        const childNesting = isNesting ? nesting + 1 : nesting;
        if (childNesting > state.maxNesting) {
            state.maxNesting = childNesting;
        }

        visit(child, childNesting, state);
    }
};

const isPhpNode = (value: unknown): value is PhpNode => {
    return typeof value === 'object' && value !== null && typeof (value as PhpNode).kind === 'string';
};

const childNodes = (node: PhpNode): PhpNode[] => {
    const children: PhpNode[] = [];
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') {
            continue;
        }
        if (isPhpNode(value)) {
            children.push(value);
        } else if (Array.isArray(value)) {
            for (const entry of value) {
                if (isPhpNode(entry)) {
                    children.push(entry);
                }
            }
        }
    }
    return children;
};

const collect = (root: PhpNode, predicate: (node: PhpNode) => boolean): PhpNode[] => {
    const found: PhpNode[] = [];
    const walk = (node: PhpNode): void => {
        if (predicate(node)) {
            found.push(node);
        }
        for (const child of childNodes(node)) {
            walk(child);
        }
    };
    walk(root);
    return found;
};

const exists = (root: PhpNode, predicate: (node: PhpNode) => boolean): boolean => {
    return collect(root, predicate).length > 0;
};

const functionName = (fn: PhpNode): string => {
    const name = fn.name;
    if (typeof name === 'string' && name.length > 0) {
        return name;
    }
    if (isPhpNode(name) && typeof name.name === 'string') {
        return name.name;
    }
    return `anonymous@${fn.loc?.start.line ?? 0}`;
};

const rangeOf = (node: PhpNode): SourceRange => {
    const loc = node.loc;
    if (loc === undefined) {
        return {startLine: 1, startCol: 0, endLine: 1, endCol: 0};
    }
    return {startLine: loc.start.line, startCol: loc.start.column, endLine: loc.end.line, endCol: loc.end.column};
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
