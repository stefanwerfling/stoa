import {Node, SyntaxKind} from 'ts-morph';
import type {JsxAttribute, JsxElement, JsxOpeningElement, JsxSelfClosingElement, SourceFile} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import type {FactSpec} from '../FactBuilder.js';
import {ariaValueIsInvalid, hasRoleTokens, hasValidRole, isPositiveTabindexLiteral, isUnknownAriaName, parseTabindex} from '../AriaVocabulary.js';
import {contrastViolation} from '../Contrast.js';

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
    const counters = {img: 0, button: 0, field: 0, link: 0, role: 0, ariaAttr: 0, ariaVal: 0, tabindex: 0, ariaHidden: 0, frame: 0, contrast: 0};

    const elements = sourceFile.getDescendants().filter((node) => JSX_ELEMENT_KINDS.includes(node.getKind())) as Array<JsxOpeningElement | JsxSelfClosingElement>;
    elements.sort((a, b) => a.getStart() - b.getStart());

    // Literal htmlFor targets anywhere in the file; a control whose literal id is
    // referenced by a <label htmlFor> is labelled. Dynamic htmlFor is not matched.
    const labelForIds = collectHtmlForLiterals(elements);

    for (const element of elements) {
        const tag = element.getTagNameNode().getText();
        if (!isIntrinsic(tag)) {
            continue;
        }
        const {attrs, hasSpread} = readAttributes(element);
        const range = rangeOf(sourceFile, element);
        const evidence = `<${tag}>`;

        if (tag === 'img' && !hasSpread && !isDecorative(tag, attrs) && !attrs.has('alt')) {
            facts.push(build({kind: 'ui.imageMissingAlt', kindOf: 'statement', symbol: `img#${counters.img}`, range, value: evidence}));
            counters.img += 1;
        }

        // A control is only exempt when aria-hidden; role=presentation/none is
        // ignored by the browser on a focusable element, so it still needs a name.
        if (tag === 'button' && !hasSpread && !isAriaHidden(attrs) && !hasAccessibleName(element, attrs)) {
            facts.push(build({kind: 'ui.controlMissingName', kindOf: 'statement', symbol: `button#${counters.button}`, range, value: evidence}));
            counters.button += 1;
        }

        if (tag === 'a' && attrs.has('href') && !hasSpread && !isAriaHidden(attrs) && !hasAccessibleName(element, attrs)) {
            facts.push(build({kind: 'ui.linkMissingName', kindOf: 'statement', symbol: `link#${counters.link}`, range, value: evidence}));
            counters.link += 1;
        }

        if (isLabelableControl(tag, attrs) && !hasSpread && !isAriaHidden(attrs) && !hasLabel(element, attrs, labelForIds)) {
            facts.push(build({kind: 'ui.controlMissingLabel', kindOf: 'statement', symbol: `field#${counters.field}`, range, value: evidence}));
            counters.field += 1;
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

        if ((tag === 'iframe' || tag === 'frame') && !hasSpread && !isAriaHidden(attrs) && !hasFrameName(attrs)) {
            facts.push(build({kind: 'ui.frameMissingTitle', kindOf: 'statement', symbol: `frame#${counters.frame}`, range, value: evidence}));
            counters.frame += 1;
        }

        // Text/background contrast from a static style={{…}} object literal (the
        // same rule as HTML inline style; dynamic values skipped, no cascade).
        // aria-hidden / role=presentation do not hide text visually, so contrast is
        // judged regardless of them (WCAG 1.4.3 is about visually rendered text).
        {
            const style = jsxStyleDeclarations(element);
            const lowContrast = style === null ? null : contrastViolation(style.declarations, style.vars);
            if (lowContrast !== null) {
                facts.push(build({kind: 'ui.lowContrastText', kindOf: 'statement', symbol: `contrast#${counters.contrast}`, range, value: lowContrast}));
                counters.contrast += 1;
            }
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

// aria-hidden="true" removes the element from the accessibility tree.
// role=presentation/none is NOT treated as hidden (it only strips semantics and is
// ignored on a focusable element); use isDecorative for the image case.
const isAriaHidden = (attrs: Attrs): boolean => attrs.get('aria-hidden') === 'true';

// Whether an image is exempt from needing alt: aria-hidden, or presentation/none on
// this non-focusable element (the ARIA decorative marker, equivalent to alt="").
const isDecorative = (tag: string, attrs: Attrs): boolean => {
    if (isAriaHidden(attrs)) {
        return true;
    }
    const role = attrs.get('role');
    return (role === 'presentation' || role === 'none') && !isFocusable(tag, attrs);
};

// Whether the element can take keyboard focus (statically). A clean integer
// tabIndex wins (>= 0 focusable, negative not); a malformed or dynamic tabIndex is
// ignored. An editing host (contentEditable) is focusable. Otherwise native
// interactivity decides (a link needs href; a hidden input is not focusable).
const isFocusable = (tag: string, attrs: Attrs): boolean => {
    const tabIndex = attrs.get('tabIndex');
    if (typeof tabIndex === 'string') {
        const value = parseTabindex(tabIndex);
        if (value !== null) {
            return value >= 0;
        }
    }
    if (isEditingHost(attrs)) {
        return true;
    }
    if (tag === 'a') {
        return attrs.has('href');
    }
    if (tag === 'input') {
        return (attrs.get('type') ?? 'text') !== 'hidden';
    }
    return NATIVELY_FOCUSABLE.has(tag);
};

// A contentEditable editing host: present with "" (bare), the boolean true, or
// "true" is focusable; "false"/dynamic is not treated as an editing host.
const isEditingHost = (attrs: Attrs): boolean => {
    const value = attrs.get('contentEditable');
    if (value === undefined || value === null) {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === '' || normalized === 'true';
};

// Literal htmlFor values across the file (a <label htmlFor="x">). Dynamic
// htmlFor ({expr}) is not collected — it cannot be matched to a literal id.
const collectHtmlForLiterals = (elements: Array<JsxOpeningElement | JsxSelfClosingElement>): Set<string> => {
    const ids = new Set<string>();
    for (const element of elements) {
        const value = readAttributes(element).attrs.get('htmlFor');
        if (typeof value === 'string' && value.trim().length > 0) {
            ids.add(value);
        }
    }
    return ids;
};

// Whether an attribute contributes text: a non-empty literal, or a dynamic value
// ({expr}) which is assumed to provide text (conservative — avoids false positives).
const attributeProvidesText = (attrs: Attrs, name: string): boolean => {
    const value = attrs.get(name);
    if (value === null) {
        return true;
    }
    return typeof value === 'string' && value.trim().length > 0;
};

// aria-labelledby in JSX: targets cannot be resolved across components/files, so a
// static non-empty value (or a dynamic {expr}) is conservatively treated as a name,
// while an empty value ("") is not. Unlike the HTML adapter, the referenced text is
// not resolved here (documented limitation), so this only rejects the empty case.
const hasLabelledbyName = (attrs: Attrs): boolean => {
    const value = attrs.get('aria-labelledby');
    if (value === undefined) {
        return false;
    }
    if (value === null) {
        return true;
    }
    return value.trim().split(/\s+/).filter((token) => token.length > 0).length > 0;
};

// Accessible name for a button/link: aria-label(ledby)/title, or naming content.
const hasAccessibleName = (element: JsxOpeningElement | JsxSelfClosingElement, attrs: Attrs): boolean => {
    if (attributeProvidesText(attrs, 'aria-label') || hasLabelledbyName(attrs) || attributeProvidesText(attrs, 'title')) {
        return true;
    }
    if (Node.isJsxSelfClosingElement(element)) {
        return false;
    }
    const jsxElement = element.getParentIfKind(SyntaxKind.JsxElement);
    return jsxElement !== undefined && childrenProvideName(jsxElement.getJsxChildren());
};

const childrenProvideName = (children: Node[]): boolean => children.some(childProvidesName);

// Whether a single JSX child contributes an accessible name. A dynamic expression
// ({label}) or a component child could render text, so both are treated as naming.
const childProvidesName = (child: Node): boolean => {
    if (Node.isJsxText(child)) {
        return child.getText().trim().length > 0;
    }
    if (Node.isJsxExpression(child)) {
        return child.getExpression() !== undefined;
    }
    if (Node.isJsxSelfClosingElement(child)) {
        return elementProvidesName(child, undefined);
    }
    if (Node.isJsxElement(child)) {
        return elementProvidesName(child.getOpeningElement(), child);
    }
    if (Node.isJsxFragment(child)) {
        return childrenProvideName(child.getJsxChildren());
    }
    return false;
};

// Whether a nested element contributes a name: a component (may render text), an
// aria-label(ledby)/title, a named image (img/area with alt), an svg (may hold a
// <title>), or — for any other intrinsic — its own naming content.
const elementProvidesName = (opening: JsxOpeningElement | JsxSelfClosingElement, jsxElement: JsxElement | undefined): boolean => {
    const tag = opening.getTagNameNode().getText();
    if (!isIntrinsic(tag)) {
        return true;
    }
    const {attrs} = readAttributes(opening);
    // A child hidden from assistive tech contributes nothing to the name.
    if (isAriaHidden(attrs)) {
        return false;
    }
    if (attributeProvidesText(attrs, 'aria-label') || hasLabelledbyName(attrs) || attributeProvidesText(attrs, 'title')) {
        return true;
    }
    if (tag === 'img' || tag === 'area') {
        const alt = attrs.get('alt');
        return alt === null || (typeof alt === 'string' && alt.trim().length > 0);
    }
    if (tag === 'svg') {
        return true;
    }
    return jsxElement !== undefined && childrenProvideName(jsxElement.getJsxChildren());
};

// <input> types that are not labelable form fields (name comes from value/alt or
// they are not perceivable). A dynamic type is not provably labelable → skipped.
const NON_LABELABLE_INPUT_TYPES: ReadonlySet<string> = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

const isLabelableControl = (tag: string, attrs: Attrs): boolean => {
    if (tag === 'select' || tag === 'textarea') {
        return true;
    }
    if (tag !== 'input') {
        return false;
    }
    const type = attrs.get('type');
    if (type === null) {
        return false;
    }
    return !NON_LABELABLE_INPUT_TYPES.has(type ?? 'text');
};

// A form control is labelled by aria-label(ledby)/title, a wrapping <label>
// ancestor, or a <label htmlFor> pointing at its literal id. A placeholder is
// deliberately not a label. A dynamic id is not matched (so not falsely flagged).
const hasLabel = (element: JsxOpeningElement | JsxSelfClosingElement, attrs: Attrs, labelForIds: ReadonlySet<string>): boolean => {
    if (attributeProvidesText(attrs, 'aria-label') || hasLabelledbyName(attrs) || attributeProvidesText(attrs, 'title')) {
        return true;
    }
    const id = attrs.get('id');
    if (id === null) {
        // A dynamic id ({id}) may be the target of a dynamic <label htmlFor={id}>
        // that cannot be matched statically — treat as possibly labelled, not flagged.
        return true;
    }
    if (typeof id === 'string' && labelForIds.has(id)) {
        return true;
    }
    return isWrappedInLabel(element);
};

const isWrappedInLabel = (element: Node): boolean => {
    let node = element.getParent();
    while (node !== undefined) {
        if (Node.isJsxElement(node) && node.getOpeningElement().getTagNameNode().getText() === 'label') {
            return true;
        }
        node = node.getParent();
    }
    return false;
};

const hasFrameName = (attrs: Attrs): boolean => {
    const title = attrs.get('title');
    const label = attrs.get('aria-label');
    return (typeof title === 'string' && title.trim().length > 0)
        || (typeof label === 'string' && label.trim().length > 0)
        || hasLabelledbyName(attrs);
};

// React style-object property names mapped to the CSS property names the shared
// contrast utilities expect. Only the ones the contrast check needs are mapped.
const CSS_PROPERTY: ReadonlyMap<string, string> = new Map([
    ['color', 'color'], ['background', 'background'], ['backgroundColor', 'background-color'],
    ['fontSize', 'font-size'], ['fontWeight', 'font-weight']
]);

// Static declarations + custom properties from a style={{…}} object literal.
// Returns null when there is no such literal; dynamic/spread/computed entries are
// simply omitted (treated as not statically known), never guessed.
const jsxStyleDeclarations = (element: JsxOpeningElement | JsxSelfClosingElement): {declarations: Map<string, string>; vars: Map<string, string>} | null => {
    const styleAttribute = element.getAttributes().find((attribute): attribute is JsxAttribute => Node.isJsxAttribute(attribute) && attribute.getNameNode().getText() === 'style');
    if (styleAttribute === undefined) {
        return null;
    }
    const initializer = styleAttribute.getInitializer();
    if (initializer === undefined || !Node.isJsxExpression(initializer)) {
        return null;
    }
    const expression = initializer.getExpression();
    if (expression === undefined || !Node.isObjectLiteralExpression(expression)) {
        return null;
    }
    const declarations = new Map<string, string>();
    const vars = new Map<string, string>();
    for (const property of expression.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }
        const name = propertyName(property);
        const value = propertyValue(property, name);
        if (name === null || value === null) {
            continue;
        }
        if (name.startsWith('--')) {
            vars.set(name, value);
            continue;
        }
        const cssProperty = CSS_PROPERTY.get(name);
        if (cssProperty !== undefined) {
            declarations.set(cssProperty, value);
        }
    }
    return {declarations, vars};
};

const propertyName = (property: Node): string | null => {
    if (!Node.isPropertyAssignment(property)) {
        return null;
    }
    const nameNode = property.getNameNode();
    if (Node.isIdentifier(nameNode)) {
        return nameNode.getText();
    }
    if (Node.isStringLiteral(nameNode)) {
        return nameNode.getLiteralValue();
    }
    return null;
};

// A static value for a style property: a string literal, or a number which React
// treats as px for font-size (otherwise ignored). Expressions are not resolved.
const propertyValue = (property: Node, name: string | null): string | null => {
    if (!Node.isPropertyAssignment(property)) {
        return null;
    }
    const initializer = property.getInitializer();
    if (initializer === undefined) {
        return null;
    }
    if (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer)) {
        return initializer.getLiteralText();
    }
    if (Node.isNumericLiteral(initializer) && name === 'fontSize') {
        return `${initializer.getText()}px`;
    }
    return null;
};

const rangeOf = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};
