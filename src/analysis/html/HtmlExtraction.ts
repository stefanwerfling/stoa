import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange} from '../../Types.js';
import {factBuilder, type AdapterInfo} from '../FactBuilder.js';

/**
 * Extracts verifiable UI accessibility facts from a static HTML tree
 * (tree-sitter-html, in-process WASM). It reports only what is statically
 * decidable from the markup — no rendering, no CSS cascade, no contrast. Each
 * fact names a concrete element and the evidence (its start tag); the a11y rules
 * interpret these facts. Checks are deliberately context-aware: a decorative
 * image (alt="") or an aria-hidden element is not a violation.
 */

export const extractFacts = (root: Node, content: string, filePath: string, info: AdapterInfo): Fact[] => {
    const facts: Fact[] = [];
    const build = factBuilder(info, filePath);
    const lines = content.split('\n');

    facts.push(build({kind: 'file.lineCount', kindOf: 'file', range: fileRange(lines), value: lineCount(content)}));

    // The ids referenced by <label for="..."> anywhere in the document; needed to
    // decide whether a form control has an associated label.
    const labelForIds = labelTargets(root);

    let imageIndex = 0;
    let buttonIndex = 0;
    let fieldIndex = 0;
    let linkIndex = 0;
    let ariaHiddenIndex = 0;
    let roleIndex = 0;
    for (const element of descendants(root, 'element')) {
        const startTag = startTagOf(element);
        if (startTag === null) {
            continue;
        }
        const tag = tagName(startTag);
        const attrs = attributes(startTag);

        if (tag === 'img') {
            const symbol = `img#${imageIndex}`;
            imageIndex += 1;
            // alt="" is a valid decorative image; aria-hidden / role=presentation
            // remove the image from the accessibility tree — none is a violation.
            if (!attrs.has('alt') && !isHiddenFromA11y(attrs)) {
                facts.push(build({kind: 'ui.imageMissingAlt', kindOf: 'statement', symbol, range: rangeOf(startTag), value: evidence(startTag)}));
            }
        } else if (tag === 'button') {
            const symbol = `button#${buttonIndex}`;
            buttonIndex += 1;
            if (!isHiddenFromA11y(attrs) && !hasAccessibleName(element, attrs)) {
                facts.push(build({kind: 'ui.controlMissingName', kindOf: 'statement', symbol, range: rangeOf(startTag), value: evidence(startTag)}));
            }
        } else if (isLabelableControl(tag, attrs)) {
            const symbol = `field#${fieldIndex}`;
            fieldIndex += 1;
            if (!isHiddenFromA11y(attrs) && !hasLabel(element, attrs, labelForIds)) {
                facts.push(build({kind: 'ui.controlMissingLabel', kindOf: 'statement', symbol, range: rangeOf(startTag), value: evidence(startTag)}));
            }
        } else if (tag === 'a' && attrs.has('href')) {
            // Only an <a> with an href is a link; a bare anchor is not a control.
            const symbol = `link#${linkIndex}`;
            linkIndex += 1;
            if (!isHiddenFromA11y(attrs) && !hasAccessibleName(element, attrs)) {
                facts.push(build({kind: 'ui.linkMissingName', kindOf: 'statement', symbol, range: rangeOf(startTag), value: evidence(startTag)}));
            }
        }

        // Independent of the tag above: a focusable element hidden from assistive
        // tech (aria-hidden="true") stays operable by keyboard yet is announced to
        // nobody — a name/role/value defect. tabindex="-1" removes it from the tab
        // order, so that is correctly hidden and not flagged.
        if (attrs.get('aria-hidden') === 'true' && isFocusable(tag, attrs)) {
            facts.push(build({kind: 'ui.ariaHiddenFocusable', kindOf: 'statement', symbol: `aria-hidden#${ariaHiddenIndex}`, range: rangeOf(startTag), value: evidence(startTag)}));
            ariaHiddenIndex += 1;
        }

        // A non-empty role whose tokens include no valid WAI-ARIA role (a typo or
        // an author-forbidden abstract role) conveys no role at all.
        const role = attrs.get('role');
        if (role !== undefined && hasRoleTokens(role) && !hasValidRole(role)) {
            facts.push(build({kind: 'ui.invalidRole', kindOf: 'statement', symbol: `role#${roleIndex}`, range: rangeOf(startTag), value: `role="${role}"`}));
            roleIndex += 1;
        }
    }

    return facts;
};

// WAI-ARIA 1.2 concrete (non-abstract) roles. Abstract roles (widget, landmark,
// input, …) are intentionally absent: authors must not use them, so they count
// as invalid. doc-* (DPUB-ARIA) and graphics-* (Graphics-ARIA) module roles are
// accepted by prefix rather than enumerated.
const ARIA_ROLES: ReadonlySet<string> = new Set([
    'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code',
    'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document',
    'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
    'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio',
    'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
    'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
    'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem'
]);

const roleTokens = (role: string): string[] => role.trim().split(/\s+/).filter((token) => token.length > 0);

const hasRoleTokens = (role: string): boolean => roleTokens(role).length > 0;

const hasValidRole = (role: string): boolean => {
    return roleTokens(role).some((token) => ARIA_ROLES.has(token.toLowerCase()) || token.startsWith('doc-') || token.startsWith('graphics-'));
};

const NATIVELY_FOCUSABLE: ReadonlySet<string> = new Set(['button', 'select', 'textarea', 'input']);

// Whether the element itself can take keyboard focus (statically). An explicit
// tabindex wins: >= 0 is focusable, negative is not. Otherwise the natively
// interactive elements are focusable (a link needs an href; a hidden input is
// not). Descendant focusability is not assessed (documented limitation).
const isFocusable = (tag: string, attrs: Map<string, string>): boolean => {
    const tabindex = attrs.get('tabindex');
    if (tabindex !== undefined) {
        const value = Number.parseInt(tabindex, 10);
        return !Number.isNaN(value) && value >= 0;
    }
    if (tag === 'a') {
        return attrs.has('href');
    }
    if (tag === 'input') {
        return (attrs.get('type') ?? 'text').toLowerCase() !== 'hidden';
    }
    return NATIVELY_FOCUSABLE.has(tag);
};

// <input> types that are NOT labelable form fields (their name comes from value
// or alt, or they are not perceivable), so the label rule does not apply.
const NON_LABELABLE_INPUT_TYPES: ReadonlySet<string> = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

const isLabelableControl = (tag: string, attrs: Map<string, string>): boolean => {
    if (tag === 'select' || tag === 'textarea') {
        return true;
    }
    if (tag !== 'input') {
        return false;
    }
    return !NON_LABELABLE_INPUT_TYPES.has((attrs.get('type') ?? 'text').toLowerCase());
};

// A form control is labelled if it has an aria-label(ledby)/title, an id that a
// <label for> points at, or a wrapping <label> ancestor. A placeholder is
// deliberately NOT accepted — it is not a label (WCAG). aria-labelledby is
// treated as present but its target is not resolved (documented limitation).
const hasLabel = (element: Node, attrs: Map<string, string>, labelForIds: ReadonlySet<string>): boolean => {
    if ((attrs.get('aria-label') ?? '').trim().length > 0 || attrs.has('aria-labelledby') || (attrs.get('title') ?? '').trim().length > 0) {
        return true;
    }
    const id = attrs.get('id');
    if (id !== undefined && labelForIds.has(id)) {
        return true;
    }
    return hasAncestorTag(element, 'label');
};

const labelTargets = (root: Node): Set<string> => {
    const ids = new Set<string>();
    for (const element of descendants(root, 'element')) {
        const startTag = startTagOf(element);
        if (startTag === null || tagName(startTag) !== 'label') {
            continue;
        }
        const forId = attributes(startTag).get('for');
        if (forId !== undefined && forId.length > 0) {
            ids.add(forId);
        }
    }
    return ids;
};

const hasAncestorTag = (element: Node, wanted: string): boolean => {
    let current = element.parent;
    while (current !== null) {
        if (current.type === 'element') {
            const startTag = startTagOf(current);
            if (startTag !== null && tagName(startTag) === wanted) {
                return true;
            }
        }
        current = current.parent;
    }
    return false;
};

const descendants = (node: Node, types: string | string[]): Node[] => {
    return node.descendantsOfType(types).filter((candidate): candidate is Node => candidate !== null);
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

// Attribute map (lowercased name -> value; boolean attributes map to '').
const attributes = (startTag: Node): Map<string, string> => {
    const result = new Map<string, string>();
    for (const attribute of namedChildren(startTag)) {
        if (attribute.type !== 'attribute') {
            continue;
        }
        const name = namedChildren(attribute).find((child) => child.type === 'attribute_name')?.text.toLowerCase();
        if (name === undefined) {
            continue;
        }
        const quoted = namedChildren(attribute).find((child) => child.type === 'quoted_attribute_value');
        const value = quoted === undefined ? '' : namedChildren(quoted).find((child) => child.type === 'attribute_value')?.text ?? '';
        result.set(name, value);
    }
    return result;
};

const isHiddenFromA11y = (attrs: Map<string, string>): boolean => {
    if (attrs.get('aria-hidden') === 'true') {
        return true;
    }
    const role = attrs.get('role');
    return role === 'presentation' || role === 'none';
};

// Whether a control has an accessible name from any static source: an aria-label
// / aria-labelledby / title, visible descendant text, or a name-bearing child
// (a nested img[alt] or an <svg><title>). This is a static approximation of the
// accessible-name computation — see the adapter's documented limitations.
const hasAccessibleName = (element: Node, attrs: Map<string, string>): boolean => {
    if ((attrs.get('aria-label') ?? '').trim().length > 0 || attrs.has('aria-labelledby') || (attrs.get('title') ?? '').trim().length > 0) {
        return true;
    }
    if (descendants(element, 'text').some((node) => node.text.trim().length > 0)) {
        return true;
    }
    for (const nested of descendants(element, 'element')) {
        const startTag = startTagOf(nested);
        if (startTag === null) {
            continue;
        }
        const tag = tagName(startTag);
        if (tag === 'img' && (attributes(startTag).get('alt') ?? '').trim().length > 0) {
            return true;
        }
        if (tag === 'title' && descendants(nested, 'text').some((node) => node.text.trim().length > 0)) {
            return true;
        }
    }
    return false;
};

const evidence = (startTag: Node): string => {
    const text = startTag.text.replace(/\s+/g, ' ').trim();
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

const rangeOf = (node: Node): SourceRange => {
    return {
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column
    };
};

const fileRange = (lines: string[]): SourceRange => {
    return {startLine: 1, startCol: 0, endLine: Math.max(lines.length, 1), endCol: 0};
};

const lineCount = (content: string): number => {
    return content.length === 0 ? 0 : content.split('\n').length;
};
