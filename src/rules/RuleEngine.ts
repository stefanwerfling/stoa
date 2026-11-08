import type {
    Fact,
    FactValue,
    Finding,
    FindingEvidence,
    PrincipleInterpretationRef,
    Severity
} from '../Types.js';
import type {KnowledgeBase} from '../knowledge/KnowledgeBase.js';
import {IDENTITY_SCHEME, subjectIdentityKind, type IdentityScheme} from '../FindingIdentity.js';
import {DEFAULT_LANG, localize, type LocalizedText} from '../i18n/Localized.js';
import {certaintyCap, evalCondition, evalGroup, maxSeverity, weakestCertainty, type FactUnit} from './Evaluation.js';
import {DependencyCycleRule} from './project/DependencyCycleRule.js';
import {typeModelOf, type ProjectRule, type ProjectRuleInput} from './ProjectRule.js';
import type {RuleSet} from './RuleSet.js';
import type {Rule} from './RuleTypes.js';
import type {ModuleGraph} from '../model/ModuleGraph.js';
import type {SymbolGraph} from '../model/SymbolGraph.js';
import type {FlutterWidgetGraph} from '../model/FlutterWidgetGraph.js';
import type {DartLibraryIndex} from '../model/DartLibraryIndex.js';
import {OVERRIDES_MEMBER, overrideFacts} from '../model/Overrides.js';
import {PACKAGE_ENTRY, packageEntryFacts} from '../model/PackageEntryFacts.js';
import type {EntryDeclarations} from '../config/EntryPoints.js';

interface Unit {
    key: string;
    facts: FactUnit;
}

interface RuleEngineOptions {
    /** The finding-identity scheme; the current one when absent. */
    identityScheme?: IdentityScheme;
    /** The project's package entry declarations (`module.isPackageEntry`); none when absent. */
    entries?: EntryDeclarations | null;
}

interface KeyedFinding {
    dedupKey: string;
    finding: Finding;
}

/**
 * The deterministic rule engine. It consumes facts only (never the AST), groups
 * them per subject, applies each rule, derives severity and confidence as
 * separate axes, attaches the principle interpretation from the knowledge base,
 * and de-duplicates so one technical problem is counted once. See docs
 * rule-model §4 and finding-model §4.
 */
export class RuleEngine {
    private readonly identityScheme: IdentityScheme;
    private readonly entries: EntryDeclarations | null;

    public constructor(
        private readonly knowledgeBase: KnowledgeBase,
        private readonly ruleSet: RuleSet,
        private readonly lang: string = DEFAULT_LANG,
        private readonly projectRules: ProjectRule[] = [new DependencyCycleRule()],
        options: RuleEngineOptions = {}
    ) {
        this.identityScheme = options.identityScheme ?? IDENTITY_SCHEME;
        this.entries = options.entries ?? null;
    }

    /**
     * `analyzedFiles`: the files the run analyzed (see
     * `ProjectRuleInput.analyzedFiles`), passed to every project rule as is.
     * Omitted (a caller without a file list), it falls back to the files of
     * `facts` — equal for a complete fact set today, since every adapter
     * emits `file.lineCount` for each file, but not for a filtered one.
     */
    public evaluate(
        facts: Fact[],
        moduleGraph?: ModuleGraph,
        symbolGraph?: SymbolGraph,
        flutterWidgetGraph?: FlutterWidgetGraph,
        dartLibraryIndex?: DartLibraryIndex,
        analyzedFiles: ReadonlySet<string> = new Set(facts.map((fact) => fact.subject.file))
    ): Finding[] {
        const input: ProjectRuleInput = {
            facts,
            analyzedFiles,
            ...(moduleGraph !== undefined ? {moduleGraph} : {}),
            ...(symbolGraph !== undefined ? {symbolGraph} : {}),
            ...(flutterWidgetGraph !== undefined ? {flutterWidgetGraph} : {}),
            ...(dartLibraryIndex !== undefined ? {dartLibraryIndex} : {}),
            identityScheme: this.identityScheme,
            ruleSetId: this.ruleSet.id,
            knowledgeBase: this.knowledgeBase,
            lang: this.lang
        };
        // Derived facts join the declarative pass only; the project rules read
        // the extracted facts (and share the one memoized TypeModel).
        const derived = [
            ...(this.needsTypeModel(facts) ? overrideFacts(facts, typeModelOf(input)) : []),
            ...(this.entries !== null && this.readsFact(PACKAGE_ENTRY) ? packageEntryFacts(facts, this.entries, analyzedFiles) : [])
        ];
        const keyed = this.evaluateDeclarative(derived.length === 0 ? facts : [...facts, ...derived]);
        const projectFindings: Finding[] = [];

        for (const projectRule of this.projectRules) {
            const findings = projectRule.evaluate(input);
            // Not merged: a project rule reports each target once by
            // construction, and two of its findings with one id (a position)
            // may still be different identities — merging would drop one
            // silently. A repeated identity reaches the evaluator and the
            // baseline as what it is, a rule defect.
            for (const finding of findings) {
                projectFindings.push(governProjectFinding(finding, projectRule));
            }
        }

        const all = [...dedupe(keyed), ...projectFindings];
        all.sort(compareFindings);
        return all;
    }

    /**
     * Whether a declarative rule reads a fact derived from the TypeModel
     * (`type.overridesMember`, model/Overrides.ts) — then the engine derives
     * those facts before the declarative pass, and the pipeline builds the
     * symbol graph the TypeModel resolves TS names through.
     */
    public usesTypeModel(): boolean {
        return this.readsFact(OVERRIDES_MEMBER);
    }

    /** Whether a declarative rule's conditions read facts of `kind`. */
    private readsFact(kind: string): boolean {
        return this.ruleSet.all().some((rule) => conditionFacts(rule).includes(kind));
    }

    /** Whether `facts` need the TypeModel for this rule set: a rule reads a derived fact, and some file declares a type (no type, nothing overrides). */
    public needsTypeModel(facts: readonly Fact[]): boolean {
        return this.usesTypeModel() && facts.some((fact) => fact.kind === 'struct.typeDecl');
    }

    /**
     * The declarative rules over the facts grouped per subject. In a method of
     * its own so the grouping (one map entry per subject) ends here, before
     * the project rules run.
     */
    private evaluateDeclarative(facts: Fact[]): KeyedFinding[] {
        const units = groupUnits(facts);
        const keyed: KeyedFinding[] = [];
        for (const rule of this.ruleSet.all()) {
            for (const unit of units) {
                const finding = this.applyRule(rule, unit);
                if (finding !== null) {
                    keyed.push(finding);
                }
            }
        }
        return keyed;
    }

    public principleCount(): number {
        return this.knowledgeBase.size();
    }

    private applyRule(rule: Rule, unit: Unit): KeyedFinding | null {
        const evidence: Fact[] = [];
        for (const kind of rule.requiredEvidence) {
            const fact = unit.facts.get(kind);
            if (fact === undefined) {
                return null;
            }
            evidence.push(fact);
        }

        if (!evalGroup(rule.trigger, unit.facts)) {
            return null;
        }
        if (rule.suppressWhen !== undefined && evalGroup(rule.suppressWhen, unit.facts)) {
            return null;
        }

        const featureFact = unit.facts.get(rule.feature);
        if (featureFact === undefined) {
            return null;
        }

        const subject = featureFact.subject;
        const symbol = subject.symbol ?? subject.file;
        const findingEvidence: FindingEvidence[] = evidence.map((fact) => ({
            fact: fact.kind,
            value: fact.value,
            certainty: fact.certainty
        }));

        const finding: Finding = {
            id: `finding:${rule.id}:${subject.file}:${subject.range.startLine}:${subject.range.startCol}`,
            rule: {id: rule.id, version: rule.version},
            ruleSet: this.ruleSet.id,
            location: {
                file: subject.file,
                range: subject.range,
                symbol: subject.symbol ?? '',
                ...subjectIdentityKind(subject),
                structure: subject.kindOf
            },
            observation: {
                statement: interpolate(localize(rule.message, this.lang), featureFact.value, symbol),
                evidence: findingEvidence
            },
            interpretation: {
                principles: this.resolvePrinciples(rule),
                dimensions: rule.dimensions
            },
            severity: deriveSeverity(rule, unit.facts),
            confidence: deriveConfidence(rule, unit.facts, evidence),
            certaintyBasis: weakestCertainty(evidence),
            remediation: this.localizeRemediation(rule),
            source: 'deterministic'
        };
        if (rule.missingContext !== undefined) {
            finding.missingContext = rule.missingContext.map((text) => localize(text, this.lang));
        }
        if (rule.maturity === 'experimental') {
            finding.ruleMaturity = 'experimental';
        }

        // One problem (location, symbol, feature) seen by several rules is one
        // finding (finding-model §4). The symbol is part of it: two subjects
        // at one position are different findings, never merged.
        const dedupKey = `${subject.file}:${subject.range.startLine}:${subject.range.startCol}:${subject.symbol ?? ''}:${rule.feature}`;
        return {dedupKey, finding};
    }

    private resolvePrinciples(rule: Rule): PrincipleInterpretationRef[] {
        const refs: PrincipleInterpretationRef[] = [];
        for (const id of rule.principles) {
            const principle = this.knowledgeBase.get(id);
            if (principle === null) {
                continue;
            }
            const rationale: LocalizedText = rule.rationale ?? principle.softwareInterpretation;
            refs.push({
                id: principle.id,
                name: localize(principle.name, this.lang),
                passages: principle.passages,
                attributionConfidence: principle.attributionConfidence,
                rationale: localize(rationale, this.lang)
            });
        }
        return refs;
    }

    private localizeRemediation(rule: Rule) {
        if (rule.remediation === undefined) {
            return {suggestion: 'See rule documentation.'};
        }
        const suggestion = localize(rule.remediation.suggestion, this.lang);
        if (rule.remediation.drawbacks === undefined) {
            return {suggestion};
        }
        return {suggestion, drawbacks: localize(rule.remediation.drawbacks, this.lang)};
    }
}

/** Every fact kind a rule's trigger, suppression or escalation reads. */
const conditionFacts = (rule: Rule): string[] => {
    const kinds: string[] = [];
    const visit = (condition: {fact: string; and?: {fact: string}[]}): void => {
        kinds.push(condition.fact);
        condition.and?.forEach(visit);
    };
    for (const group of [rule.trigger, rule.suppressWhen]) {
        [...(group?.all ?? []), ...(group?.any ?? [])].forEach(visit);
    }
    rule.severity.escalateWhen?.forEach(visit);
    return kinds;
};

const groupUnits = (facts: Fact[]): Unit[] => {
    const byKey = new Map<string, Unit>();
    for (const fact of facts) {
        const {file, symbol, kindOf, range} = fact.subject;
        const key = `${file}::${symbol ?? ''}::${range.startLine}-${range.endLine}::${kindOf}`;
        let unit = byKey.get(key);
        if (unit === undefined) {
            unit = {key, facts: new Map<string, Fact>()};
            byKey.set(key, unit);
        }
        unit.facts.set(fact.kind, fact);
    }
    return [...byKey.values()];
};

const deriveSeverity = (rule: Rule, unit: FactUnit): Severity => {
    let severity = rule.severity.base;
    for (const escalation of rule.severity.escalateWhen ?? []) {
        if (evalCondition(escalation, unit)) {
            severity = maxSeverity(severity, escalation.to);
        }
    }
    return severity;
};

const deriveConfidence = (rule: Rule, unit: FactUnit, evidence: Fact[]): number => {
    let confidence = rule.confidence.base;
    for (const reduction of rule.confidence.reduceWhen ?? []) {
        if (evalCondition(reduction, unit)) {
            confidence -= reduction.by;
        }
    }
    if (rule.confidence.capBy === 'certainty' && evidence.length > 0) {
        const cap = Math.min(...evidence.map((fact) => certaintyCap(fact.certainty)));
        confidence = Math.min(confidence, cap);
    }
    return Math.max(0, Math.min(1, confidence));
};

/**
 * The engine-side guarantees for a project rule's finding (E1), applied
 * centrally so no rule can bypass them:
 * - E1b: confidence never exceeds the cap of its certainty basis — the same
 *   table declarative rules use via `capBy: 'certainty'`
 *   (`semantic-heuristic` ≤ 0.6, `external-tool` ≤ 0.9, `syntactic` ≤ 1);
 * - E1a: an `experimental` rule marks every finding it produces.
 */
const governProjectFinding = (finding: Finding, rule: ProjectRule): Finding => {
    const capped = Math.min(finding.confidence, certaintyCap(finding.certaintyBasis));
    const governed: Finding = capped === finding.confidence ? finding : {...finding, confidence: capped};
    return rule.maturity === 'experimental' ? {...governed, ruleMaturity: 'experimental'} : governed;
};

/**
 * Merges declarative findings that describe the same technical problem (same
 * location, symbol and feature, reported by several rules) so it is counted once, unioning their principle interpretations and
 * dimensions and keeping the highest severity and confidence.
 */
const dedupe = (keyed: KeyedFinding[]): Finding[] => {
    const byKey = new Map<string, Finding>();
    for (const {dedupKey, finding} of keyed) {
        const existing = byKey.get(dedupKey);
        if (existing === undefined) {
            byKey.set(dedupKey, finding);
            continue;
        }
        existing.interpretation.principles = mergePrinciples(existing, finding);
        existing.interpretation.dimensions = unique([
            ...existing.interpretation.dimensions,
            ...finding.interpretation.dimensions
        ]);
        existing.severity = maxSeverity(existing.severity, finding.severity);
        existing.confidence = Math.max(existing.confidence, finding.confidence);
        // Stable wins: a problem also reported by an established rule is not experimental.
        if (existing.ruleMaturity === 'experimental' && finding.ruleMaturity !== 'experimental') {
            delete existing.ruleMaturity;
        }
    }
    return [...byKey.values()];
};

const mergePrinciples = (a: Finding, b: Finding): PrincipleInterpretationRef[] => {
    const seen = new Set(a.interpretation.principles.map((ref) => ref.id));
    const merged = [...a.interpretation.principles];
    for (const ref of b.interpretation.principles) {
        if (!seen.has(ref.id)) {
            seen.add(ref.id);
            merged.push(ref);
        }
    }
    return merged;
};

const unique = <T>(items: T[]): T[] => [...new Set(items)];

const compareFindings = (a: Finding, b: Finding): number => {
    if (a.location.file !== b.location.file) {
        return a.location.file.localeCompare(b.location.file);
    }
    if (a.location.range.startLine !== b.location.range.startLine) {
        return a.location.range.startLine - b.location.range.startLine;
    }
    if (a.location.range.startCol !== b.location.range.startCol) {
        return a.location.range.startCol - b.location.range.startCol;
    }
    return a.rule.id.localeCompare(b.rule.id);
};

const interpolate = (template: string, value: FactValue, symbol: string): string => {
    return template.replace('{value}', String(value)).replace('{symbol}', symbol);
};
