import {basename} from 'node:path';
import type {Finding, SourceRange} from '../../Types.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import {flutterAwareIndex} from '../../analysis/dart/FlutterCatalog.js';
import {ModuleResolver} from '../../analysis/ModuleResolution.js';
import {EMPTY_PROJECT_CONFIG} from '../../config/ProjectConfig.js';
import {buildLayerClassification, type ModuleClassification, type UiDeclaration} from '../../model/LayerClassification.js';
import {buildModuleGraph, type ModuleGraph} from '../../model/ModuleGraph.js';
import type {TypeModel, TypeNode} from '../../model/TypeModel.js';
import type {StructMember} from '../../analysis/StructFacts.js';
import {typeModelOf, type ProjectRule, type ProjectRuleInput} from '../ProjectRule.js';
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

/*
 * E6b — contract rules over the TypeModel (E4), Dart and TypeScript.
 *
 * Only PROJECT supertypes count: a framework or package base (Flutter
 * `State.dispose`, …) has no member table here, so its contract is unknown
 * and never judged. A declaration with a syntax error, a class in a test path
 * and a test double (`Mock`/`Fake`/`Stub` in the type name — a documented
 * name exception that only EXCLUDES) are skipped.
 */

const TEST_PATH = /(^|\/)(test|tests|__tests__|test_driver|integration_test)\/|_test\.dart$|\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DOUBLE = /Mock|Fake|Stub/;
/** Everything the TypeModel reads: class-model facts, TS bindings/exports/imports (module graph), Dart directives and class names (library index). */
const TYPE_MODEL_FACT_KINDS = ['struct.typeDecl', 'struct.importBindings', 'deps.export', 'deps.import', 'dart.importSpec', 'dart.classDecl'];
const CALLABLE = new Set<StructMember['memberKind']>(['method', 'getter', 'setter']);

/** The deepest directory containing every analyzed file — the project root as far as the rules can tell (test paths are matched below it). */
const commonDirectory = (files: ReadonlySet<string>): string => {
    let common: string[] | null = null;
    for (const file of files) {
        const parts = file.split('/').slice(0, -1);
        if (common === null) {
            common = parts;
            continue;
        }
        let length = 0;
        while (length < common.length && length < parts.length && common[length] === parts[length]) {
            length++;
        }
        common = common.slice(0, length);
    }
    return common === null ? '' : common.join('/');
};
const judgeable = (input: ProjectRuleInput): ((node: TypeNode) => boolean) => {
    const root = commonDirectory(input.analyzedFiles);
    return (node) => {
        const relative = root !== '' && node.file.startsWith(`${root}/`) ? node.file.slice(root.length + 1) : node.file;
        return !node.hasParseError && node.declKind !== 'interface' && !TEST_PATH.test(relative) && !TEST_DOUBLE.test(node.name);
    };
};
const callableKey = (member: StructMember): string => (member.memberKind === 'setter' ? `${member.name}=` : member.name);
const isContractMember = (member: StructMember): boolean => CALLABLE.has(member.memberKind) && !member.isStatic;
const rangeOf = (range: StructMember['range']): SourceRange => ({startLine: range[0], startCol: range[1], endLine: range[2], endCol: range[3]});
const typeLabel = (node: TypeNode): string => `${node.name} (${basename(node.file)})`;
const memberLabel = (member: StructMember): string => `${member.memberKind === 'setter' ? 'set ' : member.memberKind === 'getter' ? 'get ' : ''}${member.name}`;

type OverriddenLookup = {kind: 'found'; member: StructMember; owner: TypeNode} | {kind: 'none'};

/**
 * The nearest declaration of `key` in the PROJECT supertypes of `node`: the
 * implementation chain first (mixins last-applied first, then the superclass /
 * `on`), then `implements`. Bases that are not project types are skipped —
 * their members are unknown, so nothing is concluded from them.
 */
const findOverridden = (model: TypeModel, node: TypeNode, key: string, path: Set<string>): OverriddenLookup => {
    const ordered = [
        ...node.supertypes.filter((base) => base.kind === 'with').reverse(),
        ...node.supertypes.filter((base) => base.kind === 'extends' || base.kind === 'on'),
        ...node.supertypes.filter((base) => base.kind === 'implements')
    ];
    for (const base of ordered) {
        const parent = base.status === 'project' && base.target !== null ? model.get(base.target) : undefined;
        if (parent === undefined || path.has(parent.key)) {
            continue;
        }
        const own = parent.members.find((member) => isContractMember(member) && callableKey(member) === key);
        if (own !== undefined) {
            return {kind: 'found', member: own, owner: parent};
        }
        const deeper = findOverridden(model, parent, key, new Set([...path, parent.key]));
        if (deeper.kind === 'found') {
            return deeper;
        }
    }
    return {kind: 'none'};
};

const declarationRange = (input: ProjectRuleInput, node: TypeNode): SourceRange => {
    const fact = input.facts.find((candidate) => candidate.id === node.factId);
    return fact?.subject.range ?? {startLine: 1, startCol: 1, endLine: 1, endCol: 1};
};

const LSP_TEXT = {
    statement: {
        en: '{member} in {type} overrides the concrete {base} and only throws {thrown}.',
        de: '{member} in {type} überschreibt das konkrete {base} und wirft nur {thrown}.'
    } as LocalizedText,
    suggestion: {
        en: 'A subtype should honour what its supertype promises. If {type} cannot support {member}, it probably should not be a {owner}: extract the part it can fulfil into a narrower supertype, or use composition instead of inheritance.',
        de: 'Ein Subtyp sollte halten, was sein Supertyp verspricht. Kann {type} {member} nicht unterstützen, sollte er wohl kein {owner} sein: den erfüllbaren Teil in einen schmaleren Supertyp herausziehen oder Komposition statt Vererbung verwenden.'
    } as LocalizedText,
    drawbacks: {
        en: 'Sometimes a deliberately read-only or partial variant is the pragmatic choice (e.g. an unmodifiable view); then document it at the supertype.',
        de: 'Manchmal ist eine bewusst schreibgeschützte oder partielle Variante die pragmatische Wahl (etwa eine unveränderliche Sicht); dann gehört das beim Supertyp dokumentiert.'
    } as LocalizedText,
    missingContext: {
        en: 'Only project supertypes are compared (framework and package bases are unknown); "only throws" means the body consists of a single throw of UnsupportedError/UnimplementedError (Dart) or of a NotImplemented/NotSupported error or an Error whose message says so (TS). Classes in test paths (below the common directory of the analyzed files) and Mock/Fake/Stub types are skipped. Documented contracts and callers are not seen.',
        de: 'Nur Projekt-Supertypen werden verglichen (Framework- und Paketbasen sind unbekannt); „wirft nur“ heißt, der Rumpf besteht aus einem einzigen throw von UnsupportedError/UnimplementedError (Dart) bzw. eines NotImplemented-/NotSupported-Fehlers oder eines Error mit entsprechender Meldung (TS). Klassen in Testpfaden (unterhalb des gemeinsamen Verzeichnisses der analysierten Dateien) und Mock-/Fake-/Stub-Typen werden übersprungen. Dokumentierte Verträge und Aufrufer werden nicht gesehen.'
    } as LocalizedText,
    rationale: {
        en: 'Whoever uses {owner} relies on {member} working; a subtype that refuses it breaks that trust — judge a type by what it actually does, not by what it claims to be (marcus.judgment — Liskov substitution).',
        de: 'Wer {owner} verwendet, verlässt sich darauf, dass {member} funktioniert; ein Subtyp, der es verweigert, bricht dieses Vertrauen — einen Typ nach dem beurteilen, was er tatsächlich tut, nicht nach dem, was er zu sein behauptet (marcus.judgment — Liskov-Substitution).'
    } as LocalizedText
};

interface RefusedContract {
    node: TypeNode;
    member: StructMember;
    owner: TypeNode;
    base: StructMember;
}

/** `member` only throws unsupported and overrides a CONCRETE member of a project supertype (not an interface, no parse error) — else null. */
const refusedContractOf = (model: TypeModel, node: TypeNode, member: StructMember): RefusedContract | null => {
    if (!isContractMember(member) || member.body !== 'throws-unsupported') {
        return null;
    }
    const overridden = findOverridden(model, node, callableKey(member), new Set([node.key]));
    if (overridden.kind !== 'found' || overridden.owner.hasParseError || overridden.owner.declKind === 'interface') {
        return null;
    }
    const base = overridden.member;
    const concrete = !base.isAbstract && (base.body === 'normal' || base.body === 'empty');
    return concrete ? {node, member, owner: overridden.owner, base} : null;
};

/**
 * E6b `R-SOLID-LSP-CONTRACT-COMPATIBILITY`: a method/getter/setter whose body
 * only throws an unsupported/unimplemented error, overriding a CONCRETE
 * (non-abstract, body present) member of a resolved project supertype. An
 * override of an abstract member is not a finding (that is ISP's concern).
 */
export class SolidLspContractCompatibilityRule implements ProjectRule {
    public readonly id = 'R-SOLID-LSP-CONTRACT-COMPATIBILITY';
    public readonly version = '0.1.0';
    public readonly maturity = 'experimental' as const;
    public readonly requiredFactKinds = TYPE_MODEL_FACT_KINDS;

    public evaluate(input: ProjectRuleInput): Finding[] {
        if (!input.facts.some((fact) => fact.kind === 'struct.typeDecl')) {
            return [];
        }
        const model = typeModelOf(input);
        const isJudgeable = judgeable(input);
        const findings: Finding[] = [];
        for (const node of model.types) {
            if (!isJudgeable(node)) {
                continue;
            }
            for (const member of node.members) {
                const violation = refusedContractOf(model, node, member);
                if (violation !== null) {
                    findings.push(this.buildFinding(violation, input));
                }
            }
        }
        return findings;
    }

    private buildFinding({node, member, owner, base}: RefusedContract, input: ProjectRuleInput): Finding {
        const range = rangeOf(member.range);
        const fill = (text: LocalizedText): string =>
            localize(text, input.lang)
                .replaceAll('{member}', memberLabel(member))
                .replaceAll('{type}', node.name)
                .replaceAll('{owner}', owner.name)
                .replaceAll('{base}', `${owner.name}.${base.name}`)
                .replaceAll('{thrown}', member.throwsType ?? 'Error');
        return {
            id: `finding:${this.id}:${node.file}:${range.startLine}:${range.startCol}`,
            rule: {id: this.id, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: node.file, range, symbol: `${node.name}.${member.name}`, structure: 'function'},
            observation: {
                statement: fill(LSP_TEXT.statement),
                evidence: [
                    {fact: 'struct.typeDecl', value: `${typeLabel(node)}:${range.startLine} ${memberLabel(member)}${member.isOverride ? ' (override)' : ''} — body only throws ${member.throwsType ?? 'Error'}`, certainty: 'syntactic' as const},
                    {fact: 'struct.typeDecl', value: `${typeLabel(owner)}:${base.range[0]} ${memberLabel(base)} — concrete (${base.body ?? 'normal'} body)`, certainty: 'syntactic' as const}
                ]
            },
            interpretation: {
                principles: resolvePrinciple(input.knowledgeBase, input.lang, fill(LSP_TEXT.rationale), 'marcus.judgment'),
                dimensions: ['responsibility-boundaries']
            },
            severity: 'low',
            confidence: 0.8,
            certaintyBasis: 'syntactic',
            remediation: {suggestion: fill(LSP_TEXT.suggestion), drawbacks: fill(LSP_TEXT.drawbacks)},
            missingContext: [fill(LSP_TEXT.missingContext)],
            source: 'deterministic'
        };
    }
}

const ISP_TEXT = {
    statement: {
        en: '{type} implements {contract} but fulfils {count} of its members only formally: {members}.',
        de: '{type} implementiert {contract}, erfüllt aber {count} seiner Member nur formal: {members}.'
    } as LocalizedText,
    suggestion: {
        en: 'Split {contract} into smaller interfaces along what its implementers actually use, so {type} depends only on the members it needs.',
        de: '{contract} entlang dessen, was die Implementierungen tatsächlich nutzen, in kleinere Schnittstellen aufteilen, damit {type} nur von den Membern abhängt, die es braucht.'
    } as LocalizedText,
    drawbacks: {
        en: 'Empty hooks can be a deliberate no-op default (a listener that ignores some events); splitting then adds types without real gain.',
        de: 'Leere Hooks können ein bewusster No-op-Standard sein (ein Listener, der manche Ereignisse ignoriert); das Aufteilen fügt dann Typen ohne echten Gewinn hinzu.'
    } as LocalizedText,
    missingContext: {
        en: 'Only resolved project interfaces / abstract classes and their abstract members are compared; "formally" = an empty body or a body that only throws an unsupported/unimplemented error. Whether the members are called on this type is not seen.',
        de: 'Nur aufgelöste Projekt-Schnittstellen / abstrakte Klassen und deren abstrakte Member werden verglichen; „formal“ = ein leerer Rumpf oder ein Rumpf, der nur einen Unsupported-/Unimplemented-Fehler wirft. Ob die Member auf diesem Typ aufgerufen werden, wird nicht gesehen.'
    } as LocalizedText,
    rationale: {
        en: '{type} is made to carry members it has no purpose for; each part should take on what serves its own task (marcus.purpose — interface segregation).',
        de: '{type} muss Member tragen, für die es keinen Zweck hat; jeder Teil soll übernehmen, was seiner eigenen Aufgabe dient (marcus.purpose — Interface-Segregation).'
    } as LocalizedText
};

/** The abstract callable members of a project contract type, own first, then inherited (keyed like overrides). */
const abstractContract = (contract: TypeNode): Map<string, StructMember> => {
    const result = new Map<string, StructMember>();
    for (const member of [...contract.members, ...contract.inherited.map((entry) => entry.member)]) {
        const key = callableKey(member);
        if (isContractMember(member) && !result.has(key)) {
            result.set(key, member);
        }
    }
    for (const [key, member] of result) {
        if (!(contract.declKind === 'interface' || member.isAbstract || member.body === 'abstract')) {
            result.delete(key);
        }
    }
    return result;
};

/** The distinct resolved project interfaces / abstract classes `node` implements, extends or mixes in, in source order. */
const contractsOf = (model: TypeModel, node: TypeNode): TypeNode[] => {
    const contracts = new Map<string, TypeNode>();
    for (const base of node.supertypes) {
        const contract = base.status === 'project' && base.target !== null && base.kind !== 'on' ? model.get(base.target) : undefined;
        if (contract !== undefined && !contract.hasParseError && (contract.declKind === 'interface' || contract.declKind === 'abstract-class') && !contracts.has(contract.key)) {
            contracts.set(contract.key, contract);
        }
    }
    return [...contracts.values()];
};

/**
 * E6b `R-SOLID-ISP-INTERFACE-COHESION`: a class that implements/extends a
 * resolved project interface or abstract project class and fulfils at least
 * two of its ABSTRACT members with an empty body or a body that only throws
 * an unsupported/unimplemented error. One finding per (class, contract).
 */
export class SolidIspInterfaceCohesionRule implements ProjectRule {
    public readonly id = 'R-SOLID-ISP-INTERFACE-COHESION';
    public readonly version = '0.1.0';
    public readonly maturity = 'experimental' as const;
    public readonly requiredFactKinds = TYPE_MODEL_FACT_KINDS;

    public evaluate(input: ProjectRuleInput): Finding[] {
        if (!input.facts.some((fact) => fact.kind === 'struct.typeDecl')) {
            return [];
        }
        const model = typeModelOf(input);
        const isJudgeable = judgeable(input);
        const findings: Finding[] = [];
        for (const node of model.types) {
            if (!isJudgeable(node)) {
                continue;
            }
            for (const contract of contractsOf(model, node)) {
                const required = abstractContract(contract);
                const formal = node.members.filter((member) => isContractMember(member) && required.has(callableKey(member)) && (member.body === 'empty' || member.body === 'throws-unsupported'));
                if (formal.length >= 2) {
                    findings.push(this.buildFinding(node, contract, formal, input));
                }
            }
        }
        return findings;
    }

    private buildFinding(node: TypeNode, contract: TypeNode, formal: StructMember[], input: ProjectRuleInput): Finding {
        const range = declarationRange(input, node);
        const fill = (text: LocalizedText): string =>
            localize(text, input.lang)
                .replaceAll('{type}', node.name)
                .replaceAll('{contract}', contract.name)
                .replaceAll('{count}', String(formal.length))
                .replaceAll('{members}', formal.map(memberLabel).join(', '));
        return {
            id: `finding:${this.id}:${node.file}:${range.startLine}:${range.startCol}:${contract.name}`,
            rule: {id: this.id, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: node.file, range, symbol: node.name, structure: 'class'},
            observation: {
                statement: fill(ISP_TEXT.statement),
                evidence: [
                    {fact: 'struct.typeDecl', value: `${typeLabel(node)} → ${typeLabel(contract)} (${contract.declKind})`, certainty: 'syntactic' as const},
                    ...formal.map((member) => ({
                        fact: 'struct.typeDecl',
                        value: `${basename(node.file)}:${member.range[0]} ${memberLabel(member)} — ${member.body === 'empty' ? 'empty body' : `body only throws ${member.throwsType ?? 'Error'}`}`,
                        certainty: 'syntactic' as const
                    }))
                ]
            },
            interpretation: {
                principles: resolvePrinciple(input.knowledgeBase, input.lang, fill(ISP_TEXT.rationale), 'marcus.purpose'),
                dimensions: ['responsibility-boundaries']
            },
            severity: 'info',
            confidence: 0.7,
            certaintyBasis: 'syntactic',
            remediation: {suggestion: fill(ISP_TEXT.suggestion), drawbacks: fill(ISP_TEXT.drawbacks)},
            missingContext: [fill(ISP_TEXT.missingContext)],
            source: 'deterministic'
        };
    }
}

/** The SOLID rules registered with `--solid`, in a fixed order. */
export const solidRules = (): ProjectRule[] => [new SolidDipLayerDirectionRule(), new SolidLspContractCompatibilityRule(), new SolidIspInterfaceCohesionRule()];
