import assert from 'node:assert/strict';
import {before, test} from 'node:test';
import {CppAdapter, initCpp} from '../src/analysis/CppAdapter.js';
import {DartAdapter, initDart} from '../src/analysis/DartAdapter.js';
import type {LanguageAdapter} from '../src/analysis/LanguageAdapter.js';
import {PhpAdapter} from '../src/analysis/PhpAdapter.js';
import {TypeScriptAdapter} from '../src/analysis/TypeScriptAdapter.js';

// An `else if` continues its if-chain: one flat cognitive increment and no
// extra nesting level (SonarSource cognitive complexity). Only an `if` inside
// an `else { … }` block is nested. Same expectations in every language.

before(async () => {
    await initCpp();
    await initDart();
});

const ROOT = '/virtual';

/** `f`'s cyclomatic, cognitive and nesting values in `content`. */
const metricsOf = (adapter: LanguageAdapter, file: string, content: string, fn: string): number[] => {
    const facts = adapter.extractFacts(adapter.parse({path: `${ROOT}/${file}`, content}), {rootDir: ROOT});
    return ['metric.cyclomaticComplexity', 'metric.cognitiveComplexity', 'metric.nestingDepth'].map((kind) => {
        const fact = facts.find((entry) => entry.kind === kind && entry.subject.symbol === fn);
        assert.ok(fact !== undefined, `${file}: no ${kind} for ${fn}`);
        return fact.value as number;
    });
};

// if a +1, if b +2, else-if c +1, if d +2, else-if e +1, if g +2 = 9; nesting 2.
const CHAIN = 'if (a) { if (b) { x(); } } else if (c) { if (d) { x(); } } else if (e) { if (g) { x(); } } else { x(); }';
// if a +1, the if in the else block +2, if c +3 = 6; nesting 3.
const NESTED = 'if (a) { x(); } else { if (b) { if (c) { x(); } } }';

const php = (body: string): string => body.replace(/\(([a-g])\)/g, '($$$1)');

const LANGUAGES: {name: string; adapter: () => LanguageAdapter; file: string; wrap: (name: string, body: string) => string}[] = [
    {name: 'TypeScript', adapter: () => new TypeScriptAdapter(), file: 'm.ts', wrap: (name, body) => `export function ${name}(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, g: boolean): void { ${body} }\nfunction x(): void {}\n`},
    {name: 'PHP', adapter: () => new PhpAdapter(), file: 'm.php', wrap: (name, body) => `<?php\nfunction ${name}($a, $b, $c, $d, $e, $g) { ${php(body)} }\n`},
    {name: 'C', adapter: () => new CppAdapter(), file: 'm.c', wrap: (name, body) => `void ${name}(int a, int b, int c, int d, int e, int g) { ${body} }\n`},
    {name: 'C++', adapter: () => new CppAdapter(), file: 'm.cpp', wrap: (name, body) => `void ${name}(bool a, bool b, bool c, bool d, bool e, bool g) { ${body} }\n`},
    {name: 'Dart', adapter: () => new DartAdapter(), file: 'm.dart', wrap: (name, body) => `void ${name}(bool a, bool b, bool c, bool d, bool e, bool g) { ${body} }\n`}
];

for (const language of LANGUAGES) {
    test(`${language.name}: an else-if chain adds one flat increment per branch and no nesting level`, () => {
        assert.deepEqual(metricsOf(language.adapter(), language.file, language.wrap('chain', CHAIN), 'chain'), [7, 9, 2]);
    });

    test(`${language.name}: an if inside an else block is nested`, () => {
        assert.deepEqual(metricsOf(language.adapter(), language.file, language.wrap('nested', NESTED), 'nested'), [4, 6, 3]);
    });
}

test('PHP: the elseif keyword is an else-if like `else if`', () => {
    const content = '<?php\nfunction f($a, $c, $d, $e) { if ($a) { x(); } elseif ($c) { if ($d) { x(); } } elseif ($e) { x(); } else { x(); } }\n';
    assert.deepEqual(metricsOf(new PhpAdapter(), 'k.php', content, 'f'), [5, 5, 2]);
});
