/**
 * Shared WAI-ARIA 1.2 vocabulary and the primitive, markup-neutral predicates
 * over it. Both the HTML adapter (tree-sitter) and the JSX a11y walk (ts-morph)
 * use these so the ARIA knowledge has a single source of truth and the same
 * facts are produced regardless of the surface syntax.
 */

// WAI-ARIA 1.2 concrete (non-abstract) roles. Abstract roles (widget, landmark,
// input, …) are intentionally absent: authors must not use them, so they count
// as invalid. doc-* (DPUB-ARIA) and graphics-* (Graphics-ARIA) module roles are
// accepted by prefix rather than enumerated.
export const ARIA_ROLES: ReadonlySet<string> = new Set([
    'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code',
    'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document',
    'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
    'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio',
    'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
    'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
    'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem'
]);

// WAI-ARIA 1.2 states and properties (the complete aria-* set). Any aria-*
// attribute outside this set is undefined and ignored by assistive tech.
export const ARIA_ATTRIBUTES: ReadonlySet<string> = new Set([
    'aria-activedescendant', 'aria-atomic', 'aria-autocomplete', 'aria-braillelabel', 'aria-brailleroledescription',
    'aria-busy', 'aria-checked', 'aria-colcount', 'aria-colindex', 'aria-colindextext', 'aria-colspan', 'aria-controls',
    'aria-current', 'aria-describedby', 'aria-description', 'aria-details', 'aria-disabled', 'aria-dropeffect',
    'aria-errormessage', 'aria-expanded', 'aria-flowto', 'aria-grabbed', 'aria-haspopup', 'aria-hidden', 'aria-invalid',
    'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-level', 'aria-live', 'aria-modal', 'aria-multiline',
    'aria-multiselectable', 'aria-orientation', 'aria-owns', 'aria-placeholder', 'aria-posinset', 'aria-pressed',
    'aria-readonly', 'aria-relevant', 'aria-required', 'aria-roledescription', 'aria-rowcount', 'aria-rowindex',
    'aria-rowindextext', 'aria-rowspan', 'aria-selected', 'aria-setsize', 'aria-sort', 'aria-valuemax', 'aria-valuemin',
    'aria-valuenow', 'aria-valuetext'
]);

// ARIA states/properties whose value is a token (or token-list) from a fixed
// enumeration. Free-form value types (IDREF(s), string, integer, number) are
// intentionally absent. The literal "undefined" is a valid value for the
// attributes that list it (it means the state does not apply).
export const ENUMERATED_ARIA_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['aria-atomic', new Set(['true', 'false'])],
    ['aria-busy', new Set(['true', 'false'])],
    ['aria-disabled', new Set(['true', 'false'])],
    ['aria-hidden', new Set(['true', 'false'])],
    ['aria-modal', new Set(['true', 'false'])],
    ['aria-multiline', new Set(['true', 'false'])],
    ['aria-multiselectable', new Set(['true', 'false'])],
    ['aria-readonly', new Set(['true', 'false'])],
    ['aria-required', new Set(['true', 'false'])],
    ['aria-checked', new Set(['true', 'false', 'mixed', 'undefined'])],
    ['aria-pressed', new Set(['true', 'false', 'mixed', 'undefined'])],
    ['aria-expanded', new Set(['true', 'false', 'undefined'])],
    ['aria-grabbed', new Set(['true', 'false', 'undefined'])],
    ['aria-selected', new Set(['true', 'false', 'undefined'])],
    ['aria-current', new Set(['page', 'step', 'location', 'date', 'time', 'true', 'false'])],
    ['aria-live', new Set(['off', 'polite', 'assertive'])],
    ['aria-haspopup', new Set(['false', 'true', 'menu', 'listbox', 'tree', 'grid', 'dialog'])],
    ['aria-sort', new Set(['ascending', 'descending', 'none', 'other'])],
    ['aria-orientation', new Set(['horizontal', 'vertical', 'undefined'])],
    ['aria-autocomplete', new Set(['inline', 'list', 'both', 'none'])],
    ['aria-invalid', new Set(['grammar', 'false', 'spelling', 'true'])],
    ['aria-dropeffect', new Set(['copy', 'execute', 'link', 'move', 'none', 'popup'])],
    ['aria-relevant', new Set(['additions', 'removals', 'text', 'all'])]
]);

export const roleTokens = (role: string): string[] => role.trim().split(/\s+/).filter((token) => token.length > 0);

export const hasRoleTokens = (role: string): boolean => roleTokens(role).length > 0;

export const hasValidRole = (role: string): boolean => {
    return roleTokens(role).some((token) => ARIA_ROLES.has(token.toLowerCase()) || token.startsWith('doc-') || token.startsWith('graphics-'));
};

// An aria-* attribute name that is not a defined WAI-ARIA 1.2 state/property.
export const isUnknownAriaName = (name: string): boolean => {
    const lower = name.toLowerCase();
    return lower.startsWith('aria-') && !ARIA_ATTRIBUTES.has(lower);
};

// Whether a token-enumerated ARIA attribute carries a value outside its set.
// Empty values are treated as a default fallback (not invalid).
export const ariaValueIsInvalid = (name: string, value: string): boolean => {
    const allowed = ENUMERATED_ARIA_VALUES.get(name.toLowerCase());
    if (allowed === undefined) {
        return false;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return false;
    }
    return trimmed.toLowerCase().split(/\s+/).some((token) => !allowed.has(token));
};

// A clean, canonical positive-integer literal (tabindex > 0): "5" yes, "0"/"-1"
// no, and non-canonical forms ("007", "1.0", "abc", dynamic) are not judged.
export const isPositiveTabindexLiteral = (raw: string): boolean => {
    const value = raw.trim();
    const parsed = Number.parseInt(value, 10);
    return !Number.isNaN(parsed) && parsed > 0 && String(parsed) === value;
};

// A strict signed-integer tabindex literal (e.g. "0", "-1", "3"), or null when the
// value is not a clean integer ("3px", "abc", "1.0", empty, dynamic). Deliberately
// stricter than Number.parseInt, which would accept "3px" as 3 — a malformed
// tabindex should not be read as focusable; the caller falls back to native
// focusability instead.
export const parseTabindex = (raw: string): number | null => {
    const value = raw.trim();
    if (!/^[+-]?\d+$/.test(value)) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
};
