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

    let imageIndex = 0;
    let buttonIndex = 0;
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
        }
    }

    return facts;
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
