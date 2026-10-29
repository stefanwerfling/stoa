import {Node, SyntaxKind} from 'ts-morph';
import type {CallExpression, SourceFile} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';

type Build = (spec: FactSpec) => Fact;

/**
 * Emits a `validation.backendInputUnvalidated` fact for a server request handler
 * that reads client-controlled input (`req`/`request` `.body`/`.query`/`.params`)
 * but shows no recognized validation of that input in the same handler. It models
 * the trust boundary (the backend must validate independently of the client), as a
 * low-false-positive heuristic — NOT a full dataflow analysis.
 *
 * "Validated" is recognized for the common static patterns: a Zod `.parse`/
 * `.safeParse`, a vts `schema.validate(...)`, a wrapper named like a validator
 * (`validateBody`, `parseOrReply`, `assert*`, …) that receives the request value,
 * or a framework route-schema option (Fastify `{ schema }`). Validation that lives
 * elsewhere — a `preValidation` hook, global middleware, or a cross-file wrapper
 * that hides the request argument — is NOT resolved (documented in the rule's
 * missingContext), so findings are a risk signal, not a proven defect.
 */
export const extractBackendValidationFacts = (sourceFile: SourceFile, build: Build): Fact[] => {
    const facts: Fact[] = [];
    let index = 0;
    for (const handler of handlerFunctions(sourceFile)) {
        const inputs = ownRequestInputs(handler);
        if (inputs.length === 0) {
            continue;
        }
        if (isValidated(handler)) {
            continue;
        }
        facts.push(build({
            kind: 'validation.backendInputUnvalidated',
            kindOf: 'function',
            symbol: `handler#${index}`,
            range: rangeOf(sourceFile, inputs[0] ?? handler),
            value: distinctSources(inputs).join(', '),
            certainty: 'semantic-heuristic'
        }));
        index += 1;
    }
    return facts;
};

const FUNCTION_KINDS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration
]);

const REQUEST_OBJECTS: ReadonlySet<string> = new Set(['req', 'request']);
// Structured client payloads only. Route `params` are deliberately excluded: an id
// in the path is controlled by authorization/ownership (a backend-only check, not a
// schema mismatch — see rule missingContext), and treating every :id read as an
// unvalidated input is noisy and low-signal.
const REQUEST_PROPERTIES: ReadonlySet<string> = new Set(['body', 'query']);

// Member methods that validate/narrow a value: Zod parse/safeParse, vts validate.
const VALIDATOR_METHODS: ReadonlySet<string> = new Set([
    'parse', 'parseasync', 'safeparse', 'safeparseasync', 'validate', 'validatesync', 'validateasync'
]);

// Free functions whose name reads like a validator (validateBody, parseOrReply,
// assertUser, …); parseInt/parseFloat are excluded — they are not validators.
const VALIDATOR_NAME = /^(validate|parse|assert|ensure|check|guard)/i;
const NOT_VALIDATORS: ReadonlySet<string> = new Set(['parseInt', 'parseFloat']);

const handlerFunctions = (sourceFile: SourceFile): Node[] => {
    return sourceFile.getDescendants().filter((node) => FUNCTION_KINDS.has(node.getKind()));
};

const nearestFunction = (node: Node): Node | undefined => {
    return node.getAncestors().find((ancestor) => FUNCTION_KINDS.has(ancestor.getKind()));
};

// The request-input property accesses whose nearest enclosing function is `handler`
// (so a nested callback's accesses are attributed to that callback, not this one),
// restricted to uses of the WHOLE payload — a single-field pluck (`req.query['id']`,
// `req.body.sessionId`) is a narrow lookup (an id controlled by authorization), not
// the structured-payload trust concern this rule targets, so it is not counted.
const ownRequestInputs = (handler: Node): Node[] => {
    return handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        .filter((access) => isRequestInput(access) && nearestFunction(access) === handler && isWholeObjectUse(access));
};

// Whether the request access is consumed as a whole object (assigned, spread, cast
// and passed, saved …) rather than immediately indexed for one field. Unwraps `as`,
// parentheses and `!` first, then rejects when the result is the object of a
// property/element access (`req.query['id']`, `(req.body as T).sessionId`).
const isWholeObjectUse = (access: Node): boolean => {
    let current = access;
    let parent = current.getParent();
    while (parent !== undefined && (Node.isAsExpression(parent) || Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent))) {
        current = parent;
        parent = parent.getParent();
    }
    if (parent === undefined) {
        return true;
    }
    if ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === current) {
        return false;
    }
    return true;
};

// `req.body` / `request.query` / `request.params` — a property access whose object
// is a bare req/request identifier and whose name is body/query/params.
const isRequestInput = (access: Node): boolean => {
    if (!Node.isPropertyAccessExpression(access)) {
        return false;
    }
    const object = access.getExpression();
    return Node.isIdentifier(object) && REQUEST_OBJECTS.has(object.getText()) && REQUEST_PROPERTIES.has(access.getName());
};

const distinctSources = (inputs: Node[]): string[] => {
    return [...new Set(inputs.map((input) => input.getText()))].sort();
};

// Whether the handler validates its request input: a validator call that references
// a request-derived value, a framework route-schema option wrapping the handler, or
// a hand-rolled guard that rejects bad input (a 400/422 response or a throw). The
// last avoids flagging handlers that validate manually with if-checks rather than a
// schema library; recognizing more kinds of guard favours fewer false positives.
const isValidated = (handler: Node): boolean => {
    const derived = requestDerivedNames(handler);
    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isValidatorCall(call) && callReferencesRequest(call, derived)) {
            return true;
        }
    }
    return hasRouteSchemaOption(handler) || rejectsBadInput(handler);
};

// A hand-rolled input guard: the handler can short-circuit with a 400/422 response
// (`reply.code(400)` / `res.status(422)`) or a throw. A handler that bothers to
// reject bad input is validating it, even without a schema library.
const REJECT_STATUS: ReadonlySet<number> = new Set([400, 422]);

const rejectsBadInput = (handler: Node): boolean => {
    if (handler.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0) {
        return true;
    }
    return handler.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
        const callee = call.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) {
            return false;
        }
        const name = callee.getName();
        if (name !== 'code' && name !== 'status') {
            return false;
        }
        const first = call.getArguments()[0];
        return first !== undefined && Node.isNumericLiteral(first) && REJECT_STATUS.has(Number(first.getText()));
    });
};

// Identifiers assigned directly from a request input (`const body = req.body`), so a
// later `schema.parse(body)` still counts as validating the request value.
const requestDerivedNames = (handler: Node): Set<string> => {
    const names = new Set<string>();
    for (const declaration of handler.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const initializer = declaration.getInitializer();
        const nameNode = declaration.getNameNode();
        if (initializer !== undefined && Node.isIdentifier(nameNode) && referencesRequest(initializer.getText(), new Set())) {
            names.add(nameNode.getText());
        }
    }
    return names;
};

const isValidatorCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
        return VALIDATOR_METHODS.has(callee.getName().toLowerCase());
    }
    if (Node.isIdentifier(callee)) {
        const name = callee.getText();
        return VALIDATOR_NAME.test(name) && !NOT_VALIDATORS.has(name);
    }
    return false;
};

// Whether a validator call is actually fed the request input (directly as
// `req.body`, or via a request-derived identifier), not some unrelated value.
const callReferencesRequest = (call: CallExpression, derived: ReadonlySet<string>): boolean => {
    return call.getArguments().some((argument) => referencesRequest(argument.getText(), derived));
};

const referencesRequest = (text: string, derived: ReadonlySet<string>): boolean => {
    if (/\b(req|request)\s*\.\s*(body|query|params)\b/.test(text)) {
        return true;
    }
    return [...derived].some((name) => new RegExp(`\\b${name}\\b`).test(text));
};

// A handler passed as an argument to a route registration whose options object
// declares an input schema is validated by the framework/wrapper before it runs,
// so its request access is not unvalidated. Recognizes the common option names —
// Fastify `schema`, and wrapper conventions like `bodySchema`/`querySchema`/
// `validation` — while ignoring `responseBodySchema`/`responseSchema` (those shape
// the response, not the input).
const INPUT_SCHEMA_OPTIONS: ReadonlySet<string> = new Set(['body', 'query', 'validation', 'validate']);

const isInputSchemaOption = (name: string): boolean => {
    const lower = name.toLowerCase();
    if (lower.endsWith('schema')) {
        return !lower.startsWith('response');
    }
    return INPUT_SCHEMA_OPTIONS.has(lower);
};

const hasRouteSchemaOption = (handler: Node): boolean => {
    const call = handler.getParentIfKind(SyntaxKind.CallExpression);
    if (call === undefined) {
        return false;
    }
    return call.getArguments().some((argument) =>
        Node.isObjectLiteralExpression(argument)
        && argument.getProperties().some((property) => Node.hasName(property) && isInputSchemaOption(property.getName())));
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};
