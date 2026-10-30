import {Node, SyntaxKind} from 'ts-morph';
import type {Expression, SourceFile, VariableStatement} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import type {NormalizationKind} from '../../contracts/ValidationContract.js';

type Build = (spec: FactSpec) => Fact;

/**
 * The conditions Stoa could determine about an annotated scalar Zod schema.
 * `required`/`nullable` default true/false respectively (Zod's own defaults)
 * when no `.optional()`/`.nullable()` modifier is present.
 */
export interface ResolvedConditions {
    dataType: 'number' | 'string' | 'boolean';
    required: boolean;
    nullable: boolean;
    min?: number;
    max?: number;
    normalization: NormalizationKind[];
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
// Modifiers whose effect on the extracted conditions Stoa does not need to
// track (the base dataType already covers them, or they narrow within a type
// Stoa does not model further, e.g. positive/nonnegative). Any OTHER chained
// call (.refine(), .transform(), .default(), …) makes the schema unresolved —
// Stoa never guesses at an effect it cannot verify from the call itself.
const NO_OP_MODIFIERS: ReadonlySet<string> = new Set(['int', 'email', 'url', 'positive', 'nonnegative']);
const NORMALIZATION_MODIFIERS: ReadonlyMap<string, NormalizationKind> = new Map([
    ['trim', 'trim'],
    ['tolowercase', 'lowercase'],
    ['touppercase', 'uppercase']
]);

/**
 * Emits one `validation.contractAnnotation` fact per `// stoa:validation <ID>`
 * leading comment found on a `const x = …` statement.
 *
 * Deliberately narrow (first vertical slice, TypeScript only): only a direct
 * Zod scalar chain rooted at `z.number()`/`z.string()`/`z.boolean()` is
 * resolved. `z.object(…)`, array schemas, a vts schema, or any chained call
 * Stoa does not recognize is reported as present but UNRESOLVED
 * (`resolved: false` in the fact value), never guessed at — matching code in
 * other languages, or validation expressed any other way, is a documented gap,
 * not a silent false "no annotation found".
 */
export const extractValidationAnnotations = (sourceFile: SourceFile, build: Build): Fact[] => {
    const facts: Fact[] = [];
    let index = 0;
    for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement)) {
        const rawId = annotationId(statement);
        if (rawId === null) {
            continue;
        }
        const idValid = ID_FORMAT_RE.test(rawId);
        const initializer = firstInitializer(statement);
        const conditions = initializer === undefined ? null : resolveZodConditions(initializer);
        const value: Record<string, unknown> = {id: rawId, idValid, resolved: conditions !== null};
        if (conditions !== null) {
            value.conditions = conditions;
        }
        facts.push(build({
            kind: 'validation.contractAnnotation',
            kindOf: 'statement',
            symbol: `annotation#${index}`,
            range: rangeOf(sourceFile, statement),
            value,
            certainty: 'syntactic'
        }));
        index += 1;
    }
    return facts;
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

const firstInitializer = (statement: VariableStatement): Expression | undefined => {
    return statement.getDeclarationList().getDeclarations()[0]?.getInitializer();
};

// Walks a Zod call chain outside-in, collecting each `.method(args)` link down
// to the base `z.number()`/`z.string()`/`z.boolean()` call. Returns null the
// moment a link is not a recognized shape.
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
        if (Node.isIdentifier(object) && object.getText() === 'z' && BASE_ZOD_TYPES.has(name)) {
            return applyModifiers(name as 'number' | 'string' | 'boolean', links);
        }
        links.unshift({name, args: current.getArguments()});
        current = object;
    }
};

const applyModifiers = (dataType: 'number' | 'string' | 'boolean', links: ReadonlyArray<{name: string; args: Node[]}>): ResolvedConditions | null => {
    const conditions: ResolvedConditions = {dataType, required: true, nullable: false, normalization: []};
    for (const link of links) {
        const lower = link.name.toLowerCase();
        if (NO_OP_MODIFIERS.has(lower)) {
            continue;
        }
        if (lower === 'optional') {
            conditions.required = false;
            continue;
        }
        if (lower === 'nullable') {
            conditions.nullable = true;
            continue;
        }
        const normalization = NORMALIZATION_MODIFIERS.get(lower);
        if (normalization !== undefined) {
            conditions.normalization.push(normalization);
            continue;
        }
        if (lower === 'min') {
            const literal = link.args[0];
            if (literal === undefined || !Node.isNumericLiteral(literal)) {
                return null;
            }
            conditions.min = Number(literal.getText());
            continue;
        }
        if (lower === 'max') {
            const literal = link.args[0];
            if (literal === undefined || !Node.isNumericLiteral(literal)) {
                return null;
            }
            conditions.max = Number(literal.getText());
            continue;
        }
        // An unrecognized modifier: its effect on the actual accepted values is
        // not something Stoa can verify, so the whole schema is unresolved
        // rather than partially (and perhaps wrongly) described.
        return null;
    }
    return conditions;
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};
