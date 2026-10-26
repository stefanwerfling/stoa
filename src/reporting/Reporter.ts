import type {AnalysisReport} from '../Types.js';

/** Machine-readable report. Stable key order via the fixed object shape. */
export const toJson = (report: AnalysisReport): string => {
    return JSON.stringify(report, null, 2);
};

/** Human-readable summary for the CLI and for sharing (e.g. a PR comment). */
export const toMarkdown = (report: AnalysisReport): string => {
    const lines: string[] = [];
    lines.push('# stoa – Analysis Report');
    lines.push('');
    lines.push(`- Engine: ${report.versions.engine}`);
    lines.push(`- Rule set: ${report.versions.ruleSet}`);
    lines.push(`- Knowledge base: ${report.versions.knowledgeBase}`);
    lines.push(
        `- Files selected/analyzed/skipped: ` +
            `${report.coverage.filesSelected}/${report.coverage.filesAnalyzed}/${report.coverage.filesSkipped}`
    );
    lines.push(`- Facts extracted: ${report.coverage.factCount}`);
    lines.push('');

    if (report.findings.length === 0) {
        lines.push('No findings.');
        return lines.join('\n');
    }

    lines.push(`## Findings (${report.findings.length})`);
    for (const finding of report.findings) {
        const symbolName = finding.location.symbol ?? '';
        const symbol = symbolName.length > 0 ? ` (${symbolName})` : '';
        const principles = finding.interpretation.principles.map((ref) => ref.name).join(', ');
        lines.push('');
        lines.push(`### ${finding.rule.id} – ${finding.location.file}:${finding.location.range.startLine}${symbol}`);
        lines.push(`- Observation: ${finding.observation.statement}`);
        lines.push(`- Severity: **${finding.severity}** · Confidence: ${finding.confidence.toFixed(2)} (${finding.certaintyBasis})`);
        lines.push(`- Dimensions: ${finding.interpretation.dimensions.join(', ')}`);
        lines.push(`- Possible interpretation (not a fact): ${principles}`);
        lines.push(`- Suggestion: ${finding.remediation.suggestion}`);
        if (finding.remediation.drawbacks !== undefined) {
            lines.push(`- Drawbacks: ${finding.remediation.drawbacks}`);
        }
    }
    return lines.join('\n');
};
