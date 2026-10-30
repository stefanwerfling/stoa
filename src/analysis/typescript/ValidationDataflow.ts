import {Node, SyntaxKind} from 'ts-morph';
import type {CallExpression, SourceFile} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import type {EvidenceEdge, EvidenceGraph, EvidenceNode, EvidenceStatus} from '../../evidence/EvidenceGraph.js';
import {annotatedSchemas} from './ValidationAnnotations.js';
import type {AnnotatedSchema} from './ValidationAnnotations.js';
import {isRawRequestExpression, isRequestRootedExpression, nearestFunction, PERSISTENCE_VERB, rawRequestAliasNames} from './BackendValidation.js';
import {findParseCalls, isFedByRequest} from './ValidatorUsage.js';
import {findInnerCall, resolveOneHop} from './OneHopResolution.js';
import {destructuredProperty, isReassignedAnywhere, tracksBinding} from './SymbolResolution.js';

type Build = (spec: FactSpec) => Fact;

const SAFE_PARSE_METHODS: ReadonlySet<string> = new Set(['safeparse', 'safeparseasync']);

// A call's callee text (e.g. "userService.register") suggestive of a
// business/persistence layer — used ONLY to decide whether an unresolvable
// one-hop call is worth surfacing as "destination unknown", never as proof
// that it actually persists anything.
const SERVICE_LIKE_RECEIVER = /service|repository|repo|manager|store/i;

/**
 * Traces, for each `// stoa:validation`-annotated schema invocation that is
 * actually fed by request data (the same gate `ValidatorUsage.ts` uses),
 * where the VALIDATED value goes afterwards — building a small Evidence
 * Graph (`src/evidence/EvidenceGraph.ts`) per invocation, one fact
 * (`validation.dataflowGraph`) per graph, instead of a single flat
 * true/false fact. This is a deliberately narrow first slice of "Validator
 * Dataflow Analysis":
 *
 * - Same-function tracing (verified): the validated value (a `.parse()`
 *   result, or `<result>.data` after `.safeParse()`) is a direct argument of
 *   a persistence-verb call (`save`/`create`/`update`/…, the same signal
 *   `R-VALIDATION-MASS-ASSIGNMENT` uses) in the SAME function.
 * - One-hop cross-function tracing (heuristic): the validated value is
 *   passed to a call whose callee resolves — by ts-morph symbol, WITHIN THIS
 *   FILE ONLY — to a function/method/arrow with a plain (non-destructured)
 *   parameter at the matching position, and that parameter is itself a
 *   direct argument of a persistence-verb call inside that declaration's own
 *   body (not a nested callback). This is the `userService.create(result.data)`
 *   → `UserService.create(data)` → `this.repository.save(data)` shape from
 *   the dataflow-analysis spec.
 * - Everything else is either silently not reported (the callee clearly
 *   isn't a sink, or resolves in-file to something with no persistence call
 *   at all — nothing to flag) or, when the callee LOOKS business/persistence
 *   related by name but cannot be resolved within this file (an import, a
 *   dynamic/computed call, an interface with no single implementation),
 *   recorded as an `unresolved` edge — visible in the graph fact, but
 *   deliberately NOT promoted to every caller's own finding (too speculative
 *   on name alone); see `ValidationContractRule.ts` for which edges DO
 *   become a finding.
 *
 * No cross-file resolution, no destructured parameters, no spread
 * arguments, no recursion beyond one hop — each edge's `status`/`limits`
 * states exactly what was and was not established for that specific case.
 */
export const extractValidationDataflowFacts = (sourceFile: SourceFile, build: Build): Fact[] => {
    const facts: Fact[] = [];
    let index = 0;
    for (const schema of annotatedSchemas(sourceFile)) {
        // Deliberately does NOT require `schema.conditions !== null`: whether a
        // schema's VALUE SHAPE is a recognized scalar chain (ValidationAnnotations.ts)
        // is orthogonal to WHERE its result goes — the realistic case is a
        // `z.object(...)` request-body schema, which never resolves conditions
        // (object schemas are out of scope there) but is exactly what dataflow
        // tracing is for.
        if (!schema.idValid || schema.schemaName === null) {
            continue;
        }
        for (const call of findParseCalls(sourceFile, schema.schemaName)) {
            const fn = nearestFunction(call);
            if (fn === undefined || !isFedByRequest(call)) {
                continue;
            }
            const graph = buildGraph(sourceFile, schema, call, fn);
            if (graph === null) {
                continue;
            }
            facts.push(build({
                kind: 'validation.dataflowGraph',
                kindOf: 'statement',
                symbol: `dataflow#${index}`,
                range: rangeOf(sourceFile, call),
                value: {id: schema.rawId, graph} as unknown as Record<string, unknown>,
                certainty: 'semantic-heuristic'
            }));
            index += 1;
        }
    }
    return facts;
};

const calleeName = (call: CallExpression): string => {
    const callee = call.getExpression();
    return Node.isPropertyAccessExpression(callee) ? callee.getName() : '';
};

const rootIdentifierText = (argument: Node): string => {
    let current: Node = argument;
    while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
        current = current.getExpression();
    }
    return current.getText();
};

// The declared NAME NODE a `.parse()`/`.safeParse()` call's result is bound
// to (`const x = schema.parse(...)`) — an actual Identifier node, not text,
// so later matching can use symbol identity (SymbolResolution.ts). Null
// when used inline (no binding to trace onward by).
const bindingDeclarationOf = (call: CallExpression): Node | null => {
    const parent = call.getParent();
    if (parent !== undefined && Node.isVariableDeclaration(parent)) {
        const nameNode = parent.getNameNode();
        if (Node.isIdentifier(nameNode)) {
            return nameNode;
        }
    }
    return null;
};

// `<result>.data` where `<result>` tracks the SAME binding as `resultDeclaration`
// (symbol identity, not text — see SymbolResolution.ts; a shadowed, unrelated
// `result` elsewhere in the function must not match).
const isDataAccessOf = (node: Node, resultDeclaration: Node, scope: Node): boolean => {
    return Node.isPropertyAccessExpression(node) && tracksBinding(node.getExpression(), resultDeclaration, scope) && node.getName() === 'data';
};

// First `<result>.data` property access tracking `resultDeclaration`'s
// binding, found anywhere in `fn`, in source order.
const findDataAccess = (fn: Node, resultDeclaration: Node): Node | undefined => {
    return fn.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).find((access) => isDataAccessOf(access, resultDeclaration, fn));
};

interface SinkTrace {
    call: CallExpression;
    status: EvidenceStatus;
    basis: string;
    limits?: string[];
    /** Set when this edge lands on an intermediate function/service, not a confirmed sink. */
    service?: string;
    innerSink?: {call: CallExpression; basis: string};
}

const traceSink = (fn: Node, matches: (node: Node) => boolean): SinkTrace | null => {
    for (const outer of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (nearestFunction(outer) !== fn) {
            continue;
        }
        const argument = outer.getArguments().find((arg) => matches(arg));
        if (argument === undefined) {
            continue;
        }
        if (PERSISTENCE_VERB.test(calleeName(outer))) {
            return {
                call: outer,
                status: 'verified',
                basis: `${argument.getText()} is a direct argument of ${outer.getText()}, a persistence-verb call in the same function`
            };
        }
        const hop = resolveOneHop(outer, argument);
        if (hop !== null) {
            const inner = findInnerCall(hop.declaration, (name) => PERSISTENCE_VERB.test(name))(hop.paramNameNode);
            if (inner !== null) {
                return {
                    call: outer,
                    status: 'heuristic',
                    basis: `${argument.getText()} is passed to ${outer.getText()}, whose parameter \`${hop.paramNameNode.getText()}\` reaches ${inner.getText()} inside ${hop.label}`,
                    limits: ['identity of the parameter across the call boundary is inferred by position, not type-proven'],
                    service: outer.getExpression().getText(),
                    innerSink: {call: inner, basis: `\`${hop.paramNameNode.getText()}\` is a direct argument of ${inner.getText()} inside ${hop.label}`}
                };
            }
            // Resolvable but no persistence call anywhere inside — genuinely
            // nothing to report (not every helper function persists).
            continue;
        }
        if (SERVICE_LIKE_RECEIVER.test(outer.getExpression().getText())) {
            return {
                call: outer,
                status: 'unresolved',
                basis: `${argument.getText()} is passed to ${outer.getText()}, whose implementation could not be resolved within this file`,
                limits: ['the callee is not declared in this file (an import, a dynamic/computed call, or an interface with no single resolvable implementation)'],
                service: outer.getExpression().getText()
            };
        }
    }
    return null;
};

const buildGraph = (sourceFile: SourceFile, schema: AnnotatedSchema, call: CallExpression, fn: Node): EvidenceGraph | null => {
    const schemaName = schema.schemaName as string;
    const rawNames = rawRequestAliasNames(fn);
    const requestArg = call.getArguments().find((arg) => isRequestRootedExpression(arg) || isRawRequestExpression(arg, rawNames));
    if (requestArg === undefined) {
        return null;
    }

    let seq = 0;
    const nodes: EvidenceNode[] = [];
    const edges: EvidenceEdge[] = [];
    const addNode = (kind: EvidenceNode['kind'], label: string, at: Node): string => {
        const nid = `${kind}#${seq}`;
        seq += 1;
        nodes.push({id: nid, kind, label, file: sourceFile.getFilePath(), range: rangeOf(sourceFile, at)});
        return nid;
    };
    const addEdge = (from: string, to: string, kind: EvidenceEdge['kind'], status: EvidenceStatus, basis: string, at: Node, limits?: string[]): void => {
        edges.push({from, to, kind, file: sourceFile.getFilePath(), range: rangeOf(sourceFile, at), basis, status, ...(limits !== undefined ? {limits} : {})});
    };

    const sourceId = addNode('request-source', rootIdentifierText(requestArg), requestArg);
    const inputId = addNode('input-value', requestArg.getText(), requestArg);
    addEdge(sourceId, inputId, 'receives', 'verified', `${requestArg.getText()} read directly in this function`, requestArg);

    const schemaId = addNode('validation-schema', schemaName, schema.statement);
    const invocationId = addNode('validator-invocation', call.getText(), call);
    addEdge(inputId, invocationId, 'passes-to', 'verified', `argument of ${call.getText()}`, call);
    addEdge(schemaId, invocationId, 'validates', 'verified', `${schemaName} is the receiver of ${calleeName(call)}`, call);

    const isSafe = SAFE_PARSE_METHODS.has(calleeName(call).toLowerCase());
    const boundDeclaration = bindingDeclarationOf(call);

    let validatedId: string;
    let matches: (node: Node) => boolean;

    if (isSafe) {
        const resultId = addNode('validation-result', boundDeclaration?.getText() ?? '(unbound)', call);
        addEdge(invocationId, resultId, 'returns', 'verified', `${call.getText()} returns a {success, data} result`, call);
        if (boundDeclaration === null) {
            // Result not bound to a name (used inline) — no `.data` access to find.
            return {nodes, edges};
        }
        if (isReassignedAnywhere(boundDeclaration, fn)) {
            // The result binding is reassigned somewhere in this function —
            // Stoa cannot prove a later `.data`/destructured access still
            // refers to THIS validator's result rather than whatever it was
            // overwritten with. Stop here rather than guess.
            return {nodes, edges};
        }
        // Either `result.data` (a property access) or `const {data} = result`
        // (destructuring) — both are the validated value, resolved via
        // symbol identity so a shadowed, unrelated `result` elsewhere in the
        // function is never mistaken for this one.
        const dataAccess = findDataAccess(fn, boundDeclaration);
        if (dataAccess !== undefined) {
            validatedId = addNode('validated-value', `${boundDeclaration.getText()}.data`, dataAccess);
            addEdge(resultId, validatedId, 'transforms', 'verified', `${boundDeclaration.getText()}.data is the validated value`, dataAccess);
            matches = (node: Node): boolean => isDataAccessOf(node, boundDeclaration, fn);
        } else {
            const destructured = destructuredProperty(boundDeclaration, 'data', fn);
            if (destructured === null) {
                return {nodes, edges};
            }
            validatedId = addNode('validated-value', destructured.getText(), destructured);
            addEdge(resultId, validatedId, 'transforms', 'verified', `{ data } destructured from ${boundDeclaration.getText()} is the validated value`, destructured);
            matches = (node: Node): boolean => tracksBinding(node, destructured, fn);
        }
    } else {
        validatedId = addNode('validated-value', boundDeclaration?.getText() ?? call.getText(), call);
        addEdge(invocationId, validatedId, 'returns', 'verified', `${call.getText()} returns the validated value directly`, call);
        if (boundDeclaration === null) {
            // Used inline (e.g. `repo.save(schema.parse(req.body))`) — the call
            // expression itself IS the value a wrapping call would reference.
            matches = (node: Node): boolean => node === call;
        } else if (isReassignedAnywhere(boundDeclaration, fn)) {
            // Same reasoning as the safeParse branch above: a reassigned
            // binding can no longer be proven to still hold the validated
            // value at a later use site.
            matches = (): boolean => false;
        } else {
            matches = (node: Node): boolean => tracksBinding(node, boundDeclaration, fn);
        }
    }

    const sink = traceSink(fn, matches);
    if (sink !== null) {
        if (sink.service !== undefined) {
            const serviceId = addNode('service', sink.service, sink.call);
            addEdge(validatedId, serviceId, 'passes-to', sink.status, sink.basis, sink.call, sink.limits);
            if (sink.innerSink !== undefined) {
                const innerId = addNode('persistence-sink', sink.innerSink.call.getText(), sink.innerSink.call);
                addEdge(serviceId, innerId, 'persists', sink.status, sink.innerSink.basis, sink.innerSink.call);
            }
        } else {
            const sinkId = addNode('persistence-sink', sink.call.getText(), sink.call);
            addEdge(validatedId, sinkId, 'persists', sink.status, sink.basis, sink.call, sink.limits);
        }
    }

    return {nodes, edges};
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};
