import type {Node} from 'web-tree-sitter';
import type {Fact, SourceRange} from '../../Types.js';
import {factBuilder, type AdapterInfo} from '../FactBuilder.js';
import {ariaValueIsInvalid, hasRoleTokens, hasValidRole, isPositiveTabindexLiteral, isUnknownAriaName} from '../AriaVocabulary.js';

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

    // Every id present in the document; needed to resolve aria-labelledby /
    // aria-describedby references (a reference to an absent id is dangling).
    const documentIds = collectIds(root);

    // id values that occur on more than one element — an id must be unique per
    // the HTML standard, and a duplicate makes reference targets ambiguous.
    const duplicatedIds = findDuplicateIds(root);

    let imageIndex = 0;
    let buttonIndex = 0;
    let fieldIndex = 0;
    let linkIndex = 0;
    let ariaHiddenIndex = 0;
    let roleIndex = 0;
    let ariaAttrIndex = 0;
    let ariaValueIndex = 0;
    let tabindexIndex = 0;
    let htmlIndex = 0;
    let viewportIndex = 0;
    let danglingIdrefIndex = 0;
    let duplicateIdIndex = 0;
    let frameIndex = 0;
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

        // An aria-* attribute whose name is not a defined WAI-ARIA state or
        // property (a typo such as aria-labeledby) is silently ignored by
        // assistive tech — the intended state/relationship never reaches the user.
        const unknownAria = unknownAriaAttributes(attrs);
        if (unknownAria.length > 0) {
            facts.push(build({kind: 'ui.unknownAriaAttribute', kindOf: 'statement', symbol: `aria-attr#${ariaAttrIndex}`, range: rangeOf(startTag), value: unknownAria.join(', ')}));
            ariaAttrIndex += 1;
        }

        // A defined ARIA attribute with a token-enumerated value type carrying a
        // value outside its allowed token set (e.g. aria-hidden="yes") is undefined
        // and ignored — the intended state is not conveyed.
        const invalidValues = invalidAriaValues(attrs);
        if (invalidValues.length > 0) {
            facts.push(build({kind: 'ui.invalidAriaValue', kindOf: 'statement', symbol: `aria-val#${ariaValueIndex}`, range: rangeOf(startTag), value: invalidValues.join(', ')}));
            ariaValueIndex += 1;
        }

        // A positive tabindex (> 0) forces the element ahead of the natural DOM
        // order, producing a focus sequence that disagrees with the reading order
        // and is hard to keep consistent. 0 (focusable, natural order) and negative
        // (programmatically focusable only) are both legitimate.
        const tabindex = attrs.get('tabindex');
        if (tabindex !== undefined && isPositiveTabindexLiteral(tabindex)) {
            facts.push(build({kind: 'ui.positiveTabindex', kindOf: 'statement', symbol: `tabindex#${tabindexIndex}`, range: rangeOf(startTag), value: `tabindex="${tabindex}"`}));
            tabindexIndex += 1;
        }

        // The document's <html> element needs a non-empty lang so assistive tech
        // can pick the right pronunciation/voice. Only flagged when an <html>
        // element is present: a fragment without one may be included into a page
        // that carries the language on its root.
        if (tag === 'html' && (attrs.get('lang') ?? attrs.get('xml:lang') ?? '').trim().length === 0) {
            facts.push(build({kind: 'ui.documentMissingLang', kindOf: 'statement', symbol: `html#${htmlIndex}`, range: rangeOf(startTag), value: evidence(startTag)}));
            htmlIndex += 1;
        }

        // A viewport meta that disables pinch-zoom (user-scalable=no) or caps the
        // zoom below 200% (maximum-scale < 2) stops users from enlarging text.
        if (tag === 'meta' && (attrs.get('name') ?? '').trim().toLowerCase() === 'viewport' && blocksZoom(attrs.get('content') ?? '')) {
            facts.push(build({kind: 'ui.viewportBlocksZoom', kindOf: 'statement', symbol: `viewport#${viewportIndex}`, range: rangeOf(startTag), value: `content="${attrs.get('content') ?? ''}"`}));
            viewportIndex += 1;
        }

        // aria-labelledby / aria-describedby that reference an id absent from the
        // document resolve to nothing, so the accessible name/description the
        // author intended is silently dropped.
        const dangling = danglingIdrefs(attrs, documentIds);
        if (dangling.length > 0) {
            facts.push(build({kind: 'ui.danglingAriaIdref', kindOf: 'statement', symbol: `idref#${danglingIdrefIndex}`, range: rangeOf(startTag), value: dangling.join(', ')}));
            danglingIdrefIndex += 1;
        }

        // Each element carrying an id that is used more than once in the document;
        // the shared id is reported at every occurrence so all sites are visible.
        const elementId = attrs.get('id');
        if (elementId !== undefined && duplicatedIds.has(elementId.trim())) {
            facts.push(build({kind: 'ui.duplicateId', kindOf: 'statement', symbol: `dupid#${duplicateIdIndex}`, range: rangeOf(startTag), value: `id="${elementId}"`}));
            duplicateIdIndex += 1;
        }

        // An iframe/frame needs its own accessible name (title or aria-label[ledby])
        // — its embedded document cannot supply one across the boundary, so without
        // it the frame is announced only as "frame". A hidden frame is exempt.
        if ((tag === 'iframe' || tag === 'frame') && !isHiddenFromA11y(attrs) && !hasFrameName(attrs)) {
            facts.push(build({kind: 'ui.frameMissingTitle', kindOf: 'statement', symbol: `frame#${frameIndex}`, range: rangeOf(startTag), value: evidence(startTag)}));
            frameIndex += 1;
        }
    }

    return facts;
};

// The distinct aria-* attribute names on the element that are not defined ARIA
// states/properties, in document order and de-duplicated by the attribute map.
const unknownAriaAttributes = (attrs: Map<string, string>): string[] => {
    const unknown: string[] = [];
    for (const name of attrs.keys()) {
        if (isUnknownAriaName(name)) {
            unknown.push(name.toLowerCase());
        }
    }
    return unknown;
};

// `name="value"` for each enumerated ARIA attribute whose value is out of range.
// Values with interpolation markers ({ } < $) are skipped as likely template
// output rather than a literal author mistake.
const invalidAriaValues = (attrs: Map<string, string>): string[] => {
    const invalid: string[] = [];
    for (const [name, raw] of attrs) {
        if (/[{}<$]/.test(raw)) {
            continue;
        }
        if (ariaValueIsInvalid(name, raw)) {
            invalid.push(`${name.toLowerCase()}="${raw}"`);
        }
    }
    return invalid;
};

// Whether a viewport `content` string disables zoom: user-scalable=no/0, or a
// clean numeric maximum-scale below 2 (WCAG asks for 200% zoom). Non-numeric or
// dynamic maximum-scale values are not judged.
const blocksZoom = (content: string): boolean => {
    for (const part of content.split(',')) {
        const [rawKey, rawValue] = part.split('=');
        if (rawKey === undefined || rawValue === undefined) {
            continue;
        }
        const key = rawKey.trim().toLowerCase();
        const value = rawValue.trim().toLowerCase();
        if (key === 'user-scalable' && (value === 'no' || value === '0')) {
            return true;
        }
        if (key === 'maximum-scale' && /^\d+(\.\d+)?$/.test(value) && Number.parseFloat(value) < 2) {
            return true;
        }
    }
    return false;
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

const collectIds = (root: Node): Set<string> => {
    const ids = new Set<string>();
    for (const element of descendants(root, 'element')) {
        const startTag = startTagOf(element);
        if (startTag === null) {
            continue;
        }
        const id = attributes(startTag).get('id');
        if (id !== undefined && id.trim().length > 0) {
            ids.add(id.trim());
        }
    }
    return ids;
};

// id values that appear on more than one element in the document.
const findDuplicateIds = (root: Node): Set<string> => {
    const counts = new Map<string, number>();
    for (const element of descendants(root, 'element')) {
        const startTag = startTagOf(element);
        if (startTag === null) {
            continue;
        }
        const id = attributes(startTag).get('id');
        if (id !== undefined && id.trim().length > 0) {
            const key = id.trim();
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    const duplicated = new Set<string>();
    for (const [id, count] of counts) {
        if (count > 1) {
            duplicated.add(id);
        }
    }
    return duplicated;
};

// A frame's accessible name can only come from its own attributes (its embedded
// document is a separate context): a non-empty title or aria-label, or an
// aria-labelledby reference.
const hasFrameName = (attrs: Map<string, string>): boolean => {
    return (attrs.get('title') ?? '').trim().length > 0
        || (attrs.get('aria-label') ?? '').trim().length > 0
        || (attrs.get('aria-labelledby') ?? '').trim().length > 0;
};

// `name="id"` for each aria-labelledby / aria-describedby token that names an id
// not present in the document. Empty references are skipped.
const IDREF_ATTRIBUTES: readonly string[] = ['aria-labelledby', 'aria-describedby'];

const danglingIdrefs = (attrs: Map<string, string>, documentIds: ReadonlySet<string>): string[] => {
    const dangling: string[] = [];
    for (const name of IDREF_ATTRIBUTES) {
        const raw = attrs.get(name);
        if (raw === undefined) {
            continue;
        }
        for (const token of raw.trim().split(/\s+/).filter((part) => part.length > 0)) {
            if (!documentIds.has(token)) {
                dangling.push(`${name}="${token}"`);
            }
        }
    }
    return dangling;
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
