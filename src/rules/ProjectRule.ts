import type {Fact, Finding} from '../Types.js';
import type {KnowledgeBase} from '../knowledge/KnowledgeBase.js';
import type {ModuleGraph} from '../model/ModuleGraph.js';
import type {SymbolGraph} from '../model/SymbolGraph.js';
import type {FlutterWidgetGraph} from '../model/FlutterWidgetGraph.js';

export interface ProjectRuleInput {
    facts: Fact[];
    /**
     * The project-wide module dependency graph (Phase 0), built once by the
     * pipeline from `deps.import` facts + config-aware resolution. OPTIONAL and
     * additive: a rule that does not need it ignores it, and a caller that does
     * not build one (e.g. a focused unit test calling a rule directly) omits
     * it — such a rule must still work, falling back to its own fact-derived
     * graph. See `DependencyCycleRule` for the fallback pattern.
     */
    moduleGraph?: ModuleGraph;
    /**
     * The project-wide cross-file symbol graph (Phase 1), built once by the
     * pipeline from `deps.importName` + `deps.export` facts + `moduleGraph`.
     * OPTIONAL and additive, exactly like `moduleGraph`: no existing rule
     * reads it, and a caller that does not build one omits it. Carried for a
     * later cross-file rule to consume deliberately — it changes no current
     * finding on its own.
     */
    symbolGraph?: SymbolGraph;
    /**
     * The project-wide Flutter widget graph (Flutter Phase 1), built once by
     * the pipeline from `ui.flutterWidgetTree` + `dart.classDecl` +
     * `dart.importSpec` facts. OPTIONAL and additive, like `symbolGraph`:
     * read by the Flutter layout rules (rules/project/FlutterLayoutRules.ts),
     * which report nothing without it; passed only when the run produced
     * widget trees (a run without Flutter code omits it).
     */
    flutterWidgetGraph?: FlutterWidgetGraph;
    /**
     * Every file that contributed at least one fact to this run — computed
     * by the caller directly from the analyzed file list, independent of
     * which fact KINDS are present (see RuleEngine.ts). A rule needing to
     * know "does this file exist in the analyzed set" (e.g. to resolve an
     * import target) must read THIS, not re-derive it from `facts`: a file
     * with zero facts of the kind(s) a filtered/bounded evaluation kept
     * would otherwise silently disappear as a valid target.
     */
    analyzedFiles: ReadonlySet<string>;
    ruleSetId: string;
    knowledgeBase: KnowledgeBase;
    lang: string;
}

/**
 * A procedural, cross-file rule. Unlike the declarative rules, it sees the whole
 * fact set at once (needed for graph-shaped problems such as dependency cycles
 * that cannot be expressed as a per-subject condition). It still returns the
 * same Finding shape and flows through the engine's de-duplication and sorting.
 */
export interface ProjectRule {
    readonly id: string;
    readonly version: string;
    /**
     * Declares exactly which fact KINDS this rule's `evaluate()` reads from
     * `input.facts` (not `analyzedFiles`, which every rule gets regardless).
     * Omit when the rule genuinely needs to scan the full fact set — absence
     * must always be read as "declare unknown / needs everything", never as
     * "needs nothing". When present, evaluating this rule against ONLY
     * these kinds (plus the separately-tracked `analyzedFiles`) must yield
     * IDENTICAL findings to evaluating it against the full set — see
     * test/ProjectRuleCategorization.test.ts, which proves this per rule.
     * This is deliberately metadata only today: the main pipeline still
     * passes every rule the complete fact array (see Pipeline.ts's "Offene
     * Punkte" note on why — the optional semantic layer and the finding/
     * evidence-traceability contract both still need full per-file facts
     * after evaluation). It exists so a future bounded-evaluation pass has
     * a verified, truthful starting point instead of having to guess.
     */
    readonly requiredFactKinds?: readonly string[];
    evaluate(input: ProjectRuleInput): Finding[];
}
