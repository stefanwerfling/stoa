import {AdapterRegistry} from './analysis/AdapterRegistry.js';
import {CppAdapter} from './analysis/CppAdapter.js';
import {DartAdapter} from './analysis/DartAdapter.js';
import {HtmlAdapter} from './analysis/HtmlAdapter.js';
import {VueAdapter} from './analysis/VueAdapter.js';
import {PhpAdapter} from './analysis/PhpAdapter.js';
import {TypeScriptAdapter} from './analysis/TypeScriptAdapter.js';
import {TypeDiagnosticsExtractor} from './analysis/typescript/TypeDiagnostics.js';
import {collectFiles} from './Ingestion.js';
import {KnowledgeBase} from './knowledge/KnowledgeBase.js';
import {RuleEngine} from './rules/RuleEngine.js';
import {RuleSet} from './rules/RuleSet.js';
import {DependencyCycleRule} from './rules/project/DependencyCycleRule.js';
import {DeadExportRule} from './rules/project/DeadExportRule.js';
import type {ProjectRule} from './rules/ProjectRule.js';
import {ENGINE_VERSION} from './Version.js';
import type {AnalysisReport, AnalysisResult, Fact, Finding, StoaConfig, VersionStamp} from './Types.js';

export interface AnalyzeOptions {
    rootPath: string;
    knowledgeDir: string;
    ruleSetDir: string;
    config: StoaConfig;
    /** Output language for localized finding text; defaults to 'en'. */
    lang?: string;
    /** Opt-in: run the TypeScript type checker as an external fact source. */
    typecheck?: boolean;
    /** Opt-in: flag exports used nowhere in the analyzed set (whole-project scans only). */
    deadExports?: boolean;
}

const TS_EXTENSIONS: readonly string[] = ['.ts', '.tsx'] as const;


/**
 * Orchestrates the deterministic analysis pipeline:
 * ingest -> extract facts -> evaluate rules -> assemble report. There is no
 * clock, randomness or network on this path, so a run is reproducible for a
 * given input and set of versions (see docs architecture §6).
 */
export const analyze = (options: AnalyzeOptions): AnalysisResult => {
    const registry = new AdapterRegistry()
        .register(new TypeScriptAdapter())
        .register(new PhpAdapter())
        .register(new DartAdapter())
        .register(new CppAdapter())
        .register(new HtmlAdapter())
        .register(new VueAdapter());
    const knowledgeBase = KnowledgeBase.loadFromDirectory(options.knowledgeDir, options.config.knowledgeBase);
    const ruleSet = RuleSet.loadFromDirectory(options.ruleSetDir, options.config.ruleSet);
    const projectRules: ProjectRule[] = [new DependencyCycleRule()];
    if (options.deadExports === true) {
        projectRules.push(new DeadExportRule());
    }
    const ruleEngine = new RuleEngine(knowledgeBase, ruleSet, options.lang ?? 'en', projectRules);

    const files = collectFiles(options.rootPath, {include: options.config.include, exclude: options.config.exclude});

    const typeExtractor = options.typecheck === true ? new TypeDiagnosticsExtractor() : null;

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
        if (typeExtractor !== null && TS_EXTENSIONS.some((ext) => file.path.endsWith(ext))) {
            facts.push(...typeExtractor.extract(file));
        }
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
