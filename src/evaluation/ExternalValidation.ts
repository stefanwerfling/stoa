import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {findingKey, IDENTITY_SCHEME, keyString, type FindingKey} from '../FindingIdentity.js';
import type {Finding} from '../Types.js';
import {languageOf} from './Evaluator.js';

/**
 * External validation (validation/external/): stoa run over third-party
 * open-source projects pinned to a commit, with findings classified by hand.
 * Kept apart from the two other kinds of test data on purpose:
 * - golden regression corpora (test/corpus, test/fixtures): curated ground
 *   truth, every expected finding listed, run by `npm test`;
 * - dogfooding targets (scripts/compare-targets.json, .stoa/…): own code,
 *   compared run against run, no ground truth;
 * - external validation: someone else's code, NOT ground truth — only the
 *   findings a reviewer actually classified count, and only for them are
 *   precision and recall computed. Nothing here becomes a golden corpus
 *   automatically; that is a decision of its own.
 */

/** A project of the external corpus: where it comes from, the exact commit, its licence, and how stoa analyzes it. */
export interface ExternalManifest {
    name: string;
    /** The language the project is chosen for (the report still splits findings by file). */
    language: string;
    repository: string;
    /** The tag or branch the commit was taken from (informational; `commit` is what is fetched). */
    ref?: string;
    /** Full commit SHA — the fetch checks out exactly this. */
    commit: string;
    license: string;
    /** Where the licence was read (a file in the repository). */
    licenseFile: string;
    /** Sparse checkout patterns (`git sparse-checkout`, no-cone); absent = the whole repository. */
    sparse?: string[];
    /** The directory analyzed, relative to the checkout (default the checkout itself). */
    root?: string;
    /** `entryPoints`: package entry globs relative to `root` (StoaConfig.entryPoints). */
    analyze: {solid?: boolean; deadExports?: boolean; exclude?: string[]; entryPoints?: string[]};
}

/** A reviewer's verdict on one produced finding. */
export type Verdict = 'TP' | 'FP' | 'unclear';

export interface FindingLabel extends FindingKey {
    verdict: Verdict;
    /** Why — what the reviewer checked in the code. */
    reason: string;
}

/** A problem a rule should have reported and did not — found by reading the files of `fnScope`. */
export interface MissedFinding {
    file: string;
    rule: string;
    line: number;
    reason: string;
}

/** The manual review of one project. */
export interface LabelFile {
    /** The finding-identity scheme the labels are keyed by (FindingIdentity.ts). */
    identity: number;
    /** Who classified, and how (a model review must say so). */
    reviewer: string;
    reviewedAt: string;
    /** How the labeled findings were chosen (e.g. the deterministic sample, N per rule). */
    sampling: string;
    labels: FindingLabel[];
    /**
     * Files read in full for missed findings: every finding stoa produces in
     * them must be labeled, and every miss is listed in `falseNegatives`.
     * Recall is computed over these files only.
     */
    fnScope: {files: string[]; rules: string[]};
    falseNegatives: MissedFinding[];
}

/** Counts of one rule (or language, or project) — precision/recall `null` when nothing was classified that could support them. */
export interface ValidationRow {
    key: string;
    produced: number;
    reviewed: number;
    truePositives: number;
    falsePositives: number;
    unclear: number;
    falseNegatives: number;
    precision: number | null;
    recall: number | null;
}

export interface ValidationSummary {
    total: ValidationRow;
    byRule: ValidationRow[];
    byLanguage: ValidationRow[];
    /** Labels whose identity the run no longer produces — stale (the code or stoa changed); counted nowhere else. */
    stale: FindingKey[];
}

const VERDICTS: readonly Verdict[] = ['TP', 'FP', 'unclear'];

const fail = (path: string, message: string): never => {
    throw new Error(`${path}: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (path: string, record: Record<string, unknown>, field: string, where: string): string => {
    const value = record[field];
    if (typeof value !== 'string' || value === '') {
        fail(path, `${where}: "${field}" must be a non-empty string`);
    }
    return String(value);
};

/** Reads and checks a label file: well-formed entries, each identity labeled once, labels under the running identity scheme. */
export const loadLabels = (path: string): LabelFile => {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(raw)) {
        return fail(path, 'expected a JSON object');
    }
    if (raw.identity !== IDENTITY_SCHEME) {
        fail(path, `"identity" must be ${IDENTITY_SCHEME} (the running finding-identity scheme), got ${JSON.stringify(raw.identity)}`);
    }
    const labels = Array.isArray(raw.labels) ? raw.labels : fail(path, '"labels" must be an array');
    const seen = new Set<string>();
    const checkedLabels = labels.map((entry, index): FindingLabel => {
        if (!isRecord(entry)) {
            return fail(path, `labels[${index}] must be an object`);
        }
        const where = `labels[${index}]`;
        const verdict = VERDICTS.find((candidate) => candidate === entry.verdict) ?? fail(path, `${where}: "verdict" must be TP, FP or unclear`);
        if (typeof entry.symbol !== 'string') {
            fail(path, `${where}: "symbol" must be a string`);
        }
        const label = {file: text(path, entry, 'file', where), rule: text(path, entry, 'rule', where), symbol: String(entry.symbol), verdict, reason: text(path, entry, 'reason', where)};
        const key = keyString(label);
        if (seen.has(key)) {
            fail(path, `${where}: ${key} is labeled twice`);
        }
        seen.add(key);
        return label;
    });
    const scope = isRecord(raw.fnScope) ? raw.fnScope : fail(path, '"fnScope" must be an object');
    const strings = (value: unknown, field: string): string[] =>
        Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.map(String) : fail(path, `"${field}" must be an array of strings`);
    const misses = Array.isArray(raw.falseNegatives) ? raw.falseNegatives : fail(path, '"falseNegatives" must be an array');
    return {
        identity: IDENTITY_SCHEME,
        reviewer: text(path, raw, 'reviewer', 'file'),
        reviewedAt: text(path, raw, 'reviewedAt', 'file'),
        sampling: text(path, raw, 'sampling', 'file'),
        labels: checkedLabels,
        fnScope: {files: strings(scope.files, 'fnScope.files'), rules: strings(scope.rules, 'fnScope.rules')},
        falseNegatives: misses.map((entry, index): MissedFinding => {
            if (!isRecord(entry) || typeof entry.line !== 'number') {
                return fail(path, `falseNegatives[${index}] must be {file, rule, line, reason}`);
            }
            return {file: text(path, entry, 'file', `falseNegatives[${index}]`), rule: text(path, entry, 'rule', `falseNegatives[${index}]`), line: entry.line, reason: text(path, entry, 'reason', `falseNegatives[${index}]`)};
        })
    };
};

/** A stable pseudo-random rank of an identity: the sample does not follow file order, and the same findings always give the same sample. */
const rank = (key: FindingKey): string => createHash('sha256').update(keyString(key)).digest('hex');

/** Up to `perRule` findings of every rule, chosen by `rank` — the deterministic review sample. */
export const sampleFindings = (findings: readonly Finding[], rootDir: string, perRule: number): FindingKey[] => {
    const byRule = new Map<string, FindingKey[]>();
    for (const finding of findings) {
        const key = findingKey(rootDir, finding);
        byRule.set(key.rule, [...(byRule.get(key.rule) ?? []), key]);
    }
    return [...byRule.keys()].sort().flatMap((rule) => (byRule.get(rule) ?? []).sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, perRule));
};

const ratio = (hit: number, other: number): number | null => (hit + other === 0 ? null : hit / (hit + other));

/**
 * Checks a review against a run and counts it. Precision is over the
 * classified findings (TP and FP; `unclear` counted apart); recall only over
 * the files of `fnScope`, where every produced finding must be classified —
 * an unlabeled one there is an error, not a silent gap. Nothing is
 * extrapolated to the findings nobody reviewed.
 */
export const summarizeValidation = (findings: readonly Finding[], labels: LabelFile, rootDir: string): ValidationSummary => {
    const produced = findings.map((finding) => findingKey(rootDir, finding));
    const producedKeys = new Set(produced.map(keyString));
    const labelByKey = new Map(labels.labels.map((label) => [keyString(label), label]));
    const scopeFiles = new Set(labels.fnScope.files);
    const scopeRules = new Set(labels.fnScope.rules);
    const inScope = (key: {file: string; rule: string}): boolean => scopeFiles.has(key.file) && (scopeRules.has('*') || scopeRules.has(key.rule));
    const unlabeled = produced.filter((key) => inScope(key) && !labelByKey.has(keyString(key)));
    if (unlabeled.length > 0) {
        throw new Error(`every finding in fnScope must be labeled; missing: ${unlabeled.map(keyString).join(', ')}`);
    }
    for (const miss of labels.falseNegatives) {
        if (!inScope(miss)) {
            throw new Error(`false negative ${miss.file}:${miss.line} (${miss.rule}) lies outside fnScope — recall is only defined inside it`);
        }
    }
    const row = (key: string, ofKey: (item: {file: string; rule: string}) => string): ValidationRow => {
        const mine = <T extends {file: string; rule: string}>(items: readonly T[]): T[] => items.filter((item) => key === '' || ofKey(item) === key);
        const live = mine(labels.labels).filter((label) => producedKeys.has(keyString(label)));
        const count = (verdict: Verdict, only?: (label: FindingLabel) => boolean): number => live.filter((label) => label.verdict === verdict && (only === undefined || only(label))).length;
        const falseNegatives = mine(labels.falseNegatives).length;
        return {
            key,
            produced: mine(produced).length,
            reviewed: live.length,
            truePositives: count('TP'),
            falsePositives: count('FP'),
            unclear: count('unclear'),
            falseNegatives,
            precision: ratio(count('TP'), count('FP')),
            recall: ratio(count('TP', inScope), falseNegatives)
        };
    };
    const keys = (of: (item: {file: string; rule: string}) => string): string[] => [...new Set([...produced, ...labels.falseNegatives].map(of))].sort();
    const ruleOf = (item: {rule: string}): string => item.rule;
    const languageOfItem = (item: {file: string}): string => languageOf(item.file);
    return {
        total: row('', ruleOf),
        byRule: keys(ruleOf).map((rule) => row(rule, ruleOf)),
        byLanguage: keys(languageOfItem).map((language) => row(language, languageOfItem)),
        stale: labels.labels.filter((label) => !producedKeys.has(keyString(label))).map(({file, rule, symbol}) => ({file, rule, symbol}))
    };
};
