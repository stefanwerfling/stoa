import {basename} from 'node:path';
import type {Finding, SourceRange} from '../../Types.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import {flutterAwareIndex} from '../../analysis/dart/FlutterCatalog.js';
import {ModuleResolver} from '../../analysis/ModuleResolution.js';
import {packageNameOf, type ArchitectureModel} from '../../architecture/ArchitectureConfig.js';
import {EMPTY_PROJECT_CONFIG} from '../../config/ProjectConfig.js';
import {buildModuleGraph, type ImportEvidence, type ModuleGraph} from '../../model/ModuleGraph.js';
import type {ProjectRule, ProjectRuleInput} from '../ProjectRule.js';
import {resolvePrinciple} from './FlutterLayoutRules.js';

/**
 * E6d `R-SOLID-DIP-LAYER-DIRECTION` stage 2 — against the DECLARED
 * architecture (`--architecture`, E5b). Registered with `--solid` only when a
 * config is given, and then INSTEAD of stage 1 (user decision: one semantics
 * per run under the rule id; the declaration supersedes the heuristic).
 *
 * - **Layer edge:** a resolved ModuleGraph edge (TS `deps.import` and — since
 *   0.3.0 — TS re-exports `export … from` (`deps.reexport`), Dart
 *   `import`/`export` from E2; type-only imports included — they are a
 *   compile-time dependency, marked in the evidence) whose two files sit in
 *   different layers and whose direction `allow` does not list. One finding
 *   per (importing file, imported file) at its first site, citing every site
 *   (an import and a re-export of one file, or a type-only and a value
 *   import of it, are one dependency — one finding identity).
 * - **Package ban:** an unresolved import or re-export of a PACKAGE (Dart
 *   `package:`/`dart:`; TS only when the ModuleGraph marks it `external` — an
 *   unresolved project reference such as a tsconfig alias without an analyzed
 *   target is never a package) whose package name (`packageNameOf`) is banned
 *   for the importing file's layer. One finding per (file, package).
 *
 * Module identity only: the finding names files and packages, never symbols;
 * which symbols cross the boundary is the SymbolGraph's (a later, finer rule).
 *
 * A file without a layer never leads to a finding (unknown); a file that
 * matches several layers belongs to the first (the report lists it as a
 * configuration warning).
 */

const TEXT = {
    edgeStatement: {
        en: '{file} (layer {fromLayer}) depends on {target} (layer {toLayer}); the declared architecture does not allow {fromLayer} → {toLayer}.',
        de: '{file} (Schicht {fromLayer}) hängt von {target} (Schicht {toLayer}) ab; die deklarierte Architektur erlaubt {fromLayer} → {toLayer} nicht.'
    } as LocalizedText,
    packageStatement: {
        en: '{file} (layer {fromLayer}) imports the package {package}, which the declared architecture forbids for {fromLayer}.',
        de: '{file} (Schicht {fromLayer}) importiert das Paket {package}, das die deklarierte Architektur für {fromLayer} verbietet.'
    } as LocalizedText,
    edgeSuggestion: {
        en: 'Route the dependency through a layer {fromLayer} may use (e.g. an abstraction in a shared/domain layer that {toLayer} implements), or — if the dependency is intended — add {fromLayer} → {toLayer} to `allow`.',
        de: 'Die Abhängigkeit über eine Schicht führen, die {fromLayer} nutzen darf (etwa eine Abstraktion in einer gemeinsamen/Domain-Schicht, die {toLayer} implementiert), oder — falls gewollt — {fromLayer} → {toLayer} in `allow` aufnehmen.'
    } as LocalizedText,
    packageSuggestion: {
        en: 'Move the use of {package} into a layer that may use it and give {fromLayer} an abstraction instead — or lift the ban if the architecture has changed.',
        de: 'Die Nutzung von {package} in eine Schicht verlegen, die es nutzen darf, und {fromLayer} stattdessen eine Abstraktion geben — oder das Verbot aufheben, wenn sich die Architektur geändert hat.'
    } as LocalizedText,
    drawbacks: {
        en: 'The finding is exactly as right as the declaration: a layer glob that is too broad or an outdated `allow` list produces it too.',
        de: 'Der Befund ist genau so richtig wie die Deklaration: ein zu breiter Schicht-Glob oder eine veraltete `allow`-Liste erzeugt ihn ebenso.'
    } as LocalizedText,
    missingContext: {
        en: 'Checked against {config}: resolved imports between analyzed files and package imports, one level. Files without a layer, dynamic imports, DI and transitive dependencies are not judged.',
        de: 'Geprüft gegen {config}: aufgelöste Importe zwischen analysierten Dateien und Paketimporte, eine Ebene. Dateien ohne Schicht, dynamische Importe, DI und transitive Abhängigkeiten werden nicht beurteilt.'
    } as LocalizedText,
    rationale: {
        en: 'The project declared how its parts cooperate; {fromLayer} reaching into {toLayer} breaks that agreed order (marcus.cooperation — dependency inversion).',
        de: 'Das Projekt hat festgelegt, wie seine Teile zusammenwirken; {fromLayer}, das in {toLayer} greift, bricht diese vereinbarte Ordnung (marcus.cooperation — Dependency Inversion).'
    } as LocalizedText
};

interface Violation {
    kind: 'edge' | 'package';
    file: string;
    fromLayer: string;
    /** edge: the imported file's layer; package: the package name. */
    toLayer: string;
    target: string;
    /** The identity within the file (FindingIdentity): the imported file's path relative to the root, or `package:<name>`. */
    symbol: string;
    evidence: ImportEvidence[];
    detail: {fact: string; value: string}[];
}

const factOf = (origin: string | undefined): string => origin ?? 'deps.import';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const firstOf = (evidence: readonly ImportEvidence[]): ImportEvidence =>
    [...evidence].sort((a, b) => a.range.startLine - b.range.startLine || a.range.startCol - b.range.startCol || compareText(a.factId, b.factId))[0] as ImportEvidence;

// The directive a ModuleGraph entry stands for: Dart `import`/`export`, TS `export` (a re-export) or `import`, PHP `use` (a PSR-4 edge), C/C++ `#include`.
const directiveOf = (entry: {origin?: string; dartDirective?: string; resolution?: string}): string =>
    entry.dartDirective ?? (entry.origin === 'deps.reexport' ? 'export' : entry.origin === 'cpp.include' ? '#include' : entry.resolution === 'psr4' ? 'use' : 'import');

// Forbidden edges, one violation per (importing file, imported file) — every site of every edge between them.
const edgeViolations = (graph: ModuleGraph, model: ArchitectureModel): Violation[] => {
    const byPair = new Map<string, Violation>();
    for (const edge of graph.edges.filter((candidate) => model.edgeVerdict(candidate.from, candidate.to) === 'forbidden')) {
        const key = `${edge.from}\n${edge.to}`;
        const violation = byPair.get(key) ?? {
            kind: 'edge' as const,
            file: edge.from,
            fromLayer: model.layerOf(edge.from) as string,
            toLayer: model.layerOf(edge.to) as string,
            target: basename(edge.to),
            symbol: model.relativePath(edge.to),
            evidence: [],
            detail: []
        };
        violation.evidence.push(...edge.evidence);
        violation.detail.push(
            ...edge.evidence.map((site) => ({
                fact: factOf(edge.origin),
                value: `${basename(edge.from)}:${site.range.startLine} ${directiveOf(edge)}${edge.isTypeOnly ? ' type' : ''} '${edge.specifier}' → ${model.relativePath(edge.to)} (${model.layerOf(edge.to) ?? ''})`
            }))
        );
        byPair.set(key, violation);
    }
    return [...byPair.values()];
};

const packageViolations = (graph: ModuleGraph, model: ArchitectureModel): Violation[] => {
    const byKey = new Map<string, Violation>();
    // `external === false`: a TS project reference that did not resolve — not a package.
    // A C/C++ include counts only when it is known to be external (a standard
    // header): an unknown header path names no package.
    for (const entry of graph.unresolved.filter((candidate) => (candidate.origin === 'cpp.include' ? candidate.external === true : candidate.external !== false))) {
        const name = packageNameOf(entry.specifier);
        const layer = model.layerOf(entry.from);
        if (name === null || layer === null || !model.isPackageForbidden(entry.from, name)) {
            continue;
        }
        const key = `${entry.from}\n${name}`;
        const violation = byKey.get(key) ?? {kind: 'package' as const, file: entry.from, fromLayer: layer, toLayer: name, target: name, symbol: `package:${name}`, evidence: [], detail: []};
        violation.evidence.push(...entry.evidence);
        violation.detail.push(...entry.evidence.map((site) => ({fact: factOf(entry.origin), value: `${basename(entry.from)}:${site.range.startLine} ${directiveOf(entry)} '${entry.specifier}' (package ${name})`})));
        byKey.set(key, violation);
    }
    return [...byKey.values()];
};

export class SolidDipLayerDeclaredRule implements ProjectRule {
    public readonly id = 'R-SOLID-DIP-LAYER-DIRECTION';
    /** Stage 2 (E6d: 0.2.0; 0.3.0 — TS re-exports judged, one finding per file pair, only external packages banned); stage 1 (heuristic, experimental) is 0.1.0. */
    public readonly version = '0.3.0';
    public readonly requiredFactKinds = ['deps.import', 'deps.reexport', 'dart.importSpec', 'dart.classDecl'];

    public constructor(private readonly architecture: ArchitectureModel) {}

    public evaluate(input: ProjectRuleInput): Finding[] {
        const graph = input.moduleGraph ?? buildModuleGraph(input.facts, input.analyzedFiles, new ModuleResolver(EMPTY_PROJECT_CONFIG), input.dartLibraryIndex ?? flutterAwareIndex(input.facts));
        const violations = [...edgeViolations(graph, this.architecture), ...packageViolations(graph, this.architecture)];
        return violations
            .map((violation) => this.buildFinding(violation, input))
            .sort((a, b) => compareText(a.location.file, b.location.file) || a.location.range.startLine - b.location.range.startLine || a.location.range.startCol - b.location.range.startCol || compareText(a.id, b.id));
    }

    private buildFinding(violation: Violation, input: ProjectRuleInput): Finding {
        const first = firstOf(violation.evidence);
        const range: SourceRange = first.range;
        const fill = (text: LocalizedText): string =>
            localize(text, input.lang)
                .replaceAll('{file}', basename(violation.file))
                .replaceAll('{fromLayer}', violation.fromLayer)
                .replaceAll('{toLayer}', violation.toLayer)
                .replaceAll('{target}', violation.target)
                .replaceAll('{package}', violation.target)
                .replaceAll('{config}', basename(this.architecture.config.path));
        const isEdge = violation.kind === 'edge';
        return {
            id: `finding:${this.id}:${violation.file}:${range.startLine}:${range.startCol}:${violation.kind}:${violation.target}`,
            rule: {id: this.id, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: violation.file, range, symbol: violation.symbol, structure: 'module'},
            observation: {
                statement: fill(isEdge ? TEXT.edgeStatement : TEXT.packageStatement),
                evidence: [
                    {fact: 'architecture', value: `${this.architecture.relativePath(violation.file)} ∈ ${violation.fromLayer} (${basename(this.architecture.config.path)} ${this.architecture.config.version})`, certainty: 'syntactic' as const},
                    ...[...violation.detail].sort((a, b) => compareText(a.value, b.value)).map((entry) => ({...entry, certainty: 'syntactic' as const}))
                ]
            },
            interpretation: {
                principles: resolvePrinciple(input.knowledgeBase, input.lang, fill(TEXT.rationale), 'marcus.cooperation'),
                dimensions: ['dependencies']
            },
            severity: 'medium',
            confidence: 0.9,
            certaintyBasis: 'syntactic',
            remediation: {suggestion: fill(isEdge ? TEXT.edgeSuggestion : TEXT.packageSuggestion), drawbacks: fill(TEXT.drawbacks)},
            missingContext: [fill(TEXT.missingContext)],
            source: 'deterministic'
        };
    }
}
