import {readFileSync} from 'node:fs';
import type {AnalysisResult, Fact, Finding} from '../Types.js';
import {isGrounded} from './Groundedness.js';
import type {SemanticAdapter, SemanticRequest} from './SemanticAdapter.js';

export interface AugmentOptions {
    /** Which findings to send for semantic review. Default: those with missingContext. */
    select?: (finding: Finding) => boolean;
    projectContext?: string;
    /** Injectable file reader (tests); defaults to reading from disk. */
    readFile?: (path: string) => string;
}

const defaultSelect = (finding: Finding): boolean => (finding.missingContext?.length ?? 0) > 0;

const defaultRead = (path: string): string => readFileSync(path, 'utf8');

/**
 * Optional, async post-processing step. It augments selected deterministic
 * findings with a grounded LLM verdict, leaving the deterministic report
 * otherwise untouched (observation, severity, confidence are never changed).
 * The no-op adapter and any ungrounded or failed verdict leave a finding as-is,
 * so the engine degrades gracefully when no LLM is available.
 */
export const augmentWithSemantics = async (
    result: AnalysisResult,
    adapter: SemanticAdapter,
    options: AugmentOptions = {}
): Promise<AnalysisResult> => {
    if (adapter.id === 'noop') {
        return result;
    }

    const select = options.select ?? defaultSelect;
    const read = options.readFile ?? defaultRead;
    const projectContext = options.projectContext ?? '';

    const findings: Finding[] = [];
    for (const finding of result.report.findings) {
        if (!select(finding)) {
            findings.push(finding);
            continue;
        }

        const request = buildRequest(finding, result.facts, read, projectContext);
        if (request === null) {
            findings.push(finding);
            continue;
        }

        const verdict = await assessSafely(adapter, request);
        if (verdict === null || !isGrounded(verdict, request)) {
            findings.push(finding);
            continue;
        }

        findings.push({
            ...finding,
            semantic: {
                adapter: adapter.id,
                verdict: verdict.verdict,
                rationale: verdict.rationale,
                citations: verdict.citations,
                confidence: verdict.confidence
            }
        });
    }

    return {report: {...result.report, findings}, facts: result.facts};
};

const assessSafely = async (adapter: SemanticAdapter, request: SemanticRequest) => {
    try {
        return await adapter.assess(request);
    } catch {
        // No LLM available / network error: skip augmentation, keep the finding.
        return null;
    }
};

const buildRequest = (
    finding: Finding,
    allFacts: Fact[],
    read: (path: string) => string,
    projectContext: string
): SemanticRequest | null => {
    const principle = finding.interpretation.principles[0];
    if (principle === undefined) {
        return null;
    }

    let content: string;
    try {
        content = read(finding.location.file);
    } catch {
        return null;
    }

    const snippet = extractSnippet(content, finding.location.range.startLine, finding.location.range.endLine);
    const facts = allFacts.filter(
        (fact) =>
            fact.subject.file === finding.location.file &&
            fact.subject.range.startLine === finding.location.range.startLine
    );

    return {
        codeSnippet: snippet,
        facts,
        principleId: principle.id,
        principleName: principle.name,
        observation: finding.observation.statement,
        projectContext
    };
};

const extractSnippet = (content: string, startLine: number, endLine: number): string => {
    const lines = content.split('\n');
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, Math.max(start, endLine));
    return lines.slice(start - 1, end).join('\n');
};
