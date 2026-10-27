import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange} from '../../Types.js';
import {factBuilder, type AdapterInfo} from '../FactBuilder.js';
import {ariaValueIsInvalid, hasRoleTokens, hasValidRole, isPositiveTabindexLiteral, isUnknownAriaName, parseTabindex} from '../AriaVocabulary.js';
import {contrastViolation, parseStyleDeclarations} from '../Contrast.js';

/**
 * Accessibility extraction for HTML-family **template** languages (Vue SFC,
 * Angular) that share tree-sitter-html but add framework binding syntax. A
 * dialect normalises each raw attribute name into a plain HTML attribute plus a
 * "dynamic" flag, so the same low-false-positive, attribute-based checks the
 * HTML/JSX surfaces use apply here too: a bound value (`:alt`, `[alt]`, `{{…}}`)
 * is treated as present-but-unknown, events/directives are dropped, and
 * value-based checks run only on static literals. Name-computation and
 * document/cross-element rules are intentionally not ported yet (template text
 * and ids are heavily dynamic — a separate, dynamic-aware step).
 */

// A resolved attribute value: a string literal, or null when the value is a
// framework binding / interpolation whose content is not statically known.
export type Attrs = Map<string, string | null>;

export interface BindingDialect {
    // Map a raw template attribute name to a plain attribute + dynamic flag, or
    // null to drop it (events, structural directives, template refs).
    normalize(rawName: string): {name: string; dynamic: boolean} | null;
}

const isIntrinsic = (tag: string): boolean => /^[a-z][a-z0-9-]*$/.test(tag);
const NATIVELY_FOCUSABLE: ReadonlySet<string> = new Set(['button', 'select', 'textarea', 'input']);

export const extractTemplateA11yFacts = (root: Node, content: string, filePath: string, info: AdapterInfo, dialect: BindingDialect): Fact[] => {
    const facts: Fact[] = [];
    const build = factBuilder(info, filePath);
    const lines = content.split('\n');

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(lines), value: lineCount(content)}));

    const counters = {img: 0, role: 0, ariaAttr: 0, ariaVal: 0, tabindex: 0, ariaHidden: 0, frame: 0, contrast: 0};

    for (const element of scopeElements(root)) {
        const startTag = startTagOf(element);
        if (startTag === null) {
            continue;
        }
        const tag = tagName(startTag);
        if (!isIntrinsic(tag)) {
            continue;
        }
        const attrs = readAttributes(startTag, dialect);
        const range = rangeOf(startTag);
        const evidenceText = evidence(startTag);

        if (tag === 'img' && !isDecorative(tag, attrs) && !attrs.has('alt')) {
            facts.push(build({kind: 'ui.imageMissingAlt', kindOf: 'statement', symbol: `img#${counters.img}`, range, value: evidenceText}));
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

        const tabindex = attrs.get('tabindex');
        if (typeof tabindex === 'string' && isPositiveTabindexLiteral(tabindex)) {
            facts.push(build({kind: 'ui.positiveTabindex', kindOf: 'statement', symbol: `tabindex#${counters.tabindex}`, range, value: `tabindex="${tabindex}"`}));
            counters.tabindex += 1;
        }

        if (attrs.get('aria-hidden') === 'true' && isFocusable(tag, attrs)) {
            facts.push(build({kind: 'ui.ariaHiddenFocusable', kindOf: 'statement', symbol: `aria-hidden#${counters.ariaHidden}`, range, value: evidenceText}));
            counters.ariaHidden += 1;
        }

        if ((tag === 'iframe' || tag === 'frame') && !isAriaHidden(attrs) && !hasFrameName(attrs)) {
            facts.push(build({kind: 'ui.frameMissingTitle', kindOf: 'statement', symbol: `frame#${counters.frame}`, range, value: evidenceText}));
            counters.frame += 1;
        }

        // aria-hidden / role=presentation do not hide text visually, so contrast is
        // judged regardless of them (WCAG 1.4.3 is about visually rendered text).
        {
            const lowContrast = contrastFromAttrs(attrs);
            if (lowContrast !== null) {
                facts.push(build({kind: 'ui.lowContrastText', kindOf: 'statement', symbol: `contrast#${counters.contrast}`, range, value: lowContrast}));
                counters.contrast += 1;
            }
        }
    }

    return facts;
};

// Vue/Angular markup to analyse: the elements inside a <template>. A fragment
// with no <template> (e.g. an Angular template file) is analysed whole.
const scopeElements = (root: Node): Node[] => {
    const templates = descendants(root, 'element').filter((element) => {
        const startTag = startTagOf(element);
        return startTag !== null && tagName(startTag) === 'template';
    });
    if (templates.length === 0) {
        return descendants(root, 'element');
    }
    const seen = new Set<number>();
    const scoped: Node[] = [];
    for (const template of templates) {
        for (const element of descendants(template, 'element')) {
            if (!seen.has(element.startIndex)) {
                seen.add(element.startIndex);
                scoped.push(element);
            }
        }
    }
    return scoped;
};

const readAttributes = (startTag: Node, dialect: BindingDialect): Attrs => {
    const attrs: Attrs = new Map();
    for (const attribute of namedChildren(startTag)) {
        if (attribute.type !== 'attribute') {
            continue;
        }
        const rawName = namedChildren(attribute).find((child) => child.type === 'attribute_name')?.text;
        if (rawName === undefined) {
            continue;
        }
        const normalized = dialect.normalize(rawName);
        if (normalized === null) {
            continue;
        }
        const quoted = namedChildren(attribute).find((child) => child.type === 'quoted_attribute_value');
        const literal = quoted === undefined ? '' : namedChildren(quoted).find((child) => child.type === 'attribute_value')?.text ?? '';
        // A binding, or a value carrying an interpolation ({{…}}), is dynamic.
        const dynamic = normalized.dynamic || /\{\{|\}\}/.test(literal);
        attrs.set(normalized.name.toLowerCase(), dynamic ? null : literal);
    }
    return attrs;
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
// tabindex wins (>= 0 focusable, negative not); a malformed or dynamic tabindex is
// ignored. An editing host (contenteditable) is focusable. Otherwise native
// interactivity decides (a link needs href; a hidden input is not focusable).
const isFocusable = (tag: string, attrs: Attrs): boolean => {
    const tabindex = attrs.get('tabindex');
    if (typeof tabindex === 'string') {
        const value = parseTabindex(tabindex);
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

// A contenteditable editing host: present with "" (bare) or "true" is focusable;
// "false"/dynamic is not treated as an editing host.
const isEditingHost = (attrs: Attrs): boolean => {
    const value = attrs.get('contenteditable');
    if (typeof value !== 'string') {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === '' || normalized === 'true';
};

const hasFrameName = (attrs: Attrs): boolean => {
    const title = attrs.get('title');
    const label = attrs.get('aria-label');
    return (typeof title === 'string' && title.trim().length > 0)
        || (typeof label === 'string' && label.trim().length > 0)
        || hasLabelledbyName(attrs);
};

// aria-labelledby in templates: targets are heavily dynamic and not resolved, so a
// static non-empty value (or a binding) is conservatively treated as a name, while
// an empty value ("") is not (documented limitation).
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

const contrastFromAttrs = (attrs: Attrs): string | null => {
    const style = attrs.get('style');
    if (typeof style !== 'string') {
        return null;
    }
    const declarations = parseStyleDeclarations(style);
    const vars = new Map<string, string>();
    for (const [property, value] of declarations) {
        if (property.startsWith('--')) {
            vars.set(property, value);
        }
    }
    return contrastViolation(declarations, vars);
};

const descendants = (node: Node, type: string): Node[] => {
    return node.descendantsOfType(type).filter((candidate): candidate is Node => candidate !== null);
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

const startTagOf = (element: Node): Node | null => {
    return namedChildren(element).find((child) => child.type === 'start_tag' || child.type === 'self_closing_tag') ?? null;
};

const tagName = (startTag: Node): string => {
    return namedChildren(startTag).find((child) => child.type === 'tag_name')?.text.toLowerCase() ?? '';
};

const evidence = (startTag: Node): string => {
    const text = startTag.text.replace(/\s+/g, ' ').trim();
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

const rangeOf = (node: Node): SourceRange => {
    return {startLine: node.startPosition.row + 1, startCol: node.startPosition.column, endLine: node.endPosition.row + 1, endCol: node.endPosition.column};
};

const fileRange = (lines: string[]): SourceRange => {
    return {startLine: 1, startCol: 0, endLine: Math.max(lines.length, 1), endCol: 0};
};

const lineCount = (content: string): number => {
    return content.length === 0 ? 0 : content.split('\n').length;
};
