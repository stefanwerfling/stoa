import {DEFAULT_LANG, dimensionLabel, labelsFor, type ReportLabels} from '../i18n/Localized.js';
import {IDENTITY_KINDS} from '../FindingIdentity.js';
import type {AnalysisReport, ArchitectureSummary, BaselineSummary, Finding} from '../Types.js';

export interface ReportOptions {
    lang?: string;
}

/** Machine-readable report. Stable key order via the fixed object shape. */
export const toJson = (report: AnalysisReport): string => {
    return JSON.stringify(report, null, 2);
};

/** The architecture summary (E5b): one line with the layer sizes, one per configuration warning; nothing without a config. */
/** The baseline summary line; an identity collision is named, since it makes the new/known status unreliable. */
const baselineLine = (summary: BaselineSummary, t: ReportLabels): string => {
    const collisions = summary.duplicateIdentities?.length ?? 0;
    const counts = `${summary.newCount} ${t.baselineNew}, ${summary.knownCount} ${t.baselineKnown}, ${summary.fixedCount} ${t.baselineFixed}`;
    return `- ${t.baseline}: ${counts}${collisions > 0 ? `, ${collisions} ${t.baselineCollisions}` : ''}`;
};

/** How many dropped migration entries the Markdown report lists; the JSON report has all. */
const MIGRATION_LIST_LIMIT = 20;

/** A baseline migration of this run: one line of counts per outcome, then the entries not carried over. */
const migrationLines = (summary: BaselineSummary, t: ReportLabels): string[] => {
    const migration = summary.migration;
    if (migration === undefined) {
        return [];
    }
    const label = {notReproducible: t.migrationNotReproducible, ambiguous: t.migrationAmbiguous, duplicate: t.migrationDuplicate};
    const counts = [
        `${migration.matched} ${t.migrationMatched} (${migration.renamed.length} ${t.migrationRenamed})`,
        `${migration.notReproducible} ${label.notReproducible}`,
        `${migration.ambiguous} ${label.ambiguous}`,
        `${migration.duplicate} ${label.duplicate}`
    ];
    const more = migration.dropped.length - MIGRATION_LIST_LIMIT;
    return [
        `  - ${t.migrated} ${migration.from} → ${migration.to}: ${counts.join(', ')}`,
        ...migration.dropped.slice(0, MIGRATION_LIST_LIMIT).map((item) => `    - ${label[item.outcome]} (${item.reason}): ${item.entry.file} ${item.entry.rule} ${item.entry.symbol}`),
        ...(more > 0 ? [`    - … ${more} ${t.migrationMore}`] : [])
    ];
};

/**
 * How the findings' identities are anchored (FindingIdentity.ts
 * `IdentityKind`), in the fixed kind order, kinds that occur only — so a
 * reader sees at a glance how many rest on a file-level ordinal or on order
 * alone (`fileOrdinal`, `ambiguous`).
 */
const identityLine = (findings: readonly Finding[], t: ReportLabels): string => {
    const counts = new Map<string, number>();
    for (const finding of findings) {
        const kind = finding.location.identityKind ?? '';
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const parts = IDENTITY_KINDS.filter((kind) => counts.has(kind)).map((kind) => `${counts.get(kind) ?? 0} ${kind}`);
    const unknown = counts.get('') ?? 0;
    return `- ${t.identities}: ${[...parts, ...(unknown > 0 ? [`${unknown} ${t.identitiesUnknown}`] : [])].join(', ')}`;
};

const architectureLines = (summary: ArchitectureSummary | undefined, t: ReportLabels): string[] => {
    if (summary === undefined) {
        return [];
    }
    const {layers, unassignedFiles, warnings} = summary;
    return [
        `- ${t.architecture}: ${layers.map((layer) => `${layer.name} ${layer.files}`).join(', ')}; ${unassignedFiles} ${t.architectureUnassigned}`,
        ...(warnings.multipleMatchCount > 0
            ? [`  - ${warnings.multipleMatchCount} ${t.architectureMultiple}: ${warnings.multipleMatchSample.map((entry) => `${entry.file} (${entry.layers.join(', ')})`).join('; ')}`]
            : []),
        ...(warnings.emptyLayers.length > 0 ? [`  - ${t.architectureEmpty}: ${warnings.emptyLayers.join(', ')}`] : []),
        ...(warnings.unknownLayerReferences.length > 0 ? [`  - ${t.architectureUnknownRefs}: ${warnings.unknownLayerReferences.join(', ')}`] : [])
    ];
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
    const statusLabel = {complete: t.statusComplete, partial: t.statusPartial, failed: t.statusFailed}[report.coverage.status];
    lines.push(`- ${t.status}: ${statusLabel}`);
    lines.push(
        `- ${t.files}: ` +
            `${report.coverage.filesSelected}/${report.coverage.filesAnalyzed}/${report.coverage.filesSkipped}`
    );
    lines.push(`- ${t.facts}: ${report.coverage.factCount}`);
    if (report.coverage.status === 'failed' && report.error !== undefined) {
        lines.push(`- ${t.status}: ${report.error}`);
    }
    if (report.baseline !== undefined) {
        lines.push(baselineLine(report.baseline, t), ...migrationLines(report.baseline, t));
    }
    if (report.filter !== undefined) {
        const criteria = [
            ...(report.filter.minConfidence !== undefined ? [`${t.filterMinConfidence} ${report.filter.minConfidence.toFixed(2)}`] : []),
            ...(report.filter.certainty !== undefined ? [`${t.filterCertainty} ${report.filter.certainty.join('/')}`] : []),
            ...(report.filter.excludeExperimental === true ? [t.filterNoExperimental] : [])
        ];
        lines.push(`- ${t.filter}: ${criteria.join(', ')} — ${report.filter.hiddenCount} ${t.filterHidden}`);
    }
    lines.push(...architectureLines(report.architecture, t));
    if (report.findings.length > 0) {
        lines.push(identityLine(report.findings, t));
    }
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
        const baselineTag = finding.baselineStatus !== undefined ? ` [${finding.baselineStatus === 'new' ? t.baselineNew : t.baselineKnown}]` : '';
        const maturityTag = finding.ruleMaturity === 'experimental' ? ` [${t.experimental}]` : '';
        lines.push('');
        lines.push(`### ${finding.rule.id} – ${finding.location.file}:${finding.location.range.startLine}${symbol}${baselineTag}${maturityTag}`);
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
