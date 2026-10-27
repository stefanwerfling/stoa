import type {CoverageSummary, Finding} from '../Types.js';

/**
 * Builds a human-samplable Markdown report for a real-world accessibility
 * evaluation run. It does NOT compute precision/recall: a real project has no
 * ground truth, so the report deliberately presents counts plus a deterministic
 * sample of findings per rule for a human to verify against an external oracle
 * (axe/Lighthouse/screen-reader + manual review). The builder is pure — the
 * caller supplies the timestamp and elapsed time — so its output is testable.
 */

export interface RealWorldReportInput {
    targetPath: string;
    generatedAt: string;
    engineVersion: string;
    coverage: CoverageSummary;
    findings: readonly Finding[];
    sampleSize: number;
    elapsedMs: number;
}

const A11Y_PREFIX = 'R-A11Y-';

// The UI surface a file belongs to, by extension. .component.html is Angular
// (checked before the generic .html case); the rest map one extension family to
// one surface. Anything else keeps its extension so nothing is silently merged.
export const surfaceOf = (file: string): string => {
    const lower = file.toLowerCase();
    if (lower.endsWith('.component.html')) {
        return 'Angular';
    }
    if (lower.endsWith('.vue')) {
        return 'Vue';
    }
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
        return 'HTML';
    }
    if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
        return 'JSX';
    }
    if (lower.endsWith('.dart')) {
        return 'Flutter/Dart';
    }
    const dot = lower.lastIndexOf('.');
    return dot === -1 ? '(no extension)' : lower.slice(dot);
};

// A total order over findings so the report — and its samples — are deterministic
// regardless of the order the pipeline emitted them in.
const compareFindings = (a: Finding, b: Finding): number => {
    return a.location.file.localeCompare(b.location.file)
        || a.location.range.startLine - b.location.range.startLine
        || a.location.range.startCol - b.location.range.startCol
        || a.rule.id.localeCompare(b.rule.id)
        || (a.location.symbol ?? '').localeCompare(b.location.symbol ?? '');
};

const countBy = (findings: readonly Finding[], key: (f: Finding) => string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const finding of findings) {
        counts.set(key(finding), (counts.get(key(finding)) ?? 0) + 1);
    }
    return counts;
};

// Rows sorted by descending count, then by key for a stable tie-break.
const sortedRows = (counts: ReadonlyMap<string, number>): Array<[string, number]> => {
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const sampleLine = (finding: Finding): string => {
    const {file, range, symbol} = finding.location;
    const where = `${file}:${range.startLine}:${range.startCol}`;
    const name = symbol === undefined ? '' : ` [${symbol}]`;
    const lines = [`- \`${where}\`${name} — ${finding.observation.statement}`];
    const evidence = finding.observation.evidence[0];
    if (evidence !== undefined) {
        lines.push(`  - evidence: \`${evidence.fact}\` = ${JSON.stringify(evidence.value)} (${evidence.certainty})`);
    }
    const caveat = finding.missingContext?.[0];
    if (caveat !== undefined) {
        lines.push(`  - caveat: ${caveat}`);
    }
    return lines.join('\n');
};

export const buildRealWorldReport = (input: RealWorldReportInput): string => {
    const a11y = [...input.findings].filter((f) => f.rule.id.startsWith(A11Y_PREFIX)).sort(compareFindings);
    const bySurface = sortedRows(countBy(a11y, (f) => surfaceOf(f.location.file)));
    const byRule = sortedRows(countBy(a11y, (f) => f.rule.id));

    const out: string[] = [];
    out.push('# stoa — real-world accessibility evaluation', '');
    out.push(`- **Target:** \`${input.targetPath}\``);
    out.push(`- **Generated:** ${input.generatedAt}`);
    out.push(`- **Engine:** ${input.engineVersion}`);
    out.push(`- **Elapsed:** ${input.elapsedMs} ms`, '');

    out.push('## Run health', '');
    out.push('| Metric | Value |', '| --- | --- |');
    out.push(`| Files selected | ${input.coverage.filesSelected} |`);
    out.push(`| Files analyzed | ${input.coverage.filesAnalyzed} |`);
    out.push(`| Files skipped | ${input.coverage.filesSkipped} |`);
    out.push(`| Facts extracted | ${input.coverage.factCount} |`);
    out.push(`| Total findings | ${input.findings.length} |`);
    out.push(`| Accessibility findings | ${a11y.length} |`, '');

    out.push('> These are **counts, not precision.** A real project has no ground truth,');
    out.push('> so each sampled finding below must be classified true/false by a human against');
    out.push('> an external oracle (axe / Lighthouse / a screen reader + manual review).', '');

    out.push('## Accessibility findings by surface', '');
    out.push('| Surface | Findings |', '| --- | --- |');
    for (const [surface, count] of bySurface) {
        out.push(`| ${surface} | ${count} |`);
    }
    if (bySurface.length === 0) {
        out.push('| _(none)_ | 0 |');
    }
    out.push('');

    out.push('## Accessibility findings by rule', '');
    out.push('| Rule | Findings | Sampled |', '| --- | --- | --- |');
    for (const [rule, count] of byRule) {
        out.push(`| ${rule} | ${count} | ${Math.min(count, input.sampleSize)} |`);
    }
    if (byRule.length === 0) {
        out.push('| _(none)_ | 0 | 0 |');
    }
    out.push('');

    out.push(`## Samples (up to ${input.sampleSize} per rule)`, '');
    if (a11y.length === 0) {
        out.push('_No accessibility findings._');
    }
    for (const [rule] of byRule) {
        const forRule = a11y.filter((f) => f.rule.id === rule);
        out.push(`### ${rule} (${forRule.length})`, '');
        for (const finding of forRule.slice(0, input.sampleSize)) {
            out.push(sampleLine(finding));
        }
        out.push('');
    }

    return out.join('\n');
};
