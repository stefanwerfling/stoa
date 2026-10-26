import type {Fact, Finding, PrincipleInterpretationRef} from '../../Types.js';
import {resolveRelativeImport} from '../../analysis/ImportPath.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import type {KnowledgeBase} from '../../knowledge/KnowledgeBase.js';
import type {ProjectRule, ProjectRuleInput} from '../ProjectRule.js';

const PRINCIPLE_ID = 'marcus.cooperation';

interface ImportNameValue {
    module: string;
    name: string;
    kind: 'named' | 'default' | 'namespace';
}

const TEXT = {
    statement: {
        en: "Exported '{name}' is used nowhere in the analyzed set (dead public API).",
        de: "Export '{name}' wird im analysierten Umfang nirgends verwendet (tote öffentliche API)."
    } as LocalizedText,
    suggestion: {
        en: 'Remove it, or — if it is a real public API — run the analysis over the whole project so its consumers are in scope.',
        de: 'Entfernen, oder — falls es echte öffentliche API ist — die Analyse über das ganze Projekt laufen lassen, damit die Konsumenten im Umfang sind.'
    } as LocalizedText,
    drawbacks: {
        en: 'If this is a library entry point, its consumers live outside the analyzed set; do not remove it then.',
        de: 'Ist dies ein Bibliotheks-Einstieg, liegen die Konsumenten außerhalb des Umfangs; dann nicht entfernen.'
    } as LocalizedText,
    missingContext: {
        en: 'Re-exports, dynamic/string imports and external consumers are not tracked; analyze the full project.',
        de: 'Re-Exporte, dynamische/String-Importe und externe Konsumenten werden nicht erfasst; das ganze Projekt analysieren.'
    } as LocalizedText,
    rationale: {
        en: 'A public export that nothing uses is clutter on the shared surface and misleads consumers about the real API (marcus.cooperation).',
        de: 'Ein öffentlicher Export, den nichts nutzt, verstopft die gemeinsame Fläche und täuscht Konsumenten über die echte API (marcus.cooperation).'
    } as LocalizedText
};

/**
 * Procedural, cross-file rule: flags an exported symbol that no import in the
 * analyzed set references (dead public API). Opt-in, because it is only sound
 * over a whole project — a partial scan would flag every not-yet-imported export.
 * Maps to marcus.cooperation (serving the whole: no superfluous surface).
 */
export class DeadExportRule implements ProjectRule {
    public readonly id = 'R-UNUSED-EXPORT';
    public readonly version = '1.0.0';

    public evaluate(input: ProjectRuleInput): Finding[] {
        const analyzedFiles = new Set(input.facts.map((fact) => fact.subject.file));
        const usedNames = new Set<string>();
        const allUsedFiles = new Set<string>();

        for (const fact of input.facts) {
            if (fact.kind !== 'deps.importName') {
                continue;
            }
            const value = fact.value as unknown as ImportNameValue;
            const target = resolveRelativeImport(fact.subject.file, value.module, analyzedFiles);
            if (target === null) {
                continue;
            }
            if (value.kind === 'namespace') {
                allUsedFiles.add(target);
            } else {
                usedNames.add(`${target}::${value.name}`);
            }
        }

        const findings: Finding[] = [];
        for (const fact of input.facts) {
            if (fact.kind !== 'deps.export') {
                continue;
            }
            const file = fact.subject.file;
            const name = String(fact.value);
            if (allUsedFiles.has(file) || usedNames.has(`${file}::${name}`)) {
                continue;
            }
            findings.push(this.buildFinding(fact, name, input));
        }
        return findings;
    }

    private buildFinding(fact: Fact, name: string, input: ProjectRuleInput): Finding {
        const subject = fact.subject;
        return {
            id: `finding:${this.id}:${subject.file}:${subject.range.startLine}:${name}`,
            rule: {id: this.id, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: subject.file, range: subject.range, symbol: name, structure: 'module'},
            observation: {
                statement: localize(TEXT.statement, input.lang).replace('{name}', name),
                evidence: [{fact: 'deps.export', value: name, certainty: 'syntactic'}]
            },
            interpretation: {principles: resolvePrinciple(input.knowledgeBase, input.lang), dimensions: ['dependencies']},
            severity: 'low',
            confidence: 0.7,
            certaintyBasis: 'semantic-heuristic',
            remediation: {suggestion: localize(TEXT.suggestion, input.lang), drawbacks: localize(TEXT.drawbacks, input.lang)},
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
