import {basename} from 'node:path';
import type {Finding, SourceRange} from '../../Types.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import {packageNameOf} from '../../architecture/ArchitectureConfig.js';
import type {StructMember} from '../../analysis/StructFacts.js';
import type {TypeModel, TypeNode} from '../../model/TypeModel.js';
import {typeModelOf, type ProjectRule, type ProjectRuleInput} from '../ProjectRule.js';
import {resolvePrinciple} from './FlutterLayoutRules.js';

/**
 * E6e `R-SOLID-SRP-RESPONSIBILITY-COHESION` (experimental) — NOT registered
 * by the pipeline, not even with `--solid`: per plan it may appear only after
 * the candidates on the real apps were classified by hand (OQ-6). Until then
 * it exists for tests and for producing that candidate list.
 *
 * A class whose own instance members split into ≥ 2 groups (connected
 * components of "member references member"; constructors and statics left
 * out, as in LCOM4) where every group has at least one method, at least one
 * own field and at least one import group, and the groups use pairwise
 * DISJOINT fields AND DISJOINT import groups. An import group is what a
 * referenced import name resolves to (TypeModel): a project file, or an
 * external package (`package:http/…` → `http`), an import prefix, or an
 * ambiguous name itself; a name resolving to nothing (dart:core, type
 * parameters) is no dependency evidence and is dropped.
 *
 * Judged only where the cohesion is fully visible: the facts record
 * references to OWN members only, so a class with inherited or framework
 * members (every widget/State, any project subclass — `widget`, `setState`,
 * a base method linking two groups would be invisible: the Phase D artefacts)
 * is unknown, as are interfaces, mixins, enums, declarations with a parse
 * error, test paths and test doubles. Size alone is never a finding.
 */

const TEXT = {
    statement: {
        en: '{type} splits into {count} independent responsibilities: {groups}.',
        de: '{type} zerfällt in {count} unabhängige Verantwortlichkeiten: {groups}.'
    } as LocalizedText,
    suggestion: {
        en: 'Consider extracting each group into its own class (the groups share neither state nor dependencies), and let {type} delegate or be replaced by them.',
        de: 'Erwägen, jede Gruppe in eine eigene Klasse herauszuziehen (die Gruppen teilen weder Zustand noch Abhängigkeiten), und {type} an sie delegieren oder durch sie ersetzen lassen.'
    } as LocalizedText,
    drawbacks: {
        en: 'A facade or a deliberately grouped utility can be cohesive by purpose rather than by data; then the split adds indirection without gain.',
        de: 'Eine Fassade oder ein bewusst gebündeltes Hilfsmodul kann über den Zweck statt über Daten zusammenhängen; dann bringt das Aufteilen Indirektion ohne Gewinn.'
    } as LocalizedText,
    missingContext: {
        en: 'Groups = members linked by references to own members (constructors and statics excluded); import groups by resolved project file or package. Only classes without inherited or framework members are judged (references to those are not recorded); calls through other objects, callbacks and dynamic access are not seen.',
        de: 'Gruppen = über Verweise auf eigene Member verbundene Member (Konstruktoren und statische Member ausgenommen); Importgruppen nach aufgelöster Projektdatei oder Paket. Nur Klassen ohne geerbte oder Framework-Member werden beurteilt (Verweise darauf werden nicht erfasst); Aufrufe über andere Objekte, Callbacks und dynamischer Zugriff werden nicht gesehen.'
    } as LocalizedText,
    rationale: {
        en: '{type} serves {count} separate purposes at once; a part that does one thing does it well (marcus.purpose — single responsibility).',
        de: '{type} dient {count} getrennten Zwecken zugleich; ein Teil, der eine Sache tut, tut sie gut (marcus.purpose — Single Responsibility).'
    } as LocalizedText
};

const TEST_PATH = /(^|\/)(test|tests|__tests__|test_driver|integration_test)\/|_test\.dart$|\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DOUBLE = /Mock|Fake|Stub/;
const METHOD_KINDS = new Set<StructMember['memberKind']>(['method', 'getter', 'setter']);

export interface ResponsibilityGroup {
    methods: string[];
    fields: string[];
    imports: string[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const disjoint = (sets: readonly (readonly string[])[]): boolean => {
    const seen = new Set<string>();
    for (const values of sets) {
        for (const value of values) {
            if (seen.has(value)) {
                return false;
            }
        }
        values.forEach((value) => seen.add(value));
    }
    return true;
};

/**
 * What an import name used in `node`'s file stands for: a project file, an
 * external package, a Dart import prefix (`prefix:http` — the facts list the
 * lower-case prefix itself), or the name itself when it is ambiguous between
 * project files. Null for a name that resolves to nothing (dart:core types,
 * type parameters, unknown names): it is no dependency evidence.
 */
const importGroupOf = (model: TypeModel, node: TypeNode, name: string): string | null => {
    if (node.file.endsWith('.dart') && !/^[A-Z]/.test(name)) {
        return `prefix:${name}`;
    }
    const resolution = model.resolveRef(node.file, {prefix: null, name});
    if (resolution.status === 'project' && resolution.target !== null) {
        return basename(resolution.target.split('#')[0] ?? resolution.target);
    }
    if (resolution.status === 'external' && resolution.origin !== null) {
        return packageNameOf(resolution.origin) ?? resolution.origin;
    }
    return resolution.status === 'ambiguous' ? name : null;
};

const memberKeyOf = (member: StructMember): string => `${member.memberKind === 'setter' ? 'set ' : ''}${member.name}`;

/**
 * Connected components of "member references member" (a getter and its
 * setter are one property): member key → component root (union-find).
 */
const componentsOf = (members: readonly StructMember[]): (key: string) => string => {
    const byName = new Map<string, string[]>();
    for (const member of members) {
        byName.set(member.name, [...(byName.get(member.name) ?? []), memberKeyOf(member)]);
    }
    const parent = new Map(members.map((member) => [memberKeyOf(member), memberKeyOf(member)]));
    const find = (key: string): string => {
        let current = key;
        while (parent.get(current) !== current) {
            current = parent.get(current) as string;
        }
        return current;
    };
    const union = (a: string, b: string): void => {
        const [ra, rb] = [find(a), find(b)].sort(compareText) as [string, string];
        parent.set(rb, ra);
    };
    for (const member of members) {
        for (const name of [...member.refsMembers, member.name]) {
            (byName.get(name) ?? []).forEach((other) => union(memberKeyOf(member), other));
        }
    }
    return find;
};

const normalized = (group: ResponsibilityGroup): ResponsibilityGroup => ({
    methods: [...new Set(group.methods)].sort(compareText),
    fields: [...new Set(group.fields)].sort(compareText),
    imports: [...new Set(group.imports)].sort(compareText)
});

/**
 * The responsibility groups of a judgeable class (see the module comment), or
 * null when it is not judged or has fewer than two qualifying groups.
 */
export const responsibilityGroupsOf = (model: TypeModel, node: TypeNode): ResponsibilityGroup[] | null => {
    const members = node.members.filter((member) => member.memberKind !== 'constructor' && !member.isStatic);
    const rootOf = componentsOf(members);
    const groups = new Map<string, ResponsibilityGroup>();
    for (const member of members) {
        const root = rootOf(memberKeyOf(member));
        const group = groups.get(root) ?? {methods: [], fields: [], imports: []};
        if (member.memberKind === 'field') {
            group.fields.push(member.name);
        } else if (METHOD_KINDS.has(member.memberKind)) {
            group.methods.push(memberKeyOf(member));
        }
        group.imports.push(...member.refsImports.map((name) => importGroupOf(model, node, name)).filter((key): key is string => key !== null));
        groups.set(root, group);
    }
    const qualified = [...groups.values()]
        .map(normalized)
        .filter((group) => group.methods.length > 0 && group.fields.length > 0 && group.imports.length > 0)
        .sort((a, b) => compareText(a.methods[0] as string, b.methods[0] as string));
    if (qualified.length < 2 || !disjoint(qualified.map((group) => group.fields)) || !disjoint(qualified.map((group) => group.imports))) {
        return null;
    }
    return qualified;
};

const isJudgeable = (node: TypeNode, relative: string): boolean =>
    (node.declKind === 'class' || node.declKind === 'abstract-class') &&
    !node.hasParseError &&
    node.hierarchyComplete &&
    node.inherited.length === 0 &&
    node.frameworkMembers.length === 0 &&
    !TEST_PATH.test(relative) &&
    !TEST_DOUBLE.test(node.name);

/** The deepest directory containing every analyzed file (test paths are matched below it). */
const commonDirectory = (files: ReadonlySet<string>): string => {
    const lists = [...files].map((file) => file.split('/').slice(0, -1));
    const first = lists[0] ?? [];
    let length = first.length;
    for (const parts of lists) {
        let index = 0;
        while (index < length && parts[index] === first[index]) {
            index++;
        }
        length = index;
    }
    return first.slice(0, length).join('/');
};

export class SolidSrpResponsibilityCohesionRule implements ProjectRule {
    public readonly id = 'R-SOLID-SRP-RESPONSIBILITY-COHESION';
    public readonly version = '0.1.0';
    public readonly maturity = 'experimental' as const;
    public readonly requiredFactKinds = ['struct.typeDecl', 'struct.importBindings', 'deps.export', 'deps.import', 'deps.importName', 'deps.reexport', 'dart.importSpec', 'dart.classDecl'];

    public evaluate(input: ProjectRuleInput): Finding[] {
        if (!input.facts.some((fact) => fact.kind === 'struct.typeDecl')) {
            return [];
        }
        const model = typeModelOf(input);
        const root = commonDirectory(input.analyzedFiles);
        const relative = (file: string): string => (root !== '' && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file);
        const findings: Finding[] = [];
        for (const node of model.types.filter((candidate) => isJudgeable(candidate, relative(candidate.file)))) {
            const groups = responsibilityGroupsOf(model, node);
            if (groups !== null) {
                findings.push(this.buildFinding(node, groups, input));
            }
        }
        return findings;
    }

    private buildFinding(node: TypeNode, groups: ResponsibilityGroup[], input: ProjectRuleInput): Finding {
        const fact = input.facts.find((candidate) => candidate.id === node.factId);
        const range: SourceRange = fact?.subject.range ?? {startLine: 1, startCol: 1, endLine: 1, endCol: 1};
        const describe = (group: ResponsibilityGroup): string => `{${group.methods.join(', ')}} uses ${group.fields.join(', ')} and ${group.imports.join(', ')}`;
        const fill = (text: LocalizedText): string =>
            localize(text, input.lang)
                .replaceAll('{type}', node.name)
                .replaceAll('{count}', String(groups.length))
                .replaceAll('{groups}', groups.map((group) => `{${group.methods.join(', ')}}`).join(' / '));
        return {
            id: `finding:${this.id}:${node.file}:${range.startLine}:${range.startCol}`,
            rule: {id: this.id, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: node.file, range, symbol: node.name, structure: 'class'},
            observation: {
                statement: fill(TEXT.statement),
                evidence: groups.map((group, index) => ({fact: 'struct.typeDecl', value: `group ${index + 1}: ${describe(group)}`, certainty: 'semantic-heuristic' as const}))
            },
            interpretation: {
                principles: resolvePrinciple(input.knowledgeBase, input.lang, fill(TEXT.rationale), 'marcus.purpose'),
                dimensions: ['responsibility-boundaries']
            },
            severity: 'info',
            confidence: 0.4,
            certaintyBasis: 'semantic-heuristic',
            remediation: {suggestion: fill(TEXT.suggestion), drawbacks: fill(TEXT.drawbacks)},
            missingContext: [fill(TEXT.missingContext)],
            source: 'deterministic'
        };
    }
}
