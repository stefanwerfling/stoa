import {Node, SyntaxKind} from 'ts-morph';
import type {JsxAttribute, JsxOpeningElement, JsxSelfClosingElement, SourceFile} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import {ariaValueIsInvalid, hasRoleTokens, hasValidRole, isPositiveTabindexLiteral, isUnknownAriaName} from '../AriaVocabulary.js';

type Build = (spec: FactSpec) => Fact;

// A resolved attribute value: a string when it is a static literal, or null when
// the value is a dynamic JSX expression ({expr}) whose content is not knowable
// statically. Presence (the attribute exists at all) is tracked by the map key.
type Attrs = Map<string, string | null>;

const JSX_ELEMENT_KINDS: readonly SyntaxKind[] = [SyntaxKind.JsxOpeningElement, SyntaxKind.JsxSelfClosingElement];

// Only lowercase, simple intrinsic tags map to real DOM elements. Capitalised
// (<Button/>) or member (<Foo.Bar/>) tags are React components whose
// accessibility lives in their own implementation and is out of scope here.
const isIntrinsic = (tag: string): boolean => /^[a-z][a-z0-9-]*$/.test(tag);

const NATIVELY_FOCUSABLE: ReadonlySet<string> = new Set(['button', 'select', 'textarea', 'input']);

/**
 * Walks the JSX elements of a parsed TS/JS source file and emits the same
 * language-neutral `ui.*` accessibility facts the HTML adapter produces, so the
 * existing a11y rules fire on React/JSX unchanged. Only statically decidable,
 * low-false-positive checks are ported: a dynamic attribute value ({expr}) is
 * treated as "present but unknown", a spread ({...props}) suppresses the
 * missing-attribute checks, and React components are skipped.
 */
export const extractJsxA11yFacts = (sourceFile: SourceFile, build: Build): Fact[] => {
    const facts: Fact[] = [];
    const counters = {img: 0, role: 0, ariaAttr: 0, ariaVal: 0, tabindex: 0, ariaHidden: 0, frame: 0};

    const elements = sourceFile.getDescendants().filter((node) => JSX_ELEMENT_KINDS.includes(node.getKind())) as Array<JsxOpeningElement | JsxSelfClosingElement>;
    elements.sort((a, b) => a.getStart() - b.getStart());

    for (const element of elements) {
        const tag = element.getTagNameNode().getText();
        if (!isIntrinsic(tag)) {
            continue;
        }
        const {attrs, hasSpread} = readAttributes(element);
        const range = rangeOf(sourceFile, element);
        const evidence = `<${tag}>`;

        if (tag === 'img' && !hasSpread && !isHidden(attrs) && !attrs.has('alt')) {
            facts.push(build({kind: 'ui.imageMissingAlt', kindOf: 'statement', symbol: `img#${counters.img}`, range, value: evidence}));
            counters.img += 1;
        }

        const role = attrs.get('role');
        if (typeof role === 'string' && hasRoleTokens(role) && !hasValidRole(role)) {
            facts.push(build({kind: 'ui.invalidRole', kindOf: 'statement', symbol: `role#${counters.role}`, range, value: `role="${role}"`}));
            counters.role += 1;
        }

        const unknown: string[] = [];
        for (const name of attrs.keys()) {
            if (isUnknownAriaName(name)) {
                unknown.push(name.toLowerCase());
            }
        }
        if (unknown.length > 0) {
            facts.push(build({kind: 'ui.unknownAriaAttribute', kindOf: 'statement', symbol: `aria-attr#${counters.ariaAttr}`, range, value: unknown.join(', ')}));
            counters.ariaAttr += 1;
        }

        const invalidValues: string[] = [];
        for (const [name, value] of attrs) {
            if (typeof value === 'string' && ariaValueIsInvalid(name, value)) {
                invalidValues.push(`${name.toLowerCase()}="${value}"`);
            }
        }
        if (invalidValues.length > 0) {
            facts.push(build({kind: 'ui.invalidAriaValue', kindOf: 'statement', symbol: `aria-val#${counters.ariaVal}`, range, value: invalidValues.join(', ')}));
            counters.ariaVal += 1;
        }

        const tabIndex = attrs.get('tabIndex');
        if (typeof tabIndex === 'string' && isPositiveTabindexLiteral(tabIndex)) {
            facts.push(build({kind: 'ui.positiveTabindex', kindOf: 'statement', symbol: `tabindex#${counters.tabindex}`, range, value: `tabindex="${tabIndex}"`}));
            counters.tabindex += 1;
        }

        if (attrs.get('aria-hidden') === 'true' && isFocusable(tag, attrs)) {
            facts.push(build({kind: 'ui.ariaHiddenFocusable', kindOf: 'statement', symbol: `aria-hidden#${counters.ariaHidden}`, range, value: evidence}));
            counters.ariaHidden += 1;
        }

        if ((tag === 'iframe' || tag === 'frame') && !hasSpread && !isHidden(attrs) && !hasFrameName(attrs)) {
            facts.push(build({kind: 'ui.frameMissingTitle', kindOf: 'statement', symbol: `frame#${counters.frame}`, range, value: evidence}));
            counters.frame += 1;
        }
    }

    return facts;
};

const readAttributes = (element: JsxOpeningElement | JsxSelfClosingElement): {attrs: Attrs; hasSpread: boolean} => {
    const attrs: Attrs = new Map();
    let hasSpread = false;
    for (const attribute of element.getAttributes()) {
        if (Node.isJsxSpreadAttribute(attribute)) {
            hasSpread = true;
            continue;
        }
        if (Node.isJsxAttribute(attribute)) {
            attrs.set(attribute.getNameNode().getText(), attributeValue(attribute));
        }
    }
    return {attrs, hasSpread};
};

// The static value of a JSX attribute, or null when it is a dynamic expression.
// A bare attribute (<input disabled/>) is the boolean true shorthand.
const attributeValue = (attribute: JsxAttribute): string | null => {
    const initializer = attribute.getInitializer();
    if (initializer === undefined) {
        return 'true';
    }
    if (Node.isStringLiteral(initializer)) {
        return initializer.getLiteralValue();
    }
    if (Node.isJsxExpression(initializer)) {
        const expression = initializer.getExpression();
        if (expression === undefined) {
            return null;
        }
        if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
            return expression.getLiteralText();
        }
        if (expression.getKind() === SyntaxKind.TrueKeyword) {
            return 'true';
        }
        if (expression.getKind() === SyntaxKind.FalseKeyword) {
            return 'false';
        }
        if (Node.isNumericLiteral(expression)) {
            return expression.getText();
        }
    }
    return null;
};

const isHidden = (attrs: Attrs): boolean => {
    if (attrs.get('aria-hidden') === 'true') {
        return true;
    }
    const role = attrs.get('role');
    return role === 'presentation' || role === 'none';
};

// Whether the element can take keyboard focus (statically). A literal tabIndex
// wins (>= 0 focusable, negative not); a dynamic tabIndex is ignored and the
// native interactivity is used (a link needs href; a hidden input is not focusable).
const isFocusable = (tag: string, attrs: Attrs): boolean => {
    const tabIndex = attrs.get('tabIndex');
    if (typeof tabIndex === 'string') {
        const value = Number.parseInt(tabIndex.trim(), 10);
        if (!Number.isNaN(value)) {
            return value >= 0;
        }
    }
    if (tag === 'a') {
        return attrs.has('href');
    }
    if (tag === 'input') {
        return (attrs.get('type') ?? 'text') !== 'hidden';
    }
    return NATIVELY_FOCUSABLE.has(tag);
};

const hasFrameName = (attrs: Attrs): boolean => {
    const title = attrs.get('title');
    const label = attrs.get('aria-label');
    return (typeof title === 'string' && title.trim().length > 0)
        || (typeof label === 'string' && label.trim().length > 0)
        || attrs.has('aria-labelledby');
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};
