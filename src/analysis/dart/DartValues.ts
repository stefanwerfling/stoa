import type {Node} from 'web-tree-sitter';
import {asConstructor, callSiteOf} from './DartCallSite.js';

/**
 * Value semantics for Dart call arguments (Flutter analysis, Phase A): what an
 * argument value IS, as far as its own syntax proves — deliberately bounded,
 * never an expression evaluator. Extraction-time encoding (`encodeArgValue`,
 * reads AST nodes) and a plain-data decoding (`decodeArgValue`) are separate,
 * so the stored form holds no AST and no source text beyond short string
 * literals.
 *
 * Recognised, in this order of trust:
 * - literals: `true`/`false`, `null`, integers (decimal/hex; `value` null
 *   beyond the safe-integer range), doubles (incl. a leading `-`), strings
 *   (`value` only for a single literal of at most 64 characters without
 *   interpolation or escapes — otherwise `value: null`, still a known string);
 * - a static member reference `Type.member` (`Axis.vertical`,
 *   `double.infinity`, `m.Axis.horizontal` with a declared prefix) — recorded
 *   as written, not resolved to a value;
 * - a constructor call (`BoxConstraints(maxHeight: 200)`,
 *   `const EdgeInsets.all(8)`) as an `object` with its arguments one level deep
 *   (positional ones as `#0`, `#1`, …); deeper objects keep only their type
 *   (`args: null`), and more than 8 arguments are not listed;
 * - everything else is explicitly UNKNOWN: `reference` (a variable or property
 *   access — `v`, `widget.x`), `closure` (a function expression), `widget` (a
 *   widget slot; the child is a graph node of its own), `expression` (any other
 *   expression: conditionals, operators, method calls, unparsed regions).
 * Unknown is never collapsed into a guessed literal.
 */

export type ArgValue =
    | {kind: 'bool'; value: boolean}
    | {kind: 'null'}
    | {kind: 'int'; value: number | null}
    | {kind: 'double'; value: number}
    | {kind: 'string'; value: string | null}
    | {kind: 'member'; target: string; name: string}
    | {kind: 'object'; type: string; constructorName: string | null; args: readonly NamedArgValue[] | null}
    | {kind: 'widget'}
    | {kind: 'closure'}
    | {kind: 'reference'}
    | {kind: 'expression'};

export interface NamedArgValue {
    /** The argument label, or `#<index>` for a positional argument. */
    name: string;
    value: ArgValue;
}

/**
 * Compact stored form (JSON), one tagged tuple per value:
 * `['b', bool]`, `['n']`, `['i', number|null]`, `['d', number]`,
 * `['s', string|null]`, `['m', target, name]`,
 * `['o', type, constructor|null, [[name, value], …] | null]`,
 * `['w']`, `['f']`, `['r']`, `['x']`.
 */
export type EncodedArgValue =
    | ['b', boolean]
    | ['n']
    | ['i', number | null]
    | ['d', number]
    | ['s', string | null]
    | ['m', string, string]
    | ['o', string, string | null, [string, EncodedArgValue][] | null]
    | ['w']
    | ['f']
    | ['r']
    | ['x'];

const MAX_STRING_LENGTH = 64;
const MAX_OBJECT_ARGS = 8;
const QUOTES: ReadonlySet<string> = new Set(["'", '"', "'''", '"""', "r'", 'r"', "r'''", 'r"""']);

export const WIDGET_VALUE: EncodedArgValue = ['w'];
export const CLOSURE_VALUE: EncodedArgValue = ['f'];

/**
 * Encodes an argument value given as the sibling nodes tree-sitter-dart uses for
 * it (a call is a primary identifier followed by `selector` siblings).
 * Extraction-time only. `depth` 0 = the argument itself; objects nested deeper
 * than one level keep only their type.
 */
export const encodeArgValue = (value: readonly Node[], prefixes: ReadonlySet<string>, depth = 0): EncodedArgValue => {
    const nodes = unwrapParentheses(value.filter((node) => node.type !== 'comment'));
    const first = nodes[0];
    if (first === undefined || nodes.some((node) => node.type === 'ERROR' || node.hasError)) {
        return ['x'];
    }
    if (nodes.length === 1) {
        const literal = literalOf(first);
        if (literal !== null) {
            return literal;
        }
        if (first.type === 'identifier') {
            return ['r'];
        }
        if (first.type === 'function_expression') {
            return ['f'];
        }
    }
    const member = memberOf(nodes, prefixes);
    if (member !== null) {
        return member;
    }
    const site = callSiteOf(first, prefixes);
    const last = nodes[nodes.length - 1] as Node;
    if (site !== null && site.arguments.endIndex === last.endIndex) {
        const ctor = asConstructor(site);
        if (ctor !== null) {
            return ['o', ctor.typeName, ctor.constructorName, depth >= 1 ? null : objectArgs(site.arguments, prefixes, depth)];
        }
    }
    if (first.type === 'identifier' && nodes.slice(1).every((node) => node.type === 'selector' && isNameSelector(node))) {
        return ['r']; // `widget.x`, `a.b.c` — a property access, value unknown.
    }
    return ['x'];
};

export const decodeArgValue = (encoded: EncodedArgValue): ArgValue => {
    switch (encoded[0]) {
        case 'b':
            return {kind: 'bool', value: encoded[1]};
        case 'n':
            return {kind: 'null'};
        case 'i':
            return {kind: 'int', value: encoded[1]};
        case 'd':
            return {kind: 'double', value: encoded[1]};
        case 's':
            return {kind: 'string', value: encoded[1]};
        case 'm':
            return {kind: 'member', target: encoded[1], name: encoded[2]};
        case 'o':
            return {
                kind: 'object',
                type: encoded[1],
                constructorName: encoded[2],
                args: encoded[3] === null ? null : encoded[3].map(([name, value]) => ({name, value: decodeArgValue(value)}))
            };
        case 'w':
            return {kind: 'widget'};
        case 'f':
            return {kind: 'closure'};
        case 'r':
            return {kind: 'reference'};
        default:
            return {kind: 'expression'};
    }
};

/** The literal boolean, or null when the value is not a boolean literal (unknown or another type). */
export const boolLiteral = (value: ArgValue | undefined): boolean | null => (value !== undefined && value.kind === 'bool' ? value.value : null);

/** The axis named by `Axis.vertical` / `Axis.horizontal`, or null for anything else. */
export const axisLiteral = (value: ArgValue | undefined): 'vertical' | 'horizontal' | null =>
    value !== undefined && value.kind === 'member' && value.target === 'Axis' && (value.name === 'vertical' || value.name === 'horizontal') ? value.name : null;

/** A numeric literal (int/double, `double.infinity` → Infinity), or null. */
export const numberLiteral = (value: ArgValue | undefined): number | null => {
    if (value === undefined) {
        return null;
    }
    if (value.kind === 'int' || value.kind === 'double') {
        return value.value;
    }
    if (value.kind === 'member' && value.target === 'double' && value.name === 'infinity') {
        return Number.POSITIVE_INFINITY;
    }
    return null;
};

const literalOf = (node: Node): EncodedArgValue | null => {
    switch (node.type) {
        case 'true':
            return ['b', true];
        case 'false':
            return ['b', false];
        case 'null_literal':
            return ['n'];
        case 'decimal_integer_literal':
        case 'hex_integer_literal': {
            const parsed = Number(node.text.replace(/_/g, ''));
            return ['i', Number.isSafeInteger(parsed) ? parsed : null];
        }
        case 'decimal_floating_point_literal': {
            const parsed = Number(node.text.replace(/_/g, ''));
            return Number.isFinite(parsed) ? ['d', parsed] : ['x'];
        }
        case 'string_literal':
            return ['s', stringValue(node)];
        case 'unary_expression': {
            const parts = namedChildren(node);
            const operator = parts[0];
            const operand = parts[1];
            if (parts.length === 2 && operator?.type === 'prefix_operator' && operator.text === '-' && operand !== undefined) {
                const inner = literalOf(operand);
                if (inner !== null && (inner[0] === 'i' || inner[0] === 'd') && inner[1] !== null) {
                    return inner[0] === 'i' ? ['i', -inner[1]] : ['d', -inner[1]];
                }
            }
            return null;
        }
        default:
            return null;
    }
};

// The content of ONE plain string literal (one opening + one closing quote, no
// `${…}`/`$x`, no escape), at most MAX_STRING_LENGTH characters; otherwise null.
const stringValue = (node: Node): string | null => {
    const quotes = node.children.filter((child): child is Node => child !== null && !child.isNamed && QUOTES.has(child.type));
    if (quotes.length !== 2 || namedChildren(node).length > 0) {
        return null;
    }
    const open = quotes[0] as Node;
    const close = quotes[1] as Node;
    const content = node.text.slice(open.endIndex - node.startIndex, close.startIndex - node.startIndex);
    const raw = open.type.startsWith('r');
    if ((!raw && content.includes('\\')) || content.length > MAX_STRING_LENGTH) {
        return null;
    }
    return content;
};

// `Type.member` or `prefix.Type.member` (declared prefix) with name selectors
// only; the type must look like a type (UpperCamelCase) or be `double`/`int`.
const memberOf = (nodes: readonly Node[], prefixes: ReadonlySet<string>): EncodedArgValue | null => {
    const first = nodes[0];
    if (first === undefined || first.type !== 'identifier') {
        return null;
    }
    const names = [first.text];
    for (const node of nodes.slice(1)) {
        if (node.type !== 'selector' || !isNameSelector(node)) {
            return null;
        }
        const name = selectorName(node);
        if (name === null) {
            return null;
        }
        names.push(name);
    }
    const chain = names.length === 3 && prefixes.has(names[0] as string) ? names.slice(1) : names;
    const [target, member] = chain;
    if (chain.length !== 2 || target === undefined || member === undefined || !(/^[A-Z]/.test(target) || target === 'double' || target === 'int')) {
        return null;
    }
    return ['m', target, member];
};

const objectArgs = (args: Node, prefixes: ReadonlySet<string>, depth: number): [string, EncodedArgValue][] | null => {
    const result: [string, EncodedArgValue][] = [];
    let position = 0;
    for (const child of namedChildren(args)) {
        if (child.type === 'named_argument') {
            const parts = namedChildren(child);
            const label = parts.find((part) => part.type === 'label');
            const name = label === undefined ? undefined : namedChildren(label).find((part) => part.type === 'identifier')?.text;
            if (name !== undefined) {
                result.push([name, encodeArgValue(parts.filter((part) => part.type !== 'label'), prefixes, depth + 1)]);
            }
        } else if (child.type === 'argument') {
            result.push([`#${position}`, encodeArgValue(namedChildren(child), prefixes, depth + 1)]);
            position += 1;
        }
    }
    return result.length > MAX_OBJECT_ARGS ? null : result;
};

const isNameSelector = (selector: Node): boolean => {
    const part = namedChildren(selector)[0];
    return part !== undefined && (part.type === 'unconditional_assignable_selector' || part.type === 'conditional_assignable_selector');
};

const selectorName = (selector: Node): string | null => {
    const part = namedChildren(selector)[0];
    return part === undefined ? null : (namedChildren(part).find((child) => child.type === 'identifier')?.text ?? null);
};

const unwrapParentheses = (nodes: Node[]): Node[] => {
    let current = nodes;
    while (current.length === 1 && current[0]?.type === 'parenthesized_expression') {
        current = namedChildren(current[0]);
    }
    return current;
};

const namedChildren = (node: Node): Node[] => {
    const children: Node[] = [];
    for (let index = 0; index < node.namedChildCount; index += 1) {
        const child = node.namedChild(index);
        if (child !== null) {
            children.push(child);
        }
    }
    return children;
};
