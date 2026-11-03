import {basename} from 'node:path';
import type {Finding, SourceRange} from '../../Types.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import {flutterAwareIndex} from '../../analysis/dart/FlutterCatalog.js';
import {ModuleResolver} from '../../analysis/ModuleResolution.js';
import {EMPTY_PROJECT_CONFIG} from '../../config/ProjectConfig.js';
import {buildLayerClassification, type ModuleClassification, type UiDeclaration} from '../../model/LayerClassification.js';
import {buildModuleGraph, type ModuleGraph} from '../../model/ModuleGraph.js';
import type {ProjectRule, ProjectRuleInput} from '../ProjectRule.js';
import {resolvePrinciple} from './FlutterLayoutRules.js';

/**
 * SOLID rules (Flutter quality track E6). Registered by the pipeline only with
 * `--solid` (opt-in); without it no SOLID rule runs and every output is
 * unchanged.
 *
 * E6a `R-SOLID-DIP-LAYER-DIRECTION` (stage 1, experimental): a Dart library
 * that declares a UI class (E5a: resolved Flutter `StatelessWidget`/
 * `StatefulWidget`/`State` base, directly or via project classes) and itself
 * depends on data access —
 * - it imports a package of the data-access catalog (or `dart:io` with a
 *   `show` of I/O names), or
 * - it imports a PROJECT module with the role data access that is neither UI
 *   (reported on its own, never through its importer) nor a state holder
 *   (`ChangeNotifier`, `GetxController`, `Cubit`, … — user decision: a UI
 *   depending on its state-management layer is the intended pattern, even
 *   when that layer persists data itself).
 * One finding per library, located at its first such import. Only file
 * (library) level: whether the UI class body actually uses the imported
 * names is not checked before the class-model facts (E3). Unknown stays
 * unknown: an unresolved superclass, a base of another package, `dart:io`
 * without `show` or a package outside the catalog never leads to a finding.
 */

const RULE_TEXT = {
    statement: {
        en: 'UI library {file} ({classes}) depends directly on data access: {dependencies}.',
        de: 'UI-Bibliothek {file} ({classes}) hängt direkt von Datenzugriff ab: {dependencies}.'
    } as LocalizedText,
    suggestion: {
        en: 'Move the data access behind an abstraction the UI receives (a repository/service interface passed in, or provided by the state-management layer), so the widget depends on what it needs, not on how it is fetched or stored.',
        de: 'Den Datenzugriff hinter eine Abstraktion legen, die die UI erhält (eine übergebene Repository-/Service-Schnittstelle oder eine aus der State-Management-Schicht), damit das Widget von dem abhängt, was es braucht, nicht davon, wie es geladen oder gespeichert wird.'
    } as LocalizedText,
    drawbacks: {
        en: 'For a small app or a one-off screen the extra layer can cost more than it saves; this is a hint, not a defect.',
        de: 'Bei einer kleinen App oder einem einmaligen Screen kann die zusätzliche Schicht mehr kosten als sie spart; das ist ein Hinweis, kein Fehler.'
    } as LocalizedText,
    missingContext: {
        en: 'Library level only: whether the UI class itself uses the imported names is not checked. UI = a resolved Flutter StatelessWidget/StatefulWidget/State base; data access = a fixed package catalog (dart:io only with show of I/O names), one import level; modules declaring a state holder (ChangeNotifier, ValueNotifier, GetxController, Cubit/Bloc, StateNotifier/Notifier) are not counted as data-access targets; base classes of other packages, dart:io without show, DI containers and generated files are not seen.',
        de: 'Nur Bibliotheksebene: ob die UI-Klasse die importierten Namen selbst nutzt, wird nicht geprüft. UI = eine aufgelöste Flutter-Basis StatelessWidget/StatefulWidget/State; Datenzugriff = ein fester Paketkatalog (dart:io nur mit show von I/O-Namen), eine Importebene; Module mit einem State-Halter (ChangeNotifier, ValueNotifier, GetxController, Cubit/Bloc, StateNotifier/Notifier) zählen nicht als Datenzugriffs-Ziel; Basisklassen anderer Pakete, dart:io ohne show, DI-Container und generierte Dateien werden nicht gesehen.'
    } as LocalizedText,
    rationaleCooperation: {
        en: 'UI and data access are bound directly; each part should serve the whole through its own task, not reach into another part\'s work (marcus.cooperation — dependency inversion).',
        de: 'UI und Datenzugriff sind direkt aneinander gebunden; jeder Teil soll dem Ganzen durch seine eigene Aufgabe dienen, nicht in die Arbeit eines anderen greifen (marcus.cooperation — Dependency Inversion).'
    } as LocalizedText,
    rationaleControl: {
        en: 'The widget controls what it presents, not how data is fetched or stored; that belongs outside its sphere (marcus.control).',
        de: 'Das Widget bestimmt, was es darstellt, nicht wie Daten geladen oder gespeichert werden; das liegt außerhalb seines Bereichs (marcus.control).'
    } as LocalizedText
};

interface Dependency {
    /** Shown in the statement/evidence: a package name, `dart:io`, or a project file name. */
    label: string;
    detail: string;
    file: string;
    range: SourceRange;
    factId: string;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareDependency = (a: Dependency, b: Dependency): number =>
    compareText(a.file, b.file) || a.range.startLine - b.range.startLine || a.range.startCol - b.range.startCol || compareText(a.factId, b.factId);

export class SolidDipLayerDirectionRule implements ProjectRule {
    public readonly id = 'R-SOLID-DIP-LAYER-DIRECTION';
    public readonly version = '0.1.0';
    public readonly maturity = 'experimental' as const;
    public readonly requiredFactKinds = ['dart.classDecl', 'dart.importSpec'];

    public evaluate(input: ProjectRuleInput): Finding[] {
        if (!input.facts.some((fact) => fact.kind === 'dart.classDecl')) {
            return [];
        }
        const index = input.dartLibraryIndex ?? flutterAwareIndex(input.facts);
        const classification = buildLayerClassification(input.facts, index);
        const graph: ModuleGraph = input.moduleGraph ?? buildModuleGraph(input.facts, input.analyzedFiles, new ModuleResolver(EMPTY_PROJECT_CONFIG), index);
        const byFile = new Map(classification.modules.map((module) => [module.file, module]));

        const libraries = new Map<string, ModuleClassification[]>();
        for (const module of classification.modules) {
            libraries.set(module.library, [...(libraries.get(module.library) ?? []), module]);
        }

        const findings: Finding[] = [];
        for (const [library, members] of [...libraries].sort(([a], [b]) => compareText(a, b))) {
            const ui = members.flatMap((module) => module.ui);
            if (ui.length === 0) {
                continue;
            }
            const files = new Set(members.map((module) => module.file));
            const dependencies: Dependency[] = members.flatMap((module) =>
                module.dataAccess.map((entry) => ({label: entry.package, detail: `import '${entry.uri}'`, file: module.file, range: entry.range, factId: entry.factId}))
            );
            for (const edge of graph.edges) {
                if (edge.origin !== 'dart.importSpec' || edge.dartDirective !== 'import' || !files.has(edge.from)) {
                    continue;
                }
                const target = byFile.get(edge.to);
                if (target === undefined || target.library === library || !target.roles.includes('data-access') || target.roles.includes('ui') || target.roles.includes('state-holder')) {
                    continue;
                }
                const packages = [...new Set(target.dataAccess.map((entry) => entry.package))].sort(compareText).join(', ');
                for (const evidence of edge.evidence) {
                    dependencies.push({label: basename(edge.to), detail: `import '${edge.specifier}' → ${basename(edge.to)} (data access: ${packages})`, file: edge.from, range: evidence.range, factId: evidence.factId});
                }
            }
            if (dependencies.length === 0) {
                continue;
            }
            dependencies.sort(compareDependency);
            findings.push(this.buildFinding(library, ui, dependencies, input));
        }
        return findings;
    }

    private buildFinding(library: string, ui: UiDeclaration[], dependencies: Dependency[], input: ProjectRuleInput): Finding {
        const first = dependencies[0] as Dependency;
        const classes = [...new Set(ui.map((declaration) => declaration.name))].sort(compareText);
        const labels = [...new Set(dependencies.map((dependency) => dependency.label))].sort(compareText);
        const fill = (text: LocalizedText): string =>
            localize(text, input.lang).replaceAll('{file}', basename(library)).replaceAll('{classes}', classes.join(', ')).replaceAll('{dependencies}', labels.join(', '));
        return {
            id: `finding:${this.id}:${first.file}:${first.range.startLine}:${first.range.startCol}`,
            rule: {id: this.id, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: first.file, range: first.range, symbol: classes[0] as string, structure: 'module'},
            observation: {
                statement: fill(RULE_TEXT.statement),
                evidence: [
                    ...ui.map((declaration) => ({
                        fact: 'dart.classDecl',
                        value: `${declaration.name} extends ${[...declaration.chain, declaration.base].join(' → ')} (package:flutter)`,
                        certainty: 'syntactic' as const
                    })),
                    ...dependencies.map((dependency) => ({fact: 'dart.importSpec', value: `${basename(dependency.file)}:${dependency.range.startLine} ${dependency.detail}`, certainty: 'syntactic' as const}))
                ]
            },
            interpretation: {
                principles: [
                    ...resolvePrinciple(input.knowledgeBase, input.lang, fill(RULE_TEXT.rationaleCooperation), 'marcus.cooperation'),
                    ...resolvePrinciple(input.knowledgeBase, input.lang, fill(RULE_TEXT.rationaleControl), 'marcus.control')
                ],
                dimensions: ['dependencies']
            },
            severity: 'low',
            confidence: 0.5,
            certaintyBasis: 'semantic-heuristic',
            remediation: {suggestion: fill(RULE_TEXT.suggestion), drawbacks: fill(RULE_TEXT.drawbacks)},
            missingContext: [fill(RULE_TEXT.missingContext)],
            source: 'deterministic'
        };
    }
}

/** The SOLID rules registered with `--solid`, in a fixed order. */
export const solidRules = (): ProjectRule[] => [new SolidDipLayerDirectionRule()];
