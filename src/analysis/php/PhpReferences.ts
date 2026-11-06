import {collect, isPhpNode, type PhpNode} from './PhpAst.js';

/**
 * The local names a PHP file references — what decides whether a `use`
 * import is used (R-DEP-UNUSED). A `use` binds its alias (or last segment)
 * as a local name; that name is referenced by
 * - code: an unqualified name (`Foo`, `Foo::X`, `new Foo`) is the name itself,
 *   a qualified one (`Alias\Sub\Foo`) uses its first segment — the namespace
 *   alias; a fully qualified (`\A\Foo`) or `namespace\…` name uses no import;
 * - attributes: `#[AsCommand]`, `#[ORM\Entity]` — the same rule;
 * - PHPDoc: types in tags (`@param list<Foo> $x`, `@throws FooException`,
 *   `@var Alias\Foo`), inline `{@see Foo}` / `{@link Foo}`, and Doctrine
 *   annotation tags (`@ORM\Column`). Static analysers (PHPStan, Psalm) and
 *   IDEs resolve these through the imports; PHP-CS-Fixer's
 *   `no_unused_imports` keeps them as well. Prose outside tags does not count.
 *
 * Names compare case-sensitively — stricter than PHP, which never makes an
 * unused import look used.
 */
export const referencedLocalNames = (program: PhpNode): Set<string> => {
    const names = new Set<string>();
    for (const node of collect(program, (candidate) => candidate.kind === 'name' || candidate.kind === 'attribute')) {
        const local = node.kind === 'name' ? codeReference(node) : nameReference(node.name);
        if (local !== null) {
            names.add(local);
        }
    }
    for (const comment of (program.comments as unknown[] | undefined) ?? []) {
        if (isPhpNode(comment) && typeof comment.value === 'string' && comment.value.startsWith('/**')) {
            docReferences(comment.value).forEach((name) => names.add(name));
        }
    }
    return names;
};

/** The local name a code `name` node references: by its resolution kind (`uqn`, `qn`, `fqn`, `rn`). */
const codeReference = (node: PhpNode): string | null => {
    if (typeof node.name !== 'string') {
        return null;
    }
    return node.resolution === 'fqn' || node.resolution === 'rn' ? null : nameReference(node.name);
};

/** The local name a written class name references: its first segment, none when fully qualified. */
const nameReference = (name: unknown): string | null => {
    if (typeof name !== 'string' || name.length === 0 || name.startsWith('\\')) {
        return null;
    }
    if (name.toLowerCase().startsWith('namespace\\')) {
        return null;
    }
    return name.split('\\')[0] ?? null;
};

const TAG_LINE = /^\s*(?:\/\*\*|\*)?\s*@([A-Za-z_\\][\w\\-]*)(.*)$/;
const INLINE_TAG = /\{@(?:see|link)\s+([^}]*)\}/g;
const TYPE_NAME = /(?<![\w$\\])[A-Za-z_\x80-\uffff][\w\x80-\uffff]*(?:\\[A-Za-z_\x80-\uffff][\w\x80-\uffff]*)*/g;

/** The local names a doc comment references (see `referencedLocalNames`). */
const docReferences = (doc: string): string[] => {
    const texts: string[] = [];
    for (const line of doc.split('\n')) {
        const tag = TAG_LINE.exec(line);
        if (tag === null) {
            continue;
        }
        const [, name = '', rest = ''] = tag;
        // `@ORM\Column(...)` is a Doctrine annotation — a class name; `@param` is not.
        if (/^[A-Z]/.test(name)) {
            texts.push(name);
        }
        texts.push(rest);
    }
    for (const match of doc.matchAll(INLINE_TAG)) {
        texts.push(match[1] ?? '');
    }
    return texts.flatMap((text) => [...text.matchAll(TYPE_NAME)].flatMap((match) => nameReference(match[0]) ?? []));
};
