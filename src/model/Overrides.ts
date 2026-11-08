import type {Fact} from '../Types.js';
import type {StructMember} from '../analysis/StructFacts.js';
import type {TypeModel, TypeNode} from './TypeModel.js';

/**
 * `type.overridesMember`: a project-derived fact on a method whose signature
 * is dictated by a supertype — the method overrides or implements a member
 * of the same name. Derived from the TypeModel (not file-local, never
 * cached), so the declarative rules can read it like any other fact; the
 * rule engine derives it only for a rule set that references it.
 *
 * A method overrides when
 * - it carries the language's override marker (Dart `@override`, TS
 *   `override`, PHP `#[\Override]`) — the parent may be external; or
 * - a project supertype reached through `extends`, `implements`, `with` or
 *   `on`, transitively, declares a member of that name with the same
 *   staticness (PHP method names compare case-insensitively).
 * An external or unresolved base without a marker proves nothing: its
 * members are unknown, never guessed. Constructors never override.
 *
 * The fact's subject is the method's own function subject (its
 * `metric.parameterCount` fact: same file, a symbol ending in `.name`, a
 * start line inside the member), so it joins that unit. Its value names
 * where the signature comes from: the declaring supertype's key, or
 * `marker` for a marker alone.
 */
export const OVERRIDES_MEMBER = 'type.overridesMember';

export const overrideFacts = (facts: readonly Fact[], model: TypeModel): Fact[] => {
    const functionsByFile = new Map<string, Fact[]>();
    for (const fact of facts.filter((candidate) => candidate.kind === 'metric.parameterCount' && candidate.subject.symbol !== undefined)) {
        functionsByFile.set(fact.subject.file, [...(functionsByFile.get(fact.subject.file) ?? []), fact]);
    }
    return model.types.flatMap((node) => {
        const functions = functionsByFile.get(node.file) ?? [];
        return functions.length === 0 ? [] : node.members.flatMap((member) => overrideFact(model, node, member, functions) ?? []);
    });
};

/** The `type.overridesMember` fact of one member, or null when it does not override (or has no measured function). */
const overrideFact = (model: TypeModel, node: TypeNode, member: StructMember, functions: readonly Fact[]): Fact | null => {
    if (member.memberKind === 'constructor' || member.memberKind === 'field') {
        return null;
    }
    const origin = member.isOverride ? 'marker' : declaringSupertype(model, node, member);
    const subject = origin === null ? undefined : functions.find((fact) => isMemberFunction(fact, member));
    if (origin === null || subject === undefined) {
        return null;
    }
    return {
        id: `${subject.id}:${OVERRIDES_MEMBER}`,
        kind: OVERRIDES_MEMBER,
        subject: subject.subject,
        value: origin,
        evidence: [],
        certainty: member.isOverride ? 'syntactic' : 'semantic-heuristic',
        producedBy: {adapter: 'type-model', version: '1'}
    };
};

/** The key of the nearest project supertype (breadth-first) that declares `member`'s name, else null. */
const declaringSupertype = (model: TypeModel, node: TypeNode, member: StructMember): string | null => {
    const name = nameKey(node.file, member.name);
    const seen = new Set<string>([node.key]);
    const queue: TypeNode[] = [node];
    for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
        const parents = projectParents(model, current).filter((parent) => !seen.has(parent.key));
        parents.forEach((parent) => seen.add(parent.key));
        const declaring = parents.find((parent) => declares(parent, name, member.isStatic));
        if (declaring !== undefined) {
            return declaring.key;
        }
        queue.push(...parents);
    }
    return null;
};

/** The project types `node` extends, implements, mixes in or is constrained to. */
const projectParents = (model: TypeModel, node: TypeNode): TypeNode[] =>
    node.supertypes.flatMap((base) => (base.status === 'project' && base.target !== null ? model.get(base.target) ?? [] : []));

const declares = (type: TypeNode, name: string, isStatic: boolean): boolean =>
    type.members.some((candidate) => candidate.memberKind !== 'constructor' && candidate.isStatic === isStatic && nameKey(type.file, candidate.name) === name);

const nameKey = (file: string, name: string): string => (file.endsWith('.php') ? name.toLowerCase() : name);

const isMemberFunction = (fact: Fact, member: StructMember): boolean => {
    const [startLine, , endLine] = member.range;
    const line = fact.subject.range.startLine;
    return fact.subject.symbol?.endsWith(`.${member.name}`) === true && line >= startLine && line <= endLine;
};
