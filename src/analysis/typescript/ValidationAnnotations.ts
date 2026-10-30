import {Node, SyntaxKind} from 'ts-morph';
import type {Expression, SourceFile, VariableStatement} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import type {NormalizationKind} from '../../contracts/ValidationContract.js';

type Build = (spec: FactSpec) => Fact;

/**
 * The conditions Stoa could determine about an annotated scalar Zod schema.
 * `required`/`nullable` default true/false respectively (Zod's own defaults)
 * when no `.optional()`/`.nullable()` modifier is present. `minExclusive`
 * distinguishes `.positive()` (value > min, strict) from a plain `.min()` or
 * `.nonnegative()` (value >= min); absent/false means inclusive.
 */
export interface ResolvedConditions {
    dataType: 'number' | 'string' | 'boolean';
    required: boolean;
    nullable: boolean;
    min?: number;
    max?: number;
    minExclusive?: boolean;
    integer?: boolean;
    /** @deprecated kept for backward compatibility — the first entry of `formats`. Comparisons should read `formats`, which holds every distinct format modifier in the chain (Zod ANDs them, same as multiple `.min()`/`.max()` sources). */
    format?: 'email' | 'url';
    formats?: Array<'email' | 'url'>;
    allowedValues?: string[];
    normalization: NormalizationKind[];
}

/** One `// stoa:validation <ID>` annotation, its declared identifier (if the
 *  statement declares exactly one `const x = …`), and whatever Stoa could
 *  resolve about the annotated expression. Shared by the fact extractor and
 *  the Validation Trace ID usage tracer (ValidatorUsage.ts) so both work from
 *  the same single comment/shape scan. */
export interface AnnotatedSchema {
    statement: VariableStatement;
    rawId: string;
    idValid: boolean;
    schemaName: string | null;
    conditions: ResolvedConditions | null;
    /** Set only for a bare `z.object({...})` (no chained modifiers): each
     *  property's own value resolved the same way a top-level scalar chain
     *  would be, independent of `conditions` (which stays null for any object
     *  schema — object shapes are not scalar chains). `null` for a field
     *  whose own value is not resolvable (e.g. `.refine()`); the field is
     *  simply absent from the map if the property is a spread/shorthand/
     *  computed/method property (not a plain `name: <expr>` assignment). */
    objectFields?: Record<string, ResolvedConditions | null>;
}

// `// stoa:validation <ID>` — the annotation references a Validation Trace ID;
// it does NOT assert that the referenced business rule is correctly implemented
// (see schemas/validation-contract.schema.json and docs/*/implementation-status.md).
const ANNOTATION_RE = /stoa:validation\s+(\S+)/;
// The same ID-format regex as the contract schema's `id` pattern, duplicated
// here (not imported) because this module must stay usable without a loaded
// contract — an annotation's ID shape is checkable on its own.
const ID_FORMAT_RE = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+-[0-9]{3}$/;

const BASE_ZOD_TYPES: ReadonlySet<string> = new Set(['number', 'string', 'boolean']);
const NORMALIZATION_MODIFIERS: ReadonlyMap<string, NormalizationKind> = new Map([
    ['trim', 'trim'],
    ['tolowercase', 'lowercase'],
    ['touppercase', 'uppercase']
]);
const FORMAT_MODIFIERS: ReadonlyMap<string, 'email' | 'url'> = new Map([
    ['email', 'email'],
    ['url', 'url']
]);

/**
 * Emits one `validation.contractAnnotation` fact per `// stoa:validation <ID>`
 * leading comment found on a `const x = …` statement.
 *
 * Deliberately narrow (first vertical slice, TypeScript only): only a direct
 * Zod scalar chain rooted at `z.number()`/`z.string()`/`z.boolean()`/
 * `z.enum([...])` is resolved, with `.int()`, `.positive()`, `.nonnegative()`,
 * `.email()`, `.url()`, `.min()`, `.max()`, `.optional()`, `.nullable()` and
 * the normalization modifiers each given an explicit, modeled effect on
 * `ResolvedConditions` — none is treated as a meaningless no-op. `z.object(…)`,
 * array schemas, a vts schema, or any chained call Stoa does not recognize
 * (`.refine()`, `.transform()`, `.default()`, …) is reported as present but
 * UNRESOLVED (`resolved: false` in the fact value), never guessed at —
 * matching code in other languages, or validation expressed any other way, is
 * a documented gap, not a silent false "no annotation found".
 */
export const extractValidationAnnotations = (sourceFile: SourceFile, build: Build): Fact[] => {
    const facts: Fact[] = [];
    let index = 0;
    for (const schema of annotatedSchemas(sourceFile)) {
        const value: Record<string, unknown> = {id: schema.rawId, idValid: schema.idValid, resolved: schema.conditions !== null};
        if (schema.conditions !== null) {
            value.conditions = schema.conditions;
        }
        if (schema.objectFields !== undefined) {
            value.objectFields = schema.objectFields;
        }
        facts.push(build({
            kind: 'validation.contractAnnotation',
            kindOf: 'statement',
            symbol: `annotation#${index}`,
            range: rangeOf(sourceFile, schema.statement),
            value,
            certainty: 'syntactic'
        }));
        index += 1;
    }
    return facts;
};

/**
 * Every `// stoa:validation <ID>` annotation found in `sourceFile`, with its
 * declared identifier (for a single `const x = …` statement) and whatever
 * Stoa could resolve about the annotated expression's conditions. Exported so
 * the fact extractor above and the usage tracer (ValidatorUsage.ts) share one
 * comment/shape scan instead of each re-parsing the file.
 */
export const annotatedSchemas = (sourceFile: SourceFile): AnnotatedSchema[] => {
    const schemas: AnnotatedSchema[] = [];
    for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement)) {
        const rawId = annotationId(statement);
        if (rawId === null) {
            continue;
        }
        const declaration = statement.getDeclarationList().getDeclarations()[0];
        const nameNode = declaration?.getNameNode();
        const schemaName = nameNode !== undefined && Node.isIdentifier(nameNode) ? nameNode.getText() : null;
        const initializer = declaration?.getInitializer();
        const conditions = initializer === undefined ? null : resolveZodConditions(initializer);
        const objectFields = initializer === undefined ? null : resolveZodObjectShape(initializer);
        schemas.push({
            statement,
            rawId,
            idValid: ID_FORMAT_RE.test(rawId),
            schemaName,
            conditions,
            ...(objectFields !== null ? {objectFields} : {})
        });
    }
    return schemas;
};

const annotationId = (statement: Node): string | null => {
    for (const comment of statement.getLeadingCommentRanges()) {
        const match = ANNOTATION_RE.exec(comment.getText());
        if (match?.[1] !== undefined) {
            return match[1];
        }
    }
    return null;
};

// Walks a Zod call chain outside-in, collecting each `.method(args)` link down
// to a recognized base: `z.number()`/`z.string()`/`z.boolean()`, or
// `z.enum([...literal strings...])` (dataType 'string' with allowedValues).
// Returns null the moment a link or the base is not a recognized shape.
const resolveZodConditions = (expression: Expression): ResolvedConditions | null => {
    const links: Array<{name: string; args: Node[]}> = [];
    let current: Node = expression;

    while (true) {
        if (!Node.isCallExpression(current)) {
            return null;
        }
        const callee = current.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) {
            return null;
        }
        const name = callee.getName();
        const object = callee.getExpression();
        if (Node.isIdentifier(object) && object.getText() === 'z') {
            if (BASE_ZOD_TYPES.has(name)) {
                return applyModifiers(name as 'number' | 'string' | 'boolean', links, {});
            }
            if (name === 'enum') {
                const allowedValues = stringArrayLiteral(current.getArguments()[0]);
                return allowedValues === null ? null : applyModifiers('string', links, {allowedValues});
            }
            // z.object(...), z.array(...), z.date(), … — not a base this slice
            // resolves; never guessed at.
            return null;
        }
        links.unshift({name, args: current.getArguments()});
        current = object;
    }
};

// A bare `z.object({...})` — no chained modifiers after it (`.strict()`,
// `.partial()`, … are a documented limit, not guessed at: any call OTHER
// than `z.object(...)` itself returns null here). Each property whose value
// is a plain `name: <expr>` assignment (not a spread, shorthand or computed
// name) is resolved via the SAME scalar-chain resolver as a top-level
// annotation — a field is simply absent from the returned map if its
// property shape isn't a plain assignment, and `null` if its value IS a
// plain assignment but the value itself doesn't resolve (e.g. `.refine()`).
// This is the field-by-field counterpart of `resolveZodConditions`: Stoa can
// now compare ONE field of a `z.object(...)` request-body schema against a
// contract rule naming that field, without resolving (or guessing at) the
// rest of the object's shape.
const resolveZodObjectShape = (expression: Expression): Record<string, ResolvedConditions | null> | null => {
    if (!Node.isCallExpression(expression)) {
        return null;
    }
    const callee = expression.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'object') {
        return null;
    }
    const object = callee.getExpression();
    if (!Node.isIdentifier(object) || object.getText() !== 'z') {
        return null;
    }
    const shape = expression.getArguments()[0];
    if (shape === undefined || !Node.isObjectLiteralExpression(shape)) {
        return null;
    }
    // A null-prototype object, not `{}`: a Zod schema field literally named
    // `__proto__` (unusual, but syntactically valid via a string-literal
    // property name) would otherwise be silently swallowed — `fields.__proto__
    // = resolved` on a normal object invokes Object.prototype's `__proto__`
    // SETTER (changing the object's own prototype) instead of creating an
    // own property, so the field's resolved conditions would vanish rather
    // than being stored. With no inherited `__proto__` accessor, this is
    // just a normal property assignment like any other key.
    const fields: Record<string, ResolvedConditions | null> = Object.create(null) as Record<string, ResolvedConditions | null>;
    for (const property of shape.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }
        const nameNode = property.getNameNode();
        const fieldName = Node.isIdentifier(nameNode) ? nameNode.getText() : Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : null;
        if (fieldName === null) {
            continue;
        }
        const fieldInitializer = property.getInitializer();
        fields[fieldName] = fieldInitializer === undefined ? null : resolveZodConditions(fieldInitializer);
    }
    return fields;
};

// `['admin', 'user']` — a literal array of string literals only; anything else
// (a spread, a computed element, a non-string literal) is not resolvable.
const stringArrayLiteral = (node: Node | undefined): string[] | null => {
    if (node === undefined || !Node.isArrayLiteralExpression(node)) {
        return null;
    }
    const values: string[] = [];
    for (const element of node.getElements()) {
        if (!Node.isStringLiteral(element)) {
            return null;
        }
        values.push(element.getLiteralValue());
    }
    return values.length > 0 ? values : null;
};

interface Bound {
    value: number;
    exclusive: boolean;
}

// The most restrictive of two lower bounds, independent of chain order: the
// larger value wins; if equal, the exclusive (strict >) one wins. Models
// `.positive()` (equivalent to `.min(0)` exclusive), `.nonnegative()`
// (`.min(0)` inclusive) and an explicit `.min(n)` as three possible sources
// for the same bound, the way Zod itself ANDs every check together, rather
// than letting whichever modifier happens to appear last in the chain win.
const tightenMin = (current: Bound | undefined, candidate: Bound): Bound => {
    if (current === undefined || candidate.value > current.value) {
        return candidate;
    }
    if (candidate.value < current.value) {
        return current;
    }
    return {value: current.value, exclusive: current.exclusive || candidate.exclusive};
};

// The mirror of tightenMin for the upper bound: the smallest `.max(n)` across
// however many calls are chained wins, independent of order (`.max(100).max(5)`
// and `.max(5).max(100)` must resolve identically). This slice has only one
// source of an upper bound (`.max()` itself — no `.negative()`/`.lt()`
// equivalent is modeled), so exclusivity never actually varies here; the shape
// is kept symmetric with `Bound`/`tightenMin` rather than collapsing to a bare
// number, so a future exclusive-max source slots in without reshaping this.
const tightenMax = (current: Bound | undefined, candidate: Bound): Bound => {
    if (current === undefined || candidate.value < current.value) {
        return candidate;
    }
    if (candidate.value > current.value) {
        return current;
    }
    return {value: current.value, exclusive: current.exclusive || candidate.exclusive};
};

const applyModifiers = (dataType: 'number' | 'string' | 'boolean', links: ReadonlyArray<{name: string; args: Node[]}>, seed: Partial<ResolvedConditions>): ResolvedConditions | null => {
    const conditions: ResolvedConditions = {dataType, required: true, nullable: false, normalization: [], ...seed};
    let min: Bound | undefined;
    let max: Bound | undefined;
    const formats: Array<'email' | 'url'> = [];
    for (const link of links) {
        const lower = link.name.toLowerCase();
        if (lower === 'optional') {
            conditions.required = false;
            continue;
        }
        if (lower === 'nullable') {
            conditions.nullable = true;
            continue;
        }
        if (lower === 'int') {
            conditions.integer = true;
            continue;
        }
        const format = FORMAT_MODIFIERS.get(lower);
        if (format !== undefined) {
            // Zod ANDs every chained check together, so `.email().url()` does not
            // mean "url wins" — it means the value must satisfy BOTH. Every
            // distinct format is kept (not overwritten) so a contract comparison
            // can see the full set; duplicates of the same format collapse.
            if (!formats.includes(format)) {
                formats.push(format);
            }
            continue;
        }
        const normalization = NORMALIZATION_MODIFIERS.get(lower);
        if (normalization !== undefined) {
            conditions.normalization.push(normalization);
            continue;
        }
        if (lower === 'positive') {
            min = tightenMin(min, {value: 0, exclusive: true});
            continue;
        }
        if (lower === 'nonnegative') {
            min = tightenMin(min, {value: 0, exclusive: false});
            continue;
        }
        if (lower === 'min') {
            const literal = link.args[0];
            if (literal === undefined || !Node.isNumericLiteral(literal)) {
                return null;
            }
            min = tightenMin(min, {value: Number(literal.getText()), exclusive: false});
            continue;
        }
        if (lower === 'max') {
            const literal = link.args[0];
            if (literal === undefined || !Node.isNumericLiteral(literal)) {
                return null;
            }
            // Multiple .max() calls AND together like multiple .min() sources:
            // the smallest value wins regardless of chain order.
            max = tightenMax(max, {value: Number(literal.getText()), exclusive: false});
            continue;
        }
        // An unrecognized modifier (.refine(), .transform(), .default(), …):
        // its effect on the actual accepted values is not something Stoa can
        // verify, so the whole schema is unresolved rather than partially
        // (and perhaps wrongly) described. Validation-relevant modifiers must
        // never be silently treated as no-ops.
        return null;
    }
    if (min !== undefined) {
        conditions.min = min.value;
        conditions.minExclusive = min.exclusive;
    }
    if (max !== undefined) {
        conditions.max = max.value;
    }
    if (min !== undefined && max !== undefined) {
        // A genuinely impossible range (e.g. .min(10).max(5), or .positive().max(0))
        // is a contradictory schema, not a resolvable one: no value can satisfy
        // both bounds. Reported as unresolved rather than silently picking one
        // bound and hiding the conflict — the same "don't guess" convention as
        // an unrecognized modifier, just discovered after merging instead of
        // per-link.
        const impossible = min.exclusive ? min.value >= max.value : min.value > max.value;
        if (impossible) {
            return null;
        }
    }
    const [firstFormat] = formats;
    if (firstFormat !== undefined) {
        conditions.formats = formats;
        conditions.format = firstFormat;
    }
    return conditions;
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};
