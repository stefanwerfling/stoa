import {basename} from 'node:path';
import type {Fact, Finding, PrincipleInterpretationRef} from '../../Types.js';
import {resolveRelativeImport} from '../../analysis/ImportPath.js';
import {cycleAdjacency} from '../../model/ModuleGraph.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import type {KnowledgeBase} from '../../knowledge/KnowledgeBase.js';
import type {ProjectRule, ProjectRuleInput} from '../ProjectRule.js';

const PRINCIPLE_ID = 'marcus.cooperation';

const TEXT = {
    statement: {en: 'Import cycle among {members}.', de: 'Import-Zyklus zwischen {members}.'} as LocalizedText,
    suggestion: {
        en: 'Break the cycle: invert one dependency, extract a shared module, or introduce a boundary interface.',
        de: 'Zyklus auflösen: eine Abhängigkeit umkehren, ein gemeinsames Modul extrahieren oder eine Grenz-Schnittstelle einführen.'
    } as LocalizedText,
    drawbacks: {
        en: 'An extra abstraction adds indirection; make sure it carries its weight.',
        de: 'Eine zusätzliche Abstraktion bringt Indirektion; sie muss ihren Nutzen rechtfertigen.'
    } as LocalizedText,
    missingContext: {
        en: 'Not resolved: dynamic imports / DI, PHP names without a `use` (same namespace, fully qualified) or without a composer.json PSR-4 mapping, and C/C++ includes found only via include paths (-I) or inside preprocessor conditionals.',
        de: 'Nicht aufgelöst: dynamische Importe / DI, PHP-Namen ohne `use` (gleicher Namespace, voll qualifiziert) oder ohne PSR-4-Mapping in der composer.json sowie C/C++-Includes, die nur über Include-Pfade (-I) oder in Präprozessor-Bedingungen gefunden werden.'
    } as LocalizedText,
    rationale: {
        en: 'A cyclic dependency binds modules so that none can change or be understood alone (marcus.cooperation).',
        de: 'Eine zyklische Abhängigkeit bindet Module so, dass keines allein geändert oder verstanden werden kann (marcus.cooperation).'
    } as LocalizedText
};

interface ImportValue {
    module: string;
    isTypeOnly: boolean;
}

/**
 * Detects import cycles across files and reports one finding per strongly
 * connected component (so an N-module cycle is counted once, not N times).
 * With the pipeline's ModuleGraph it reads `cycleAdjacency`: relative TS/JS
 * imports, PHP `use` resolved through PSR-4 and unconditional C/C++ quoted
 * includes (1.1.0, identity spec phase 4); type-only imports are skipped
 * (erased at compile time, so no runtime cycle). Without a ModuleGraph (a
 * focused unit test) it resolves relative `deps.import` specifiers only.
 * Maps to marcus.cooperation: a cycle serves neither the whole nor the part.
 */
export class DependencyCycleRule implements ProjectRule {
    public readonly id = 'R-DEP-CYCLE';
    public readonly version = '1.1.0';
    public readonly requiredFactKinds = ['deps.import'];

    public evaluate(input: ProjectRuleInput): Finding[] {
        // Phase 0 (decision D1-a): when the pipeline supplies the shared
        // ModuleGraph, consume its `relative`-only cycle view — byte-identical
        // to the edge set this rule used to compute itself. Alias/exports/
        // imports edges exist in that graph but are deliberately NOT part of
        // `cycleAdjacency`, so no new cycle can appear in this phase. When no
        // ModuleGraph is supplied (e.g. a focused unit test calling this rule
        // directly), fall back to building the graph from facts exactly as
        // before — the resolution logic is identical (both go through
        // `resolveRelativeImport`), so the two paths agree.
        const graph = input.moduleGraph !== undefined ? cycleAdjacency(input.moduleGraph) : this.buildGraph(input.facts, input.analyzedFiles);
        const components = stronglyConnectedComponents(graph);

        const findings: Finding[] = [];
        for (const component of components) {
            if (!isCycle(component, graph)) {
                continue;
            }
            findings.push(this.buildFinding(component, input));
        }
        return findings;
    }

    private buildGraph(facts: Fact[], analyzedFiles: ReadonlySet<string>): Map<string, Set<string>> {
        const graph = new Map<string, Set<string>>();
        for (const file of analyzedFiles) {
            graph.set(file, new Set<string>());
        }
        for (const fact of facts) {
            if (fact.kind !== 'deps.import') {
                continue;
            }
            const value = fact.value as unknown as ImportValue;
            // Type-only imports are erased at compile time (they emit no JS), so
            // they cannot form a runtime module-initialization cycle. Skip them
            // when building the graph — otherwise a purely type-level reference
            // is reported as a cycle the running program never has.
            if (value.isTypeOnly) {
                continue;
            }
            const target = resolveRelativeImport(fact.subject.file, value.module, analyzedFiles);
            if (target !== null && target !== fact.subject.file) {
                graph.get(fact.subject.file)?.add(target);
            }
        }
        return graph;
    }

    private buildFinding(component: string[], input: ProjectRuleInput): Finding {
        const members = [...component].sort((a, b) => a.localeCompare(b));
        const anchor = members[0] ?? '';
        const names = members.map((file) => basename(file));
        const cycleKey = names.join(',');

        return {
            id: `finding:${this.id}:${anchor}:1:0`,
            rule: {id: this.id, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: anchor, range: {startLine: 1, startCol: 0, endLine: 1, endCol: 0}, symbol: cycleKey, identityKind: 'module', structure: 'module'},
            observation: {
                statement: localize(TEXT.statement, input.lang).replace('{members}', names.join(', ')),
                evidence: [{fact: 'deps.import', value: cycleKey, certainty: 'syntactic'}]
            },
            interpretation: {principles: resolvePrinciple(input.knowledgeBase, input.lang), dimensions: ['dependencies']},
            severity: 'high',
            confidence: 0.9,
            certaintyBasis: 'syntactic',
            remediation: {
                suggestion: localize(TEXT.suggestion, input.lang),
                drawbacks: localize(TEXT.drawbacks, input.lang)
            },
            missingContext: [localize(TEXT.missingContext, input.lang)],
            source: 'deterministic'
        };
    }
}

const resolvePrinciple = (knowledgeBase: KnowledgeBase, lang: string): PrincipleInterpretationRef[] => {
    const principle = knowledgeBase.get(PRINCIPLE_ID);
    if (principle === null) {
        return [];
    }
    return [
        {
            id: principle.id,
            name: localize(principle.name, lang),
            passages: principle.passages,
            attributionConfidence: principle.attributionConfidence,
            rationale: localize(TEXT.rationale, lang)
        }
    ];
};

const isCycle = (component: string[], graph: Map<string, Set<string>>): boolean => {
    if (component.length > 1) {
        return true;
    }
    const only = component[0];
    return only !== undefined && (graph.get(only)?.has(only) ?? false);
};

/** Tarjan's strongly-connected-components over a deterministic (sorted) traversal. */
const stronglyConnectedComponents = (graph: Map<string, Set<string>>): string[][] => {
    const indexOf = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const result: string[][] = [];
    let counter = 0;

    const nodes = [...graph.keys()].sort((a, b) => a.localeCompare(b));

    const strongConnect = (node: string): void => {
        indexOf.set(node, counter);
        lowLink.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);

        const neighbours = [...(graph.get(node) ?? new Set<string>())].sort((a, b) => a.localeCompare(b));
        for (const next of neighbours) {
            if (!indexOf.has(next)) {
                strongConnect(next);
                lowLink.set(node, Math.min(lowLink.get(node) ?? 0, lowLink.get(next) ?? 0));
            } else if (onStack.has(next)) {
                lowLink.set(node, Math.min(lowLink.get(node) ?? 0, indexOf.get(next) ?? 0));
            }
        }

        if (lowLink.get(node) === indexOf.get(node)) {
            const component: string[] = [];
            let member: string | undefined;
            do {
                member = stack.pop();
                if (member !== undefined) {
                    onStack.delete(member);
                    component.push(member);
                }
            } while (member !== undefined && member !== node);
            result.push(component);
        }
    };

    for (const node of nodes) {
        if (!indexOf.has(node)) {
            strongConnect(node);
        }
    }
    return result;
};
