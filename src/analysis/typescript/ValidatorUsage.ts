import {Node, SyntaxKind} from 'ts-morph';
import type {CallExpression, SourceFile} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import {annotatedSchemas} from './ValidationAnnotations.js';
import {isRawRequestExpression, isRequestRootedExpression, nearestFunction, rawRequestAliasNames, rawRequestSinksInFunction} from './BackendValidation.js';

type Build = (spec: FactSpec) => Fact;

const PARSE_METHODS: ReadonlySet<string> = new Set(['parse', 'parseasync', 'safeparse', 'safeparseasync']);

/**
 * Whether an annotated, resolvable validator is actually wired into the
 * request-handling dataflow — the earlier contract checks only verify the
 * schema's SHAPE, never whether `.parse()`/`.safeParse()` is ever called on
 * it, or whether a raw copy of the same request data still reaches a
 * persistence sink after validation ran. Two facts:
 *
 * - `validation.annotatedValidatorUnused`: the schema is annotated with a
 *   well-formed ID and resolvable, but no `.parse()`/`.safeParse()` call on
 *   its identifier exists anywhere in THIS FILE. A schema exported and used
 *   only from another (possibly unanalyzed) file looks identical to a
 *   genuinely unused one from this single-file vantage point — a documented
 *   limitation, not a cross-file guarantee (see the rule's missingContext).
 * - `validation.rawReuseAfterValidation`: a `.parse()`/`.safeParse()` call on
 *   the schema IS fed request-rooted data (`req.body`, `req.body.field`, or a
 *   simple local alias of either) — but the SAME enclosing function also
 *   independently routes a raw whole-request value into a persistence sink
 *   (reusing the exact detection behind `validation.rawRequestMassAssignment`,
 *   not a re-derived heuristic): the validation ran, but did not gate what
 *   actually got saved. Scoped to ONE function, not a project-wide dataflow
 *   graph — a full call-graph trace across functions/files is out of scope.
 */
export const extractValidatorUsageFacts = (sourceFile: SourceFile, build: Build): Fact[] => {
    const facts: Fact[] = [];
    let unusedIndex = 0;
    let reuseIndex = 0;

    for (const schema of annotatedSchemas(sourceFile)) {
        if (!schema.idValid || schema.conditions === null || schema.schemaName === null) {
            continue;
        }
        const parseCalls = findParseCalls(sourceFile, schema.schemaName);
        if (parseCalls.length === 0) {
            facts.push(build({
                kind: 'validation.annotatedValidatorUnused',
                kindOf: 'statement',
                symbol: `unused#${unusedIndex}`,
                range: rangeOf(sourceFile, schema.statement),
                value: {id: schema.rawId},
                certainty: 'semantic-heuristic'
            }));
            unusedIndex += 1;
            continue;
        }

        for (const call of parseCalls) {
            const fn = nearestFunction(call);
            if (fn === undefined || !isFedByRequest(call)) {
                continue;
            }
            const sinks = rawRequestSinksInFunction(fn);
            if (sinks.length > 0) {
                facts.push(build({
                    kind: 'validation.rawReuseAfterValidation',
                    kindOf: 'statement',
                    symbol: `rawreuse#${reuseIndex}`,
                    range: rangeOf(sourceFile, call),
                    value: {id: schema.rawId, sinks: sinks.map((sink) => sink.description)},
                    certainty: 'semantic-heuristic'
                }));
                reuseIndex += 1;
            }
        }
    }
    return facts;
};

// `X.parse(...)` / `X.safeParse(...)` call expressions anywhere in the file
// whose callee's object is the bare identifier `schemaName`. Exported for
// reuse by the dataflow tracer (ValidationDataflow.ts): both need exactly
// this same "find every parse-like call on this schema" scan.
export const findParseCalls = (sourceFile: SourceFile, schemaName: string): CallExpression[] => {
    return sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
        const callee = call.getExpression();
        return Node.isPropertyAccessExpression(callee)
            && Node.isIdentifier(callee.getExpression())
            && callee.getExpression().getText() === schemaName
            && PARSE_METHODS.has(callee.getName().toLowerCase());
    });
};

// Whether the parse call's argument is derived from the request: a direct
// req.body/req.query access at any depth (a single plucked field, the usual,
// realistic shape — `.parse(req.body.quantity)`), or a simple local alias of
// the whole request object. Looser than the whole-object-only check used for
// the mass-assignment sink (isRawRequestExpression) on purpose: here Stoa only
// needs to know "this validates something from the request", not "this is the
// entire payload".
// Exported for reuse by the dataflow tracer (ValidationDataflow.ts), which
// needs the exact same "is this validator call actually fed by the request"
// gate before it starts tracing where the RESULT goes.
export const isFedByRequest = (call: CallExpression): boolean => {
    const fn = nearestFunction(call);
    const rawNames = fn === undefined ? new Set<string>() : rawRequestAliasNames(fn);
    return call.getArguments().some((argument) => isRequestRootedExpression(argument) || isRawRequestExpression(argument, rawNames));
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};
