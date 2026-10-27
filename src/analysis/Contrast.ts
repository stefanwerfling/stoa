/**
 * Pure, deterministic colour and WCAG-contrast utilities. No rendering, no CSS
 * cascade: these operate only on colour values that are literally present (an
 * inline style, with var() resolved against the same declaration block). Anything
 * that would require the rendered page — inheritance, stylesheet rules, images
 * behind text, alpha over an unknown backdrop — is left to the caller to skip.
 */

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

// A small set of common CSS named colours. An unknown name returns null so the
// caller skips rather than guesses — no made-up colour values.
const NAMED_COLORS: ReadonlyMap<string, string> = new Map([
    ['black', '#000000'], ['white', '#ffffff'], ['red', '#ff0000'], ['green', '#008000'], ['blue', '#0000ff'],
    ['gray', '#808080'], ['grey', '#808080'], ['silver', '#c0c0c0'], ['maroon', '#800000'], ['yellow', '#ffff00'],
    ['olive', '#808000'], ['lime', '#00ff00'], ['teal', '#008080'], ['aqua', '#00ffff'], ['cyan', '#00ffff'],
    ['navy', '#000080'], ['fuchsia', '#ff00ff'], ['magenta', '#ff00ff'], ['purple', '#800080'], ['orange', '#ffa500'],
    ['transparent', 'transparent']
]);

// Parse a CSS declaration block ("a: b; c: d") into a lowercased-property map.
export const parseStyleDeclarations = (style: string): Map<string, string> => {
    const declarations = new Map<string, string>();
    for (const part of style.split(';')) {
        const colon = part.indexOf(':');
        if (colon === -1) {
            continue;
        }
        const property = part.slice(0, colon).trim().toLowerCase();
        const value = part.slice(colon + 1).trim();
        if (property.length > 0 && value.length > 0) {
            declarations.set(property, value);
        }
    }
    return declarations;
};

// Resolve a colour value to opaque RGB, or null when it is not a statically known
// opaque colour (unknown name, alpha < 1, unresolved var, a gradient, etc.). var()
// is resolved against `vars` (custom properties from the same declaration block).
export const resolveColor = (value: string, vars: ReadonlyMap<string, string>): Rgb | null => {
    const trimmed = value.trim();
    const variable = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(trimmed);
    if (variable !== null) {
        const referenced = variable[1] !== undefined ? vars.get(variable[1]) : undefined;
        const fallback = variable[2];
        if (referenced !== undefined) {
            return resolveColor(referenced, vars);
        }
        return fallback !== undefined ? resolveColor(fallback, vars) : null;
    }
    const named = NAMED_COLORS.get(trimmed.toLowerCase());
    if (named !== undefined) {
        return named === 'transparent' ? null : resolveColor(named, vars);
    }
    if (trimmed.startsWith('#')) {
        return parseHex(trimmed);
    }
    if (trimmed.toLowerCase().startsWith('rgb')) {
        return parseRgb(trimmed);
    }
    return null;
};

const parseHex = (hex: string): Rgb | null => {
    const body = hex.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(body)) {
        return {r: expand(body[0]!), g: expand(body[1]!), b: expand(body[2]!)};
    }
    if (/^[0-9a-fA-F]{6}$/.test(body)) {
        return {r: hexPair(body, 0), g: hexPair(body, 2), b: hexPair(body, 4)};
    }
    // #RGBA / #RRGGBBAA: a translucent colour cannot be judged over an unknown
    // backdrop, so it is treated as not statically known.
    return null;
};

const expand = (digit: string): number => Number.parseInt(digit + digit, 16);
const hexPair = (body: string, index: number): number => Number.parseInt(body.slice(index, index + 2), 16);

const parseRgb = (value: string): Rgb | null => {
    const match = /^rgba?\(\s*([^)]+)\)$/i.exec(value.trim());
    if (match === null || match[1] === undefined) {
        return null;
    }
    const parts = match[1].split(/[,/\s]+/).filter((piece) => piece.length > 0);
    if (parts.length < 3) {
        return null;
    }
    if (parts.length >= 4 && Number.parseFloat(parts[3]!) < 1) {
        return null;
    }
    const channels = parts.slice(0, 3).map(channel);
    if (channels.some((value_) => value_ === null)) {
        return null;
    }
    return {r: channels[0]!, g: channels[1]!, b: channels[2]!};
};

const channel = (raw: string): number | null => {
    if (raw.endsWith('%')) {
        const percent = Number.parseFloat(raw);
        return Number.isNaN(percent) ? null : clampByte(Math.round((percent / 100) * 255));
    }
    const value = Number.parseFloat(raw);
    return Number.isNaN(value) ? null : clampByte(Math.round(value));
};

const clampByte = (value: number): number => Math.max(0, Math.min(255, value));

const relativeLuminance = ({r, g, b}: Rgb): number => {
    const channels = [r, g, b].map((value) => {
        const srgb = value / 255;
        return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

// WCAG 2.x contrast ratio, in [1, 21].
export const contrastRatio = (a: Rgb, b: Rgb): number => {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
};

// The WCAG 1.4.3 AA threshold for the given inline font: 3:1 for large text
// (>= 24px, or >= 18.66px when bold), otherwise 4.5:1. Absent size ⇒ normal text.
export const contrastThreshold = (declarations: ReadonlyMap<string, string>): number => {
    const sizePx = fontSizePx(declarations.get('font-size'));
    const weight = declarations.get('font-weight') ?? '';
    const bold = weight === 'bold' || weight === 'bolder' || Number.parseInt(weight, 10) >= 700;
    if (sizePx !== null && (sizePx >= 24 || (bold && sizePx >= 18.66))) {
        return 3;
    }
    return 4.5;
};

const fontSizePx = (raw: string | undefined): number | null => {
    if (raw === undefined) {
        return null;
    }
    const match = /^(\d+(?:\.\d+)?)(px|pt)$/.exec(raw.trim());
    if (match === null) {
        return null;
    }
    const value = Number.parseFloat(match[1]!);
    return match[2] === 'pt' ? value * (96 / 72) : value;
};

export const formatRatio = (ratio: number): string => `${(Math.round(ratio * 100) / 100).toFixed(2)}:1`;

// A description like `2.85:1 (needs 4.5:1)` when the declarations pair a text
// colour and a background colour whose contrast is below the WCAG 1.4.3 AA
// threshold; null when either colour is absent or not statically resolvable. The
// declarations and vars are surface-neutral: the HTML adapter builds them from an
// inline style string, the JSX walk from a style={{…}} object literal.
export const contrastViolation = (declarations: ReadonlyMap<string, string>, vars: ReadonlyMap<string, string>): string | null => {
    const foregroundValue = declarations.get('color');
    const backgroundValue = declarations.get('background-color') ?? declarations.get('background');
    if (foregroundValue === undefined || backgroundValue === undefined) {
        return null;
    }
    const foreground = resolveColor(foregroundValue, vars);
    const background = resolveColor(backgroundValue, vars);
    if (foreground === null || background === null) {
        return null;
    }
    const ratio = contrastRatio(foreground, background);
    const threshold = contrastThreshold(declarations);
    return ratio < threshold ? `${formatRatio(ratio)} (needs ${formatRatio(threshold)})` : null;
};
