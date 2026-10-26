import {DEFAULT_LANG, dimensionLabel, labelsFor} from '../i18n/Localized.js';
import type {AnalysisReport} from '../Types.js';

export interface ReportOptions {
    lang?: string;
}

/** Machine-readable report. Stable key order via the fixed object shape. */
export const toJson = (report: AnalysisReport): string => {
    return JSON.stringify(report, null, 2);
};

/** Human-readable summary for the CLI and for sharing (e.g. a PR comment). */
export const toMarkdown = (report: AnalysisReport, options: ReportOptions = {}): string => {
    const lang = options.lang ?? DEFAULT_LANG;
    const t = labelsFor(lang);
    const lines: string[] = [];
    lines.push(`# ${t.title}`);
    lines.push('');
    lines.push(`- ${t.engine}: ${report.versions.engine}`);
    lines.push(`- ${t.ruleSet}: ${report.versions.ruleSet}`);
    lines.push(`- ${t.knowledgeBase}: ${report.versions.knowledgeBase}`);
    lines.push(
        `- ${t.files}: ` +
            `${report.coverage.filesSelected}/${report.coverage.filesAnalyzed}/${report.coverage.filesSkipped}`
    );
    lines.push(`- ${t.facts}: ${report.coverage.factCount}`);
    lines.push('');

    if (report.findings.length === 0) {
        lines.push(t.noFindings);
        return lines.join('\n');
    }

    lines.push(`## ${t.findings} (${report.findings.length})`);
    for (const finding of report.findings) {
        const symbolName = finding.location.symbol ?? '';
        const symbol = symbolName.length > 0 ? ` (${symbolName})` : '';
        const principles = finding.interpretation.principles.map((ref) => ref.name).join(', ');
        const dimensions = finding.interpretation.dimensions.map((dimension) => dimensionLabel(dimension, lang)).join(', ');
        lines.push('');
        lines.push(`### ${finding.rule.id} – ${finding.location.file}:${finding.location.range.startLine}${symbol}`);
        lines.push(`- ${t.observation}: ${finding.observation.statement}`);
        lines.push(`- ${t.severity}: **${finding.severity}** · ${t.confidence}: ${finding.confidence.toFixed(2)} (${finding.certaintyBasis})`);
        lines.push(`- ${t.dimensions}: ${dimensions}`);
        lines.push(`- ${t.interpretation}: ${principles}`);
        lines.push(`- ${t.suggestion}: ${finding.remediation.suggestion}`);
        if (finding.remediation.drawbacks !== undefined) {
            lines.push(`- ${t.drawbacks}: ${finding.remediation.drawbacks}`);
        }
        if (finding.semantic !== undefined) {
            const s = finding.semantic;
            lines.push(`- ${t.llm}: ${s.verdict} (${t.confidence} ${s.confidence.toFixed(2)}) — ${s.rationale} [${s.adapter}]`);
        }
    }
    return lines.join('\n');
};
