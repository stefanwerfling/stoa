import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initCpp} from '../src/analysis/CppAdapter.js';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {uniqueSymbols} from '../src/FindingIdentity.js';
import {analyze} from '../src/Pipeline.js';

// Function identities of the language adapters: a function's symbol is its
// name qualified by the enclosing named scopes, so two classes' `run` in one
// file are two identities (they used to share the bare `run` — the evaluator
// then failed and `--update-baseline` refused). Remaining duplicates get `#n`.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

let work: string;

before(async () => {
    await initDart();
    await initCpp();
    work = mkdtempSync(join(tmpdir(), 'stoa-function-identity-'));
});

after(() => {
    rmSync(work, {recursive: true, force: true});
});

/** The function symbols (one per function, source order) the adapter emits for `content`. */
const symbolsOf = (name: string, content: string): string[] => {
    const dir = mkdtempSync(join(work, 'case-'));
    writeFileSync(join(dir, name), content);
    const {facts} = analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    return facts
        .filter((fact) => fact.kind === 'metric.functionLength' && basename(fact.subject.file) === name)
        .sort((a, b) => a.subject.range.startLine - b.subject.range.startLine || a.subject.range.startCol - b.subject.range.startCol)
        .map((fact) => fact.subject.symbol ?? '');
};

test('uniqueSymbols: a unique base stays, every occurrence of a shared base gets #n in order', () => {
    assert.deepEqual(uniqueSymbols(['A.run', 'B.run', 'x', 'x', 'A.run']), ['A.run#0', 'B.run', 'x#0', 'x#1', 'A.run#1']);
    assert.deepEqual(uniqueSymbols([]), []);
});

test('TypeScript: methods by class, nested functions by their function, object-literal methods by their variable; accessor pairs and same-line closures get #n', () => {
    const source = [
        'export class A {',
        '    constructor() {}',
        '    run(): void {}',
        '    get size(): number { return 1; }',
        '    set size(value: number) {}',
        '}',
        'export class B {',
        '    run(): void {}',
        '}',
        'export function outer(): void {',
        '    function inner(): void {}',
        '}',
        'export const api = {',
        '    run(): void {}',
        '};',
        'export const pair = [1].map(() => 1).map(() => 2);',
        ''
    ].join('\n');
    assert.deepEqual(symbolsOf('a.ts', source), ['A.constructor', 'A.run', 'A.size#0', 'A.size#1', 'B.run', 'outer', 'outer.inner', 'api.run', 'anonymous@16#0', 'anonymous@16#1']);
});

test('Dart: methods by class, mixin and extension; a local function by its function', () => {
    const source = ['class A { void run() {} }', 'mixin M { void run() {} }', 'extension E on String { void run() {} }', 'void outer() { void inner() {} }', ''].join('\n');
    assert.deepEqual(symbolsOf('a.dart', source), ['A.run', 'M.run', 'E.run', 'outer', 'outer.inner']);
});

test('PHP: methods by class and trait; closures keep anonymous@line', () => {
    const source = ['<?php', 'class A { public function run() { $f = function () {}; } }', 'trait T { public function run() {} }', 'function top() {}', ''].join('\n');
    assert.deepEqual(symbolsOf('a.php', source), ['A.run', 'anonymous@2', 'T.run', 'top']);
});

test('C++: in-class definitions by class like out-of-class ones; overloads get #n', () => {
    const source = ['struct A { void run() {} };', 'class B { public: void run() {} };', 'void C::run() {}', 'void f(int a) {}', 'void f(double b) {}', ''].join('\n');
    assert.deepEqual(symbolsOf('a.cpp', source), ['A::run', 'B::run', 'C::run', 'f#0', 'f#1']);
});

test('two classes with the same method in one file: two identities on the finding, too', () => {
    const sixParams = 'a: number, b: number, c: number, d: number, e: number, f: number';
    const dir = mkdtempSync(join(work, 'findings-'));
    writeFileSync(join(dir, 'a.ts'), `export class A {\n    run(${sixParams}): number {\n        return a;\n    }\n}\nexport class B {\n    run(${sixParams}): number {\n        return a;\n    }\n}\n`);
    const findings = analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings.filter((finding) => finding.rule.id === 'R-FN-TOO-MANY-PARAMS');
    assert.deepEqual(
        findings.map((finding) => finding.location.symbol),
        ['A.run', 'B.run']
    );
});

test('R-ORM-EAGER-RELATION: two entities with the same eager property in one file are two identities (Entity.property), TS and PHP', () => {
    const dir = mkdtempSync(join(work, 'orm-'));
    const entity = (name: string): string => `@Entity()\nexport class ${name} {\n    @PrimaryGeneratedColumn()\n    id: number;\n\n    @ManyToOne(() => Customer, {eager: true})\n    customer: Customer;\n}\n`;
    writeFileSync(join(dir, 'a.ts'), `${entity('Order')}\n${entity('Invoice')}`);
    const doctrine = (name: string): string =>
        `#[ORM\\Entity]\nclass ${name}\n{\n    #[ORM\\Id]\n    #[ORM\\Column]\n    private int $id;\n\n    #[ORM\\ManyToOne(targetEntity: Customer::class, fetch: 'EAGER')]\n    private Customer $customer;\n}\n`;
    writeFileSync(join(dir, 'b.php'), `<?php\n${doctrine('Order')}\n${doctrine('Invoice')}`);
    const symbols = analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG})
        .report.findings.filter((finding) => finding.rule.id === 'R-ORM-EAGER-RELATION')
        .map((finding) => `${basename(finding.location.file)} ${finding.location.symbol ?? ''}`);
    assert.deepEqual(symbols, ['a.ts Order.customer', 'a.ts Invoice.customer', 'b.php Order.customer', 'b.php Invoice.customer']);
});
