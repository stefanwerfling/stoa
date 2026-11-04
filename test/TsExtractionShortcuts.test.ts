import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TypeScriptAdapter} from '../src/analysis/TypeScriptAdapter.js';
import type {Fact} from '../src/Types.js';

// The TS extraction answers export questions syntactically where the type
// checker cannot change the answer, and walks the compiler tree instead of
// wrapping every token. These cases pin the results that used the slow paths
// before (expected values taken from the extraction before the shortcuts):
// exports without the keyword, `export =`, a named default, and a property
// access that only exists inside JSDoc.

const adapter = new TypeScriptAdapter();

const factsOf = (name: string, content: string): Fact[] => adapter.extractFacts(adapter.parse({path: `/virtual/${name}`, content}), {rootDir: '/virtual'});

const exportsOf = (facts: Fact[]): {count: unknown; names: string[]} => ({
    count: facts.find((fact) => fact.kind === 'metric.exportCount')?.value,
    names: facts.filter((fact) => fact.kind === 'deps.export').map((fact) => fact.subject.symbol ?? '')
});

test('exports without the keyword: local export list, aliases, re-exports', () => {
    const source = [
        'function local(): void {}',
        'class Hidden {}',
        'interface Shape { x: number }',
        'type Alias = string;',
        'enum Color { Red }',
        'const v = 1, w = 2;',
        'export function kw(): void {}',
        'export default class Main {}',
        'export {local, Hidden as Visible, Shape, Alias, Color, v};',
        'export {kw as again};',
        "export * from './b';",
        "export {thing} from './b';",
        ''
    ].join('\n');
    assert.deepEqual(exportsOf(factsOf('a.ts', source)), {
        count: 15,
        names: ['local', 'kw', 'Hidden', 'default', 'Shape', 'Alias', 'Color', 'local', 'Visible', 'Shape', 'Alias', 'Color', 'v', 'again', 'thing']
    });
});

test('a named default, `export =` and `export default <expr>`', () => {
    assert.deepEqual(exportsOf(factsOf('b.ts', 'function inner(): void {}\nexport {inner as default};\nexport const thing = 1;\n')), {count: 3, names: ['default', 'thing', 'default']});
    assert.deepEqual(exportsOf(factsOf('c.ts', 'function make(): void {}\nexport = make;\n')), {count: 2, names: ['make']});
    assert.deepEqual(exportsOf(factsOf('d.ts', 'const value = 2;\nfunction f(): void {}\nexport default value;\n')), {count: 1, names: ['default']});
});

test('member references: a property access inside JSDoc still counts as static access', () => {
    const source = [
        "import {Base} from './base';",
        'export class K {',
        '    run(): void {',
        '        /** @augments Base.Inner */',
        '        const C = class {};',
        '        void C;',
        '        void Base;',
        '        const x = new Map();',
        '        x.set(1, 2);',
        '    }',
        '}',
        ''
    ].join('\n');
    const decl = factsOf('f.ts', source).find((fact) => fact.kind === 'struct.typeDecl' && fact.subject.symbol === 'K');
    assert.ok(decl);
    const [run] = (decl.value as {members: Array<Record<string, unknown>>}).members;
    assert.deepEqual(run?.refsImports, ['Base']);
    assert.deepEqual(run?.staticAccess, [{prefix: null, name: 'Base', member: 'Inner'}]);
    assert.deepEqual(run?.instantiates, [{prefix: null, name: 'Map', member: null}]);
});

test('one walk per function: metrics and nondeterminism skip nested functions; an expression body counts itself', () => {
    const source = [
        'export function outer(a: boolean, b: boolean): number {',
        '    const t = Date.now();',
        '    const later = () => Math.random() > 0.5 && a;',
        '    if (a && b) {',
        '        for (const x of [1, 2]) {',
        '            while (x > t) {',
        '                return b ? 1 : 2;',
        '            }',
        '        }',
        '    }',
        '    return later() ? 0 : 1;',
        '}',
        'export function stamps(): Date[] {',
        '    return [new Date(), new Date(0)];',
        '}',
        'export function fixed(): Date {',
        '    return new Date(0) ?? null;',
        '}',
        'export const clock = {',
        '    now(): number {',
        '        return performance.now();',
        '    }',
        '};',
        'export function onlyNested(): () => number {',
        '    return () => Math.random();',
        '}',
        'export const ternary = (a: boolean): number => (a ? 1 : 2);',
        ''
    ].join('\n');
    const kinds = ['metric.cyclomaticComplexity', 'metric.cognitiveComplexity', 'metric.nestingDepth', 'ast.usesNondeterminism'];
    const bySymbol: Record<string, unknown[]> = {};
    for (const fact of factsOf('m.ts', source)) {
        if (kinds.includes(fact.kind)) {
            (bySymbol[fact.subject.symbol ?? ''] ??= []).push(fact.value);
        }
    }
    assert.deepEqual(bySymbol, {
        outer: [7, 12, 4, true],
        'outer.later': [2, 1, 0, true],
        stamps: [1, 0, 0, true],
        fixed: [2, 1, 0, false],
        'clock.now': [1, 0, 0, true],
        onlyNested: [1, 0, 0, false],
        // The expression body itself is inspected: `() => Math.random()` is
        // flagged, and the `&&` of `later` counts (it did not before).
        'onlyNested.(anonymous)#0': [1, 0, 0, true],
        ternary: [2, 1, 1, false]
    });
});
