import {AdapterRegistry} from './analysis/AdapterRegistry.js';
import {TypeScriptAdapter} from './analysis/TypeScriptAdapter.js';
import {collectFiles} from './Ingestion.js';
import {KnowledgeBase} from './knowledge/KnowledgeBase.js';
import {RuleEngine} from './rules/RuleEngine.js';
import {RuleSet} from './rules/RuleSet.js';
import {ENGINE_VERSION} from './Version.js';
import type {AnalysisReport, AnalysisResult, Fact, Finding, StoaConfig, VersionStamp} from './Types.js';

export interface AnalyzeOptions {
    rootPath: string;
    knowledgeDir: string;
    ruleSetDir: string;
    config: StoaConfig;
}

const INCLUDE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * Orchestrates the deterministic analysis pipeline:
 * ingest -> extract facts -> evaluate rules -> assemble report. There is no
 * clock, randomness or network on this path, so a run is reproducible for a
 * given input and set of versions (see docs architecture §6).
 */
export const analyze = (options: AnalyzeOptions): AnalysisResult => {
    const registry = new AdapterRegistry().register(new TypeScriptAdapter());
    const knowledgeBase = KnowledgeBase.loadFromDirectory(options.knowledgeDir, options.config.knowledgeBase);
    const ruleSet = RuleSet.loadFromDirectory(options.ruleSetDir, options.config.ruleSet);
    const ruleEngine = new RuleEngine(knowledgeBase, ruleSet);

    const files = collectFiles(options.rootPath, {includeExtensions: INCLUDE_EXTENSIONS});

    const facts: Fact[] = [];
    let analyzed = 0;
    let skipped = 0;
    for (const file of files) {
        const adapter = registry.resolve(file);
        if (adapter === null) {
            skipped += 1;
            continue;
        }

        const parsed = adapter.parse(file);
        if (!parsed.ok) {
            skipped += 1;
            continue;
        }

        facts.push(...adapter.extractFacts(parsed, {rootDir: options.rootPath}));
        analyzed += 1;
    }

    const findings: Finding[] = ruleEngine.evaluate(facts);

    const versions: VersionStamp = {
        engine: ENGINE_VERSION,
        ruleSet: options.config.ruleSet,
        knowledgeBase: options.config.knowledgeBase,
        adapters: registry.versions()
    };

    const report: AnalysisReport = {
        versions,
        coverage: {
            filesSelected: files.length,
            filesAnalyzed: analyzed,
            filesSkipped: skipped,
            factCount: facts.length
        },
        findings
    };

    return {report, facts};
};
