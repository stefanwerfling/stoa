import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initCpp} from '../src/analysis/CppAdapter.js';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {declarationSymbols, uniqueSymbols} from '../src/FindingIdentity.js';
import {analyze} from '../src/Pipeline.js';

// Function identities of the language adapters: a function's symbol is its
// name qualified by the enclosing named scopes, so two classes' `run` in one
// file are two identities (they used to share the bare `run` — the evaluator
// then failed and `--update-baseline` refused). Under identity scheme 2 a
// shared name is told apart by what it is first (an accessor's kind, a C++
// overload's parameter types), remaining duplicates get `#n`.
// A function without a name takes its binding's name, or is
// `<scope>.(anonymous)#n`, numbered within its scope — never its line.

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

test('declarationSymbols: anonymous bases are always numbered per base, names stay unless duplicated', () => {
    assert.deepEqual(
        declarationSymbols([
            {base: 'outer', anonymous: false},
            {base: 'outer.(anonymous)', anonymous: true},
            {base: '(anonymous)', anonymous: true},
            {base: 'outer.(anonymous)', anonymous: true}
        ]),
        ['outer', 'outer.(anonymous)#0', '(anonymous)#0', 'outer.(anonymous)#1']
    );
});

test('TypeScript: methods by class, nested functions by their function, object-literal methods by their variable; accessor pairs by kind, callbacks are numbered in their scope', () => {
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
    assert.deepEqual(symbolsOf('a.ts', source), ['A.constructor', 'A.run', 'A.size:get', 'A.size:set', 'B.run', 'outer', 'outer.inner', 'api.run', 'pair.(anonymous)#0', 'pair.(anonymous)#1']);
});

test('TypeScript: a function bound to a variable, property or class field takes that name; a callback is <scope>.(anonymous)#n', () => {
    const source = [
        'export const handler = (): void => {',
        '    [1].forEach(() => undefined);',
        '};',
        'export const routes = {onClick: (): void => undefined};',
        'export class C {',
        '    run = (): void => undefined;',
        '    go(): void {',
        '        setTimeout(() => undefined);',
        '        setTimeout(function () {});',
        '    }',
        '}',
        'setTimeout(() => undefined);',
        ''
    ].join('\n');
    assert.deepEqual(symbolsOf('b.ts', source), ['handler', 'handler.(anonymous)#0', 'routes.onClick', 'C.run', 'C.go', 'C.go.(anonymous)#0', 'C.go.(anonymous)#1', '(anonymous)#0']);
});

test('stable: lines inserted above, or a callback added in another scope, change no symbol', () => {
    const body = ['export function a(): void {', '    [1].map(() => 1);', '}', 'export function b(): void {', '    [1].map(() => 2);', '}', ''];
    const before = symbolsOf('c.ts', body.join('\n'));
    const shifted = symbolsOf('c.ts', ['// a comment', '', ...body].join('\n'));
    const added = symbolsOf('c.ts', body.join('\n').replace('    [1].map(() => 1);', '    [1].map(() => 1);\n    [1].map(() => 3);'));
    assert.deepEqual(before, ['a', 'a.(anonymous)#0', 'b', 'b.(anonymous)#0']);
    assert.deepEqual(shifted, before);
    assert.deepEqual(added, ['a', 'a.(anonymous)#0', 'a.(anonymous)#1', 'b', 'b.(anonymous)#0']);
});

test('Dart: methods by class, mixin and extension; a local function by its function', () => {
    const source = ['class A { void run() {} }', 'mixin M { void run() {} }', 'extension E on String { void run() {} }', 'void outer() { void inner() {} }', ''].join('\n');
    assert.deepEqual(symbolsOf('a.dart', source), ['A.run', 'M.run', 'E.run', 'outer', 'outer.inner']);
});

test('Dart (identity spec, phase 4): accessors as X.v:get / X.v:set when both exist; a closure takes its variable or field, or is <scope>.(anonymous)#n', () => {
    const source = [
        'class A {',
        '  int _v = 0;',
        '  int get v => _v;',
        '  set v(int x) { if (x > 0) { _v = x; } }',
        '  static set s(int y) => print(y);',
        '  final cb = () => 3;',
        '  void m() {',
        '    final f = (int a) { final g = () => 2; return a; };',
        '    list.forEach((e) { print(e); });',
        '    int local(int q) { return q; }',
        '    run(() => 1);',
        '  }',
        '}',
        'set top(int z) {}',
        'int get topGet => 1;',
        'final h = (x) => x;',
        ''
    ].join('\n');
    assert.deepEqual(symbolsOf('d.dart', source), [
        'A.v:get',
        'A.v:set',
        'A.s',
        'A.cb',
        'A.m',
        'A.m.f',
        'A.m.f.g',
        'A.m.(anonymous)#0',
        'A.m.local',
        'A.m.(anonymous)#1',
        'top',
        'topGet',
        'h'
    ]);
});

test('Dart: a closure is measured on its own and stays out of the enclosing function, which measures as before', () => {
    const dir = mkdtempSync(join(work, 'case-'));
    writeFileSync(join(dir, 'm.dart'), ['void m(bool a) {', '  if (a) { print(1); }', '  run((x) { if (x) { if (x > 1) { print(x); } } });', '}', ''].join('\n'));
    const {facts} = analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    const metric = (symbol: string, kind: string): unknown => facts.find((fact) => fact.subject.symbol === symbol && fact.kind === kind)?.value;
    assert.deepEqual([metric('m', 'metric.cyclomaticComplexity'), metric('m', 'metric.nestingDepth')], [2, 1], 'the closure body is not part of m');
    assert.deepEqual([metric('m.(anonymous)#0', 'metric.cyclomaticComplexity'), metric('m.(anonymous)#0', 'metric.nestingDepth'), metric('m.(anonymous)#0', 'metric.parameterCount')], [3, 2, 1]);
    assert.deepEqual([metric('m', 'ast.usesNondeterminism'), metric('m.(anonymous)#0', 'ast.usesNondeterminism')], [false, false]);
});

test('Dart: a clock or RNG call inside a closure belongs to the closure, not to the enclosing function', () => {
    const dir = mkdtempSync(join(work, 'case-'));
    const source = [
        'class W {',
        '  Widget build(BuildContext context) {',
        '    return Tap(onTap: () { pick(DateTime.now()); }, child: Text("x"));',
        '  }',
        '  void outer() { run(() { run(() => Random().nextInt(3)); }); }',
        '  int direct() => DateTime.now().day;',
        '}',
        ''
    ].join('\n');
    writeFileSync(join(dir, 'w.dart'), source);
    const nondeterministic = (scheme?: 1): Record<string, unknown> =>
        Object.fromEntries(
            analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, ...(scheme === undefined ? {} : {identityScheme: scheme})})
                .facts.filter((fact) => fact.kind === 'ast.usesNondeterminism')
                .map((fact) => [fact.subject.symbol, fact.value])
        );
    assert.deepEqual(nondeterministic(), {
        'W.build': false,
        'W.build.(anonymous)#0': true,
        'W.outer': false,
        'W.outer.(anonymous)#0': false,
        'W.outer.(anonymous)#1': true,
        'W.direct': true
    });
    // Scheme 1 measures named functions only: there a closure stays part of its function, as before.
    assert.deepEqual(nondeterministic(1), {'W.build': true, 'W.outer': true, 'W.direct': true});
});

test('Dart: no closure is read out of a region tree-sitter had to recover (a Dart 3 record and switch expression misparsed)', () => {
    const source = ['class S {', '  ({int face, int edge}) get palette => switch (state) {', '        T.a => (face: 1, edge: 2),', '        _ => (face: 3, edge: 4),', '      };', '  void ok() { run(() => 1); }', '}', ''].join('\n');
    // The misparse also loses the class scope (`ok`, not `S.ok`) — as before; only the record no longer reads as a closure.
    assert.deepEqual(symbolsOf('r.dart', source), ['ok', 'ok.(anonymous)#0']);
});

test('Dart: identity scheme 1 measures named functions only, as before accessors and closures were measured', () => {
    const dir = mkdtempSync(join(work, 'case-'));
    writeFileSync(join(dir, 's.dart'), ['class A {', '  int get v => 1;', '  void m() { run(() => 1); }', '}', ''].join('\n'));
    const {facts} = analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, identityScheme: 1});
    assert.deepEqual(facts.filter((fact) => fact.kind === 'metric.functionLength').map((fact) => fact.subject.symbol), ['A.m']);
});

test('PHP: methods by class and trait; a closure takes its variable, or is <scope>.(anonymous)#n', () => {
    const source = [
        '<?php',
        'class A { public function run() { $f = function () {}; $rows = array_map(fn ($x) => $x, []); usort($rows, function ($a, $b) { return 0; }); } }',
        'trait T { public function run() {} }',
        'function top() {}',
        ''
    ].join('\n');
    assert.deepEqual(symbolsOf('a.php', source), ['A.run', 'A.run.f', 'A.run.rows.(anonymous)#0', 'A.run.(anonymous)#0', 'T.run', 'top']);
});

test('C++: in-class definitions by class like out-of-class ones; overloads by their parameter types', () => {
    const source = ['struct A { void run() {} };', 'class B { public: void run() {} };', 'void C::run() {}', 'void f(int a) {}', 'void f(double b) {}', ''].join('\n');
    assert.deepEqual(symbolsOf('a.cpp', source), ['A::run', 'B::run', 'C::run', 'f(int)', 'f(double)']);
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
