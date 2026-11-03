/**
 * Neutral class-model facts (Flutter quality track E3), shared by the Dart and
 * TypeScript adapters: ONE `struct.typeDecl` fact per type declaration, with
 * its members embedded as a compact table (user decision: one fact per member
 * grew the fact set by 34–43 %; the embedded table by 4–6 %). File-local,
 * cacheable, no judgement — no rule reads them yet; the TypeModel (E4) and the
 * SOLID rules (E6b/c) will, through `expandMembers`.
 *
 * Everything is what the source SPELLS: names are not resolved here
 * (`prefix`/`name` as written), `refsImports` lists candidates, every list is
 * sorted, and member entries keep source order — the facts are deterministic.
 * A member entry omits every field that has its default (false / null / []).
 */

export type StructDeclKind = 'class' | 'abstract-class' | 'interface' | 'mixin' | 'enum';

export interface StructTypeRef {
    [key: string]: unknown;
    /** Import prefix / namespace as written (`http` in `http.Client`), else null. */
    prefix: string | null;
    name: string;
}

export interface StructSupertype extends StructTypeRef {
    /** `on` = a Dart mixin's superclass constraint. */
    kind: 'extends' | 'implements' | 'with' | 'on';
}

export type StructMemberKind = 'method' | 'getter' | 'setter' | 'field' | 'constructor';

/** Methods/getters/setters only: `abstract` = no body; `throws-unsupported` = the body only throws an unsupported/unimplemented error. */
export type StructBody = 'abstract' | 'empty' | 'throws-unsupported' | 'normal';

export interface StructParam {
    [key: string]: unknown;
    name: string;
    type: StructTypeRef | null;
    /** Dart `this.x` / TS parameter property. */
    isFieldFormal: boolean;
}

export interface StructInstantiation extends StructTypeRef {
    /** Named constructor (`Foo.named()`), else null. */
    member: string | null;
}

export interface StructStaticAccess extends StructTypeRef {
    /** The accessed static member (`instance` in `Foo.instance`). */
    member: string;
}

/** One member, every field present (the expanded form consumers work with). */
export interface StructMember {
    name: string;
    memberKind: StructMemberKind;
    /** [startLine, startCol, endLine, endCol] of the member. */
    range: [number, number, number, number];
    isStatic: boolean;
    isAbstract: boolean;
    /** Dart `@override` / TS `override`. */
    isOverride: boolean;
    body: StructBody | null;
    /** The thrown type for `throws-unsupported`, else null. */
    throwsType: string | null;
    /** Field type / return type as written (a named type only; `void`, inferred and built-in keyword types are null). */
    declaredType: StructTypeRef | null;
    params: StructParam[];
    /** Own members the body/initializer references (`x`, `this.x`), sorted. */
    refsMembers: string[];
    /** Import prefixes and imported names the body references, sorted (Dart: also UpperCamel names not declared in the file — candidates, resolved later). */
    refsImports: string[];
    /** Constructor calls in the body/initializer, sorted. */
    instantiates: StructInstantiation[];
    /** Static property reads `Type.member` (not calls), sorted. */
    staticAccess: StructStaticAccess[];
}

/** The stored form of a member: `name`, `memberKind`, `range` always; every other field only when it is not its default. */
export interface StructMemberEntry extends Partial<StructMember> {
    [key: string]: unknown;
    name: string;
    memberKind: StructMemberKind;
    range: [number, number, number, number];
}

export interface StructTypeDeclValue {
    [key: string]: unknown;
    v: 1;
    declKind: StructDeclKind;
    /** In source order. */
    supertypes: StructSupertype[];
    /** The declaration contains syntax the parser could not structure; its members may be incomplete — never judge it. */
    hasParseError: boolean;
    /** In source order. */
    members: StructMemberEntry[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const refKey = (ref: StructTypeRef & {member?: string | null}): string => `${ref.prefix ?? ''}\u0000${ref.name}\u0000${ref.member ?? ''}`;

/** Sorted, de-duplicated copy. */
export const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareText);

/** Sorted, de-duplicated copy of type references (by prefix, name, member). */
export const sortedRefs = <T extends StructTypeRef & {member?: string | null}>(refs: Iterable<T>): T[] => {
    const byKey = new Map<string, T>();
    for (const ref of refs) {
        if (!byKey.has(refKey(ref))) {
            byKey.set(refKey(ref), ref);
        }
    }
    return [...byKey.entries()].sort(([a], [b]) => compareText(a, b)).map(([, ref]) => ref);
};

/** The stored entry of a member: defaults omitted, key order fixed. */
export const compactMember = (member: StructMember): StructMemberEntry => {
    const entry: StructMemberEntry = {name: member.name, memberKind: member.memberKind, range: member.range};
    if (member.isStatic) {
        entry.isStatic = true;
    }
    if (member.isAbstract) {
        entry.isAbstract = true;
    }
    if (member.isOverride) {
        entry.isOverride = true;
    }
    if (member.body !== null) {
        entry.body = member.body;
    }
    if (member.throwsType !== null) {
        entry.throwsType = member.throwsType;
    }
    if (member.declaredType !== null) {
        entry.declaredType = member.declaredType;
    }
    if (member.params.length > 0) {
        entry.params = member.params;
    }
    if (member.refsMembers.length > 0) {
        entry.refsMembers = member.refsMembers;
    }
    if (member.refsImports.length > 0) {
        entry.refsImports = member.refsImports;
    }
    if (member.instantiates.length > 0) {
        entry.instantiates = member.instantiates;
    }
    if (member.staticAccess.length > 0) {
        entry.staticAccess = member.staticAccess;
    }
    return entry;
};

/** The members of a `struct.typeDecl` value with every default filled in. */
export const expandMembers = (value: StructTypeDeclValue): StructMember[] =>
    value.members.map((entry) => ({
        name: entry.name,
        memberKind: entry.memberKind,
        range: entry.range,
        isStatic: entry.isStatic ?? false,
        isAbstract: entry.isAbstract ?? false,
        isOverride: entry.isOverride ?? false,
        body: entry.body ?? null,
        throwsType: entry.throwsType ?? null,
        declaredType: entry.declaredType ?? null,
        params: entry.params ?? [],
        refsMembers: entry.refsMembers ?? [],
        refsImports: entry.refsImports ?? [],
        instantiates: entry.instantiates ?? [],
        staticAccess: entry.staticAccess ?? []
    }));
