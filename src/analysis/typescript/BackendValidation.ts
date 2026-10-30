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

// Exported for reuse by the Validation Trace ID usage tracer
// (ValidatorUsage.ts): the nearest enclosing function-like ancestor, the same
// per-function scoping used throughout this file.
export const nearestFunction = (node: Node): Node | undefined => {
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

// Strips `as T`, `(…)` and `!` wrappers to the underlying expression, so a cast or
// parenthesized request value is still recognized by shape (`(req.body as T)`).
const unwrapExpression = (node: Node): Node => {
    let current = node;
    while (true) {
        if (Node.isAsExpression(current) || Node.isParenthesizedExpression(current) || Node.isNonNullExpression(current)) {
            current = current.getExpression();
            continue;
        }
        return current;
    }
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

// Whether `node` is, after unwrapping casts/parens/`!`, ROOTED at a bare
// req/request identifier at any depth (`req.body`, `req.body.quantity`,
// `req.query['id']`, …) — looser than isRequestInput (whole-object only) on
// purpose: used by the usage tracer to recognize the common, realistic shape
// of a single plucked field being fed into a validator call.
export const isRequestRootedExpression = (node: Node): boolean => {
    let current: Node = unwrapExpression(node);
    while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
        current = current.getExpression();
    }
    return Node.isIdentifier(current) && REQUEST_OBJECTS.has(current.getText());
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
    const boundNames = boundValidatorNames(handler);
    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isValidatorCall(call, boundNames) && callReferencesRequest(call, derived)) {
            return true;
        }
    }
    // The guard-condition check below needs the STRICT alias set (a direct
    // `const body = req.body`), not the loose `derived` above (which deliberately
    // over-matches by substring — e.g. `const user = await repo.findById(req.params.id)`
    // would otherwise make `user` count as "request-derived", so `if (!user) throw`
    // would wrongly look like an input check when it is actually a DB-lookup guard).
    return hasRouteSchemaOption(handler) || rejectsBadInput(handler, rawRequestAliasNames(handler));
};

// A hand-rolled input guard: the handler can short-circuit with a 400/422 response
// (`reply.code(400)` / `res.status(422)`) or a throw — but ONLY when that throw/
// response is actually gated by a condition referencing the request input (or a
// request-derived local). A throw/400 reached unconditionally, or gated by an
// unrelated condition (a DB-lookup result, an auth check, …), proves nothing about
// input validation and must not be treated as evidence of it — see
// test/BackendValidation.test.ts for the exact regression this fixes.
const REJECT_STATUS: ReadonlySet<number> = new Set([400, 422]);

const rejectsBadInput = (handler: Node, rawAliases: ReadonlySet<string>): boolean => {
    for (const statement of handler.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
        if (guardedByRequestCondition(statement, handler, rawAliases)) {
            return true;
        }
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
        const isRejectStatus = first !== undefined && Node.isNumericLiteral(first) && REJECT_STATUS.has(Number(first.getText()));
        return isRejectStatus && guardedByRequestCondition(call, handler, rawAliases);
    });
};

// Whether `node` (a throw statement, or a .code(400)/.status(422) call) is reached
// through an enclosing `if` whose condition references the request — directly
// (`req.body`/`req.query`, at any depth) or via a STRICT raw-alias local name
// (`rawAliases`, from `rawRequestAliasNames` — deliberately the under-matching
// set, not the loose `requestDerivedNames`, so a variable merely downstream of a
// request-mentioning expression, e.g. `const user = await repo.findById(req.params.id)`,
// does not count). Walks EVERY enclosing if up to `handler`'s boundary (not just
// the nearest), since a guard can be nested and an outer condition may be the one
// that actually checks the input while an inner one checks something else.
const guardedByRequestCondition = (node: Node, handler: Node, rawAliases: ReadonlySet<string>): boolean => {
    let current: Node | undefined = node.getParent();
    while (current !== undefined && current !== handler) {
        if (Node.isIfStatement(current) && conditionReferencesRequest(current.getExpression(), rawAliases)) {
            return true;
        }
        current = current.getParent();
    }
    return false;
};

const conditionReferencesRequest = (condition: Node, rawAliases: ReadonlySet<string>): boolean => {
    if (Node.isIdentifier(condition)) {
        return rawAliases.has(condition.getText());
    }
    if (Node.isPropertyAccessExpression(condition) && (isRequestInput(condition) || isRequestRootedExpression(condition))) {
        return true;
    }
    for (const access of condition.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (isRequestInput(access) || isRequestRootedExpression(access)) {
            return true;
        }
    }
    for (const identifier of condition.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (rawAliases.has(identifier.getText())) {
            return true;
        }
    }
    return false;
};

// Identifiers bound to a validator method via `.bind(...)`
// (`const X = schema.safeParse.bind(schema)`) — X is a verified validator alias
// regardless of its name, discovered via the AST relationship (the explicit ask in
// the correctness follow-up: prefer AST relationships over a name heuristic). The
// existing name-based heuristic (VALIDATOR_NAME) is kept as a fallback, not
// replaced, so already-verified real-world wrappers (validateBody, parseOrReply)
// are unaffected.
// Scans the WHOLE FILE, not just the handler's own body: a bound-validator alias
// is realistically declared at module scope (next to the schema it wraps), not
// freshly inside every handler that uses it.
const boundValidatorNames = (handler: Node): ReadonlySet<string> => {
    const names = new Set<string>();
    for (const declaration of handler.getSourceFile().getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const nameNode = declaration.getNameNode();
        const initializer = declaration.getInitializer();
        if (initializer !== undefined && Node.isIdentifier(nameNode) && isValidatorBindExpression(initializer)) {
            names.add(nameNode.getText());
        }
    }
    return names;
};

// `<schema>.<validatorMethod>.bind(<thisArg>)` — a call to `.bind` whose bound
// callee-object is itself `<something>.<validatorMethod>`.
const isValidatorBindExpression = (expression: Node): boolean => {
    if (!Node.isCallExpression(expression)) {
        return false;
    }
    const callee = expression.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'bind') {
        return false;
    }
    const bound = callee.getExpression();
    return Node.isPropertyAccessExpression(bound) && VALIDATOR_METHODS.has(bound.getName().toLowerCase());
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

const isValidatorCall = (call: CallExpression, boundNames: ReadonlySet<string>): boolean => {
    const callee = call.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
        return VALIDATOR_METHODS.has(callee.getName().toLowerCase());
    }
    if (Node.isIdentifier(callee)) {
        const name = callee.getText();
        if (boundNames.has(name)) {
            return true;
        }
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

/**
 * Emits a `validation.rawRequestMassAssignment` fact where the RAW (unvalidated)
 * request payload — not a schema-parsed result — flows whole into `Object.assign`,
 * or into a persistence-verb call (`save`/`create`/`update`/`insert`/`upsert`/
 * `persist`/`replace`), either directly or spread into an object literal argument.
 * This is deliberately about the raw value: an identifier assigned FROM a validator
 * call (`const body = schema.parse(req.body)`) is not raw, even though its
 * initializer text still contains `req.body` — the schema's declared shape is the
 * allow-list. A single-field pluck is not whole-object use and is not flagged
 * (the same scope restriction as `validation.backendInputUnvalidated`).
 */
export const extractMassAssignmentFacts = (sourceFile: SourceFile, build: Build): Fact[] => {
    const facts: Fact[] = [];
    let index = 0;
    for (const fn of handlerFunctions(sourceFile)) {
        for (const site of rawRequestSinksInFunction(fn)) {
            facts.push(build({
                kind: 'validation.rawRequestMassAssignment',
                kindOf: 'statement',
                symbol: `massAssign#${index}`,
                range: rangeOf(sourceFile, site.call),
                value: site.description,
                certainty: 'semantic-heuristic'
            }));
            index += 1;
        }
    }
    return facts;
};

const PERSISTENCE_VERB = /^(save|create|update|insert|upsert|persist|replace)/i;

interface RawRequestSink {
    call: CallExpression;
    description: string;
}

// The raw-request-to-sink evidence found directly in `fn` (not nested
// functions) — a framework route-schema option exempts the whole function
// (it validates/shapes the payload before the handler runs). Exported for
// reuse by the Validation Trace ID usage tracer (ValidatorUsage.ts): "a
// validator was invoked AND a raw copy of the payload still reached a sink in
// the same function" reuses this exact, already-hardened detection rather
// than re-deriving it.
export const rawRequestSinksInFunction = (fn: Node): RawRequestSink[] => {
    if (hasRouteSchemaOption(fn)) {
        return [];
    }
    const rawNames = rawRequestAliasNames(fn);
    const sinks: RawRequestSink[] = [];
    for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (nearestFunction(call) !== fn) {
            continue;
        }
        const description = massAssignmentSite(call, rawNames);
        if (description !== null) {
            sinks.push({call, description});
        }
    }
    return sinks;
};

// Identifiers assigned directly, raw, from a request input (`const body = req.body`
// or `const q = (req.query as T)`) — NOT via a validator call. Stricter than
// requestDerivedNames (used by the sibling rule), which intentionally over-matches
// by substring to recognize validation; here under-matching is the safe direction.
export const rawRequestAliasNames = (fn: Node): ReadonlySet<string> => {
    const names = new Set<string>();
    for (const declaration of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const initializer = declaration.getInitializer();
        const nameNode = declaration.getNameNode();
        if (initializer !== undefined && Node.isIdentifier(nameNode) && isRawRequestExpression(initializer, names)) {
            names.add(nameNode.getText());
        }
    }
    return names;
};

// Whether `node` is, after unwrapping casts/parens/`!`, a direct req.body/req.query
// access or a known raw alias identifier — the request payload itself, untouched by
// any validator call.
export const isRawRequestExpression = (node: Node, rawNames: ReadonlySet<string>): boolean => {
    const unwrapped = unwrapExpression(node);
    if (isRequestInput(unwrapped)) {
        return true;
    }
    return Node.isIdentifier(unwrapped) && rawNames.has(unwrapped.getText());
};

// Whether `call` is a mass-assignment sink fed the raw request payload, and if so a
// short evidence string naming the pattern; null otherwise.
const massAssignmentSite = (call: CallExpression, rawNames: ReadonlySet<string>): string | null => {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) {
        return null;
    }
    const args = call.getArguments();

    if (Node.isIdentifier(callee.getExpression()) && callee.getExpression().getText() === 'Object' && callee.getName() === 'assign') {
        const source = args.slice(1).find((argument) => isRawRequestExpression(argument, rawNames));
        return source === undefined ? null : `Object.assign(…, ${source.getText()})`;
    }

    if (PERSISTENCE_VERB.test(callee.getName())) {
        for (const argument of args) {
            if (isRawRequestExpression(argument, rawNames)) {
                return `${callee.getName()}(${argument.getText()})`;
            }
            const spread = spreadRawRequestSource(argument, rawNames);
            if (spread !== null) {
                return `${callee.getName()}({...${spread}})`;
            }
        }
    }
    return null;
};

// If `argument` is an object literal that spreads the raw request payload
// (`{...req.body}` / `{...body, id}`), the spread source's text; otherwise null.
const spreadRawRequestSource = (argument: Node, rawNames: ReadonlySet<string>): string | null => {
    if (!Node.isObjectLiteralExpression(argument)) {
        return null;
    }
    for (const property of argument.getProperties()) {
        if (Node.isSpreadAssignment(property) && isRawRequestExpression(property.getExpression(), rawNames)) {
            return property.getExpression().getText();
        }
    }
    return null;
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};
