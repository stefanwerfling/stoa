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
    lines.push('');

    if (report.findings.length === 0) {
        lines.push('No findings. (The deterministic rule set is implemented in M3.)');
        return lines.join('\n');
    }

    lines.push(`## Findings (${report.findings.length})`);
    for (const finding of report.findings) {
        lines.push('');
        lines.push(`### ${finding.rule.id} – ${finding.location.file}:${finding.location.range.startLine}`);
        lines.push(`- Observation: ${finding.observation.statement}`);
        lines.push(`- Severity: ${finding.severity} · Confidence: ${finding.confidence}`);
        lines.push(`- Suggestion: ${finding.remediation.suggestion}`);
    }
    return lines.join('\n');
};
