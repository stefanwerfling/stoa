import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PhpAdapter} from '../src/analysis/PhpAdapter.js';

// R-DEP-UNUSED in PHP: an import counts as used when code, an attribute or a
// PHPDoc tag references its local name (alias or last segment) — not when only
// prose or a fully qualified name mentions it.

const ROOT = '/virtual';

/** The modules `deps.importUnused` reports for `content`. */
const unusedIn = (content: string): string[] => {
    const adapter = new PhpAdapter();
    const facts = adapter.extractFacts(adapter.parse({path: `${ROOT}/m.php`, content}), {rootDir: ROOT});
    return facts.filter((fact) => fact.kind === 'deps.importUnused').map((fact) => fact.value as string);
};

const file = (uses: string[], body: string): string => `<?php\nnamespace App;\n\n${uses.map((use) => `use ${use};`).join('\n')}\n\n${body}\n`;

test('a namespace alias used as the prefix of a qualified name is used', () => {
    const content = file(['Lib\\Resolver as R', 'Lib\\Other as O'], 'final class A { public function f() { return new R\\Builtin(); } }');
    assert.deepEqual(unusedIn(content), ['Lib\\Other']);
});

test('a qualified name does not use an import named like its last segment', () => {
    const content = file(['Lib\\Builtin'], 'final class A { public function f() { return new R\\Builtin(); } }');
    assert.deepEqual(unusedIn(content), ['Lib\\Builtin']);
});

test('a fully qualified name uses no import', () => {
    const content = file(['Lib\\Thing'], 'final class A { public function f() { return new \\Other\\Thing(); } }');
    assert.deepEqual(unusedIn(content), ['Lib\\Thing']);
});

test('attributes use their import, also through a namespace alias', () => {
    const content = file(['Lib\\AsCommand', 'Doctrine\\ORM\\Mapping as ORM', 'Lib\\Unused'], "#[AsCommand(name: 'x')]\n#[ORM\\Entity]\nfinal class A {}");
    assert.deepEqual(unusedIn(content), ['Lib\\Unused']);
});

test('PHPDoc tag types use their import', () => {
    const content = file(
        ['Lib\\Suggestion', 'Lib\\Input', 'Lib\\NotFound', 'Lib\\Seen', 'Lib\\Linked', 'Lib\\Ns', 'Lib\\Constraint', 'Lib\\Unused'],
        [
            '/**',
            ' * Loads things.',
            ' *',
            ' * @param callable(Input): list<Suggestion> $values',
            ' * @return Ns\\Item|null',
            ' * @throws NotFound when missing',
            ' * @see Seen::run()',
            ' */',
            'function load(callable $values) {}',
            '/** Delegates to {@link Linked}. */',
            'function other() {}',
            'final class C {',
            '    /** @var Constraint[] */',
            '    public array $constraints = [];',
            '}'
        ].join('\n')
    );
    assert.deepEqual(unusedIn(content), ['Lib\\Unused']);
});

test('Doctrine annotation tags use their import', () => {
    const content = file(['Doctrine\\ORM\\Mapping as ORM', 'Lib\\Unused'], '/**\n * @ORM\\Entity\n */\nclass A {}');
    assert.deepEqual(unusedIn(content), ['Lib\\Unused']);
});

test('prose, plain comments and fully qualified doc types do not use an import', () => {
    const content = file(
        ['Lib\\Prose', 'Lib\\Plain', 'Lib\\Qualified'],
        ['/**', ' * Mentions Prose in passing.', ' *', ' * @return \\Other\\Qualified', ' */', 'function f() {}', '/* @var Plain */', 'function g() {}'].join('\n')
    );
    assert.deepEqual(unusedIn(content), ['Lib\\Prose', 'Lib\\Plain', 'Lib\\Qualified']);
});
