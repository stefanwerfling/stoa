import {relative} from 'node:path';
import type {Finding} from './Types.js';

/**
 * A finding reduced to its stable identity: (project-relative file, rule id,
 * symbol). Line/column are deliberately excluded — the symbol already
 * encodes identity (e.g. `handler#0`), and including the exact position
 * would make identity brittle to unrelated line shifts elsewhere in the
 * file. Shared by the golden-corpus evaluator (src/evaluation/Evaluator.ts)
 * and the baseline diff (src/Baseline.ts) — one identity scheme, not two.
 */
export interface FindingKey {
    file: string;
    rule: string;
    symbol: string;
}

export const toForwardSlashes = (path: string): string => path.split('\\').join('/');

export const keyString = (key: FindingKey): string => `${toForwardSlashes(key.file)}::${key.rule}::${key.symbol}`;

/**
 * A produced finding carries an absolute location; relativize it against the
 * analysis root so the identity is stable across machines/checkouts and
 * does not depend on where the scan was launched from.
 */
export const findingKey = (rootDir: string, finding: Finding): FindingKey => ({
    file: toForwardSlashes(relative(rootDir, finding.location.file)),
    rule: finding.rule.id,
    symbol: finding.location.symbol ?? ''
});

/**
 * Call-site identities: each base gets its 0-based occurrence index in the
 * given order (`signIn#0`, `signIn#1`, `build>ListView#0`) — the same `#n`
 * convention the extractors use for anonymous functions (`handler#0`). A
 * rule that can report several sites under one base (one method, one build
 * function) must give each its own identity: two findings sharing (file,
 * rule, symbol) are indistinguishable to the evaluator and the baseline.
 */
export const ordinalSymbols = (bases: readonly string[]): string[] => {
    const seen = new Map<string, number>();
    return bases.map((base) => {
        const index = seen.get(base) ?? 0;
        seen.set(base, index + 1);
        return `${base}#${index}`;
    });
};
