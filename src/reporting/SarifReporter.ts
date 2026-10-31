import {relative} from 'node:path';
import type {AnalysisReport, Finding, Severity, SourceRange} from '../Types.js';

export interface SarifOptions {
    baseDir?: string;
    toolVersion?: string;
    informationUri?: string;
}

// SARIF has four levels; our four severities map onto three of them.
const LEVEL: Record<Severity, string> = {
    high: 'error',
    medium: 'warning',
    low: 'note',
    info: 'note'
};

const toForwardSlashes = (path: string): string => path.split('\\').join('/');

const toUri = (file: string, baseDir: string): string => {
    const rel = relative(baseDir, file);
    return rel.length === 0 ? toForwardSlashes(file) : toForwardSlashes(rel);
};

// SARIF columns are 1-based and must be >= 1; our fact columns are mixed-origin,
// so clamp rather than emit an invalid 0.
const column = (value: number): number => (value < 1 ? 1 : value);

const toRegion = (range: SourceRange): object => ({
    startLine: range.startLine,
    startColumn: column(range.startCol),
    endLine: range.endLine,
    endColumn: column(range.endCol)
});

const messageText = (finding: Finding): string => {
    const principles = finding.interpretation.principles.map((ref) => ref.name).join(', ');
    return (
        `${finding.observation.statement} ` +
        `Possible interpretation (not a fact): ${principles}. ` +
        `Suggestion: ${finding.remediation.suggestion}`
    );
};

// SARIF's own baselineState vocabulary ('new'|'unchanged'|'updated'|'absent')
// — 'absent' describes a PRIOR result verified gone, which this reporter does
// not model (fixed findings are surfaced separately in AnalysisReport.baseline,
// never synthesized as a SARIF result with no current location to anchor to).
const SARIF_BASELINE_STATE: Record<'new' | 'known', string> = {new: 'new', known: 'unchanged'};

const toResult = (finding: Finding, baseDir: string, ruleIndex: Map<string, number>): object => ({
    ruleId: finding.rule.id,
    ruleIndex: ruleIndex.get(finding.rule.id) ?? 0,
    level: LEVEL[finding.severity],
    message: {text: messageText(finding)},
    locations: [
        {
            physicalLocation: {
                artifactLocation: {uri: toUri(finding.location.file, baseDir)},
                region: toRegion(finding.location.range)
            }
        }
    ],
    ...(finding.baselineStatus !== undefined && finding.baselineStatus !== 'fixed' ? {baselineState: SARIF_BASELINE_STATE[finding.baselineStatus]} : {}),
    properties: {
        severity: finding.severity,
        confidence: finding.confidence,
        certaintyBasis: finding.certaintyBasis,
        dimensions: finding.interpretation.dimensions,
        principles: finding.interpretation.principles.map((ref) => ref.id),
        ruleSet: finding.ruleSet,
        source: finding.source
    }
});

/**
 * Renders a report as SARIF 2.1.0 for CI / code-hosting (e.g. GitHub Code
 * Scanning). File paths are relativized against baseDir (default cwd) and
 * emitted as forward-slash URIs. Findings keep their order, so output is
 * reproducible for a given baseDir.
 */
export const toSarif = (report: AnalysisReport, options: SarifOptions = {}): string => {
    const baseDir = options.baseDir ?? process.cwd();
    const ruleIds = [...new Set(report.findings.map((finding) => finding.rule.id))].sort();
    const ruleIndex = new Map(ruleIds.map((id, index) => [id, index]));
    const rules = ruleIds.map((id) => ({id, name: id}));
    const results = report.findings.map((finding) => toResult(finding, baseDir, ruleIndex));

    const sarif = {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: {
                    driver: {
                        name: 'stoa',
                        version: options.toolVersion ?? report.versions.engine,
                        informationUri: options.informationUri ?? 'https://stoa.dev',
                        rules
                    }
                },
                results
            }
        ]
    };
    return JSON.stringify(sarif, null, 2);
};
