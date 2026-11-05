import type {Fact, Finding, PrincipleInterpretationRef} from '../../Types.js';
import {resolveEntryPoints, type EntryDeclarations} from '../../config/EntryPoints.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import type {KnowledgeBase} from '../../knowledge/KnowledgeBase.js';
import type {ExportResolution, SymbolGraph} from '../../model/SymbolGraph.js';
import {symbolGraphOf, type ProjectRule, type ProjectRuleInput} from '../ProjectRule.js';

const PRINCIPLE_ID = 'marcus.cooperation';

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
        en: 'If this is public API of a package whose entry point stoa does not know, its consumers live outside the analyzed set; declare the entry (`entryPoints` in stoa.config.json) instead of removing it.',
        de: 'Ist dies öffentliche API eines Pakets, dessen Einstieg stoa nicht kennt, liegen die Konsumenten außerhalb des Umfangs; dann den Einstieg erklären (`entryPoints` in stoa.config.json) statt entfernen.'
    } as LocalizedText,
    missingContext: {
        en: 'Dynamic/string imports and consumers outside the analyzed set are not tracked; package entry points count only when declared (`entryPoints`) or named by package.json in a way that maps onto an analyzed file.',
        de: 'Dynamische/String-Importe und Konsumenten außerhalb des Umfangs werden nicht erfasst; Paket-Einstiege zählen nur, wenn erklärt (`entryPoints`) oder von der package.json eindeutig auf eine analysierte Datei abbildbar benannt.'
    } as LocalizedText,
    rationale: {
        en: 'A public export that nothing uses is clutter on the shared surface and misleads consumers about the real API (marcus.cooperation).',
        de: 'Ein öffentlicher Export, den nichts nutzt, verstopft die gemeinsame Fläche und täuscht Konsumenten über die echte API (marcus.cooperation).'
    } as LocalizedText
};

/** What the imports and entry points reach: single exports (`file` + NUL + `name`) and whole modules. */
interface Reached {
    exports: Set<string>;
    modules: Set<string>;
}

const SEP = '\u0000';

/**
 * Procedural, cross-file rule: flags an exported symbol that nothing in the
 * analyzed set reaches (dead public API). Opt-in, because it is only sound
 * over a whole project — a partial scan would flag every not-yet-imported export.
 * Maps to marcus.cooperation (serving the whole: no superfluous surface).
 *
 * Reached (not reported) is every export an import binding arrives at —
 * through the shared SymbolGraph, so re-exports (`export {x} from`,
 * `export *`, `export * as ns`, chains) are followed and each hop counts as
 * used — every module bound as a namespace, and everything a package entry
 * point exports (EntryPoints.ts: declared `entryPoints`, or package.json
 * mapped onto an analyzed file), with what it re-exports.
 *
 * Versions: 1.1.0 — re-exports and package entry points (external
 * validation 2026-11-05: 54 of 66 findings on ky were entry exports or
 * re-exported declarations); imports resolved through the module graph
 * (tsconfig paths, package self-references) instead of relative-only.
 */
export class DeadExportRule implements ProjectRule {
    public readonly id = 'R-UNUSED-EXPORT';
    public readonly version = '1.1.0';
    public readonly usesSymbolGraph = true;
    public readonly requiredFactKinds = ['deps.import', 'deps.importName', 'deps.export', 'deps.reexport'];

    public constructor(private readonly entries: EntryDeclarations | null = null) {}

    public evaluate(input: ProjectRuleInput): Finding[] {
        const graph = symbolGraphOf(input);
        const entryFiles = this.entries === null ? new Set<string>() : resolveEntryPoints(this.entries, input.analyzedFiles);
        const reached = reachedExports(graph, entryFiles);

        const findings: Finding[] = [];
        for (const fact of input.facts) {
            if (fact.kind !== 'deps.export') {
                continue;
            }
            const file = fact.subject.file;
            const name = String(fact.value);
            if (reached.modules.has(file) || reached.exports.has(`${file}${SEP}${name}`)) {
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
            location: {file: subject.file, range: subject.range, symbol: name, identityKind: 'declaration', structure: 'module'},
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

/** Marks a resolution as reached: each re-export hop and each definition (a whole module for `export * as ns`). */
const reach = (reached: Reached, resolution: Pick<ExportResolution, 'via' | 'definitions'>): void => {
    for (const hop of resolution.via) {
        reached.exports.add(`${hop.file}${SEP}${hop.exportedAs}`);
    }
    for (const definition of resolution.definitions) {
        if (definition.name === '*') {
            reached.modules.add(definition.file);
        } else {
            reached.exports.add(`${definition.file}${SEP}${definition.name}`);
        }
    }
};

/** Everything the import bindings and the entry points reach (an ambiguous binding reaches all its candidates). */
const reachedExports = (graph: SymbolGraph, entryFiles: ReadonlySet<string>): Reached => {
    const reached: Reached = {exports: new Set(), modules: new Set()};
    for (const edge of graph.imports) {
        if (edge.toFile === null) {
            continue;
        }
        if (edge.kind === 'namespace') {
            reached.modules.add(edge.toFile);
            continue;
        }
        reached.exports.add(`${edge.toFile}${SEP}${edge.importedName}`);
        reach(reached, edge);
    }
    for (const file of entryFiles) {
        for (const name of graph.exportNames(file)) {
            reached.exports.add(`${file}${SEP}${name}`);
            reach(reached, graph.resolveExport(file, name));
        }
    }
    return reached;
};
