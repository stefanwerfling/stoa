import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Converts the ROOT `.gitignore` (if present) into picomatch-compatible
 * exclude patterns, merged alongside `StoaConfig.exclude`. Deliberately a
 * narrow, best-effort slice, not a full `.gitignore` implementation:
 *
 * - Only the repository root's own `.gitignore` is read — a `.gitignore` in
 *   a subdirectory is not. Nested-`.gitignore` precedence (a subdirectory
 *   re-including something the root excluded) is real git behavior this
 *   does not attempt to reproduce.
 * - Negation (`!pattern`) is not supported — re-inclusion depends on rule
 *   ORDER interacting with every other exclude, which cannot be modeled
 *   safely as "one more pattern" the way a plain exclude can. Such lines
 *   are skipped, not guessed at.
 * - Each remaining line becomes two picomatch patterns (file and
 *   directory-contents form) using the same depth rules `.gitignore`
 *   itself uses: no `/` → matches at any depth; a leading `/` or any other
 *   `/` → anchored to the repository root (consistent with reading only
 *   the root's own file).
 *
 * This is a correctness-conscious approximation, not a byte-for-byte port
 * of git's own matcher (which also supports `**` within a pattern,
 * bracket character classes with edge cases, etc.) — good enough to catch
 * the common case (ignored directories/extensions) without claiming more
 * than it delivers.
 */
export const gitignorePatterns = (rootPath: string): string[] => {
    const path = join(rootPath, '.gitignore');
    if (!existsSync(path)) {
        return [];
    }
    const lines = readFileSync(path, 'utf8').split('\n');
    const patterns: string[] = [];
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) {
            continue;
        }
        const anchored = line.startsWith('/');
        const withoutLeadingSlash = anchored ? line.slice(1) : line;
        const withoutTrailingSlash = withoutTrailingSlashOf(withoutLeadingSlash);
        const hasInnerSlash = withoutTrailingSlash.includes('/');
        const base = anchored || hasInnerSlash ? withoutTrailingSlash : `**/${withoutTrailingSlash}`;
        patterns.push(base, `${base}/**`);
    }
    return patterns;
};

const withoutTrailingSlashOf = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value);
